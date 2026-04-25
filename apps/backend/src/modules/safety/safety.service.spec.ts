/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/require-await */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { SafetyService } from './safety.service.js';
import { UserContact } from '../../entities/user-contact.entity.js';
import { User } from '../../entities/user.entity.js';
import { CrashAlert } from '../../entities/crash-alert.entity.js';
import { EventsGateway } from '../events/events.gateway.js';
import {
  CRASH_ALERT_NOTIFIER,
  type CrashAlertNotifier,
} from './crash-alert-notifier.interface.js';

describe('SafetyService', () => {
  let service: SafetyService;
  let contactRepo: Partial<jest.Mocked<Repository<UserContact>>>;
  let userRepo: Partial<jest.Mocked<Repository<User>>>;
  let alertRepo: Partial<jest.Mocked<Repository<CrashAlert>>>;
  let eventsGateway: { emitToUser: jest.Mock };
  let notifier: jest.Mocked<CrashAlertNotifier>;
  let alertStore: Map<string, CrashAlert>;

  const mockUser = {
    id: 'user-1',
    display_name: 'TestRider',
    preferences: { locale: 'cs-CZ' },
  } as unknown as User;

  const mockContacts = [
    { id: 'c-1', name: 'Jane', phone: '+420111', is_emergency: true },
    { id: 'c-2', name: 'Bob', phone: '+420222', is_emergency: true },
  ] as UserContact[];

  beforeEach(async () => {
    alertStore = new Map();

    contactRepo = {
      find: jest.fn().mockResolvedValue(mockContacts),
    };
    userRepo = {
      findOne: jest.fn().mockResolvedValue(mockUser),
    };
    alertRepo = {
      create: jest.fn((data: Partial<CrashAlert>) => data as CrashAlert),
      insert: jest.fn(async (entity: CrashAlert) => {
        if (alertStore.has(entity.id)) {
          const err = new QueryFailedError('insert', [], new Error('dup'));
          (
            err as QueryFailedError & { driverError: { code: string } }
          ).driverError = { code: '23505' };
          throw err;
        }
        alertStore.set(entity.id, { ...entity });
        return { identifiers: [{ id: entity.id }], generatedMaps: [], raw: [] };
      }),
      update: jest.fn(
        async (criteria: { id: string }, patch: Partial<CrashAlert>) => {
          const existing = alertStore.get(criteria.id);
          if (existing) {
            alertStore.set(criteria.id, { ...existing, ...patch });
          }
          return { affected: 1, raw: [], generatedMaps: [] };
        },
      ),
      findOne: jest.fn(async (opts: { where: { id: string } }) => {
        return alertStore.get(opts.where.id) ?? null;
      }),
    };
    eventsGateway = {
      emitToUser: jest.fn(),
    };
    notifier = {
      name: 'mock',
      isConfigured: jest.fn().mockReturnValue(true),
      send: jest.fn().mockResolvedValue({
        channel: 'sms',
        provider_message_id: 'SM-mock',
      }),
    } as unknown as jest.Mocked<CrashAlertNotifier>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SafetyService,
        { provide: getRepositoryToken(UserContact), useValue: contactRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(CrashAlert), useValue: alertRepo },
        { provide: EventsGateway, useValue: eventsGateway },
        { provide: CRASH_ALERT_NOTIFIER, useValue: notifier },
      ],
    }).compile();

    service = module.get<SafetyService>(SafetyService);
  });

  describe('sendCrashAlert', () => {
    it('dispatches SMS to every emergency contact and returns per-contact status', async () => {
      const result = await service.sendCrashAlert('user-1', {
        lat: 49.1,
        lng: 16.75,
      });

      expect(notifier.send).toHaveBeenCalledTimes(2);
      expect(notifier.send).toHaveBeenCalledWith(
        'sms',
        expect.objectContaining({ contact_id: 'c-1', phone: '+420111' }),
        expect.objectContaining({
          alert_id: result.alert_id,
          rider_name: 'TestRider',
          maps_link: 'https://maps.google.com/?q=49.1,16.75',
          severity: 'medium',
        }),
      );
      expect(result.contacts_notified).toBe(2);
      expect(result.contacts).toHaveLength(2);
      expect(result.contacts[0]).toMatchObject({
        contact_id: 'c-1',
        channel: 'sms',
        status: 'sent',
        provider_message_id: 'SM-mock',
      });
      expect(result.idempotent_replay).toBe(false);
    });

    it('also sends a voice call when severity=high', async () => {
      notifier.send.mockImplementation(async (channel) => ({
        channel,
        provider_message_id: `id-${channel}`,
      }));

      const result = await service.sendCrashAlert('user-1', {
        lat: 49.1,
        lng: 16.75,
        severity: 'high',
      });

      // 2 contacts × (sms + voice) = 4 sends
      expect(notifier.send).toHaveBeenCalledTimes(4);
      const channels = notifier.send.mock.calls.map((c) => c[0]).sort();
      expect(channels).toEqual(['sms', 'sms', 'voice', 'voice']);
      expect(result.contacts).toHaveLength(4);
    });

    it('records failures per contact without aborting the request', async () => {
      notifier.send
        .mockResolvedValueOnce({ channel: 'sms', provider_message_id: 'ok' })
        .mockRejectedValueOnce(new Error('Twilio 429: rate limited'));

      const result = await service.sendCrashAlert('user-1', {
        lat: 49.1,
        lng: 16.75,
      });

      expect(result.contacts_notified).toBe(1);
      expect(result.contacts.find((c) => c.contact_id === 'c-2')).toMatchObject(
        {
          status: 'failed',
          error: 'Twilio 429: rate limited',
        },
      );
    });

    it('renders the message in the user locale from preferences', async () => {
      await service.sendCrashAlert('user-1', { lat: 49.1, lng: 16.75 });

      const ctx = notifier.send.mock.calls[0][2];
      // cs locale templates start with "Tarmoto nouzový alert"
      expect(ctx.message).toMatch(/^Tarmoto nouzový alert/);
    });

    it('falls back to English when locale is missing or unsupported', async () => {
      userRepo.findOne!.mockResolvedValueOnce({
        ...mockUser,
        preferences: { locale: 'xx-YY' },
      } as User);

      await service.sendCrashAlert('user-1', { lat: 49.1, lng: 16.75 });

      const ctx = notifier.send.mock.calls[0][2];
      expect(ctx.message).toMatch(/^Tarmoto crash alert/);
    });

    it('honors explicit dto.locale override', async () => {
      await service.sendCrashAlert('user-1', {
        lat: 49.1,
        lng: 16.75,
        locale: 'de',
      });

      const ctx = notifier.send.mock.calls[0][2];
      expect(ctx.message).toMatch(/^Tarmoto Unfallalarm/);
    });

    it('emits a websocket event to the rider', async () => {
      await service.sendCrashAlert('user-1', {
        lat: 49.1,
        lng: 16.75,
      });

      expect(eventsGateway.emitToUser).toHaveBeenCalledWith(
        'user-1',
        'crash:alert-sent',
        expect.objectContaining({
          contacts_notified: 2,
          contacts_total: 2,
          severity: 'medium',
        }),
      );
    });

    it('returns 0 contacts and skips notifier when user has none', async () => {
      contactRepo.find!.mockResolvedValueOnce([]);

      const result = await service.sendCrashAlert('user-1', {
        lat: 49.1,
        lng: 16.75,
      });

      expect(result.contacts_notified).toBe(0);
      expect(notifier.send).not.toHaveBeenCalled();
    });

    it('returns 0 contacts and never inserts an alert when user not found', async () => {
      userRepo.findOne!.mockResolvedValueOnce(null);

      const result = await service.sendCrashAlert('missing', {
        lat: 49.1,
        lng: 16.75,
      });

      expect(result.contacts_notified).toBe(0);
      expect(alertRepo.insert).not.toHaveBeenCalled();
    });

    it('persists the audit row with the per-contact outcome', async () => {
      const result = await service.sendCrashAlert('user-1', {
        lat: 49.1,
        lng: 16.75,
        ride_id: '11111111-2222-3333-4444-555555555555',
        speed_at_impact: 88,
      });

      const stored = alertStore.get(result.alert_id);
      expect(stored).toBeDefined();
      expect(stored!.user_id).toBe('user-1');
      expect(stored!.ride_id).toBe('11111111-2222-3333-4444-555555555555');
      expect(stored!.speed_at_impact).toBe(88);
      expect(stored!.contacts_total).toBe(2);
      expect(stored!.contacts_notified).toBe(2);
      expect(stored!.contact_results).toHaveLength(2);
    });

    it('replays an existing dispatch when alert_id is reused (idempotency)', async () => {
      const sharedId = '00000000-0000-4000-8000-000000000001';

      const first = await service.sendCrashAlert('user-1', {
        lat: 49.1,
        lng: 16.75,
        alert_id: sharedId,
      });
      expect(first.idempotent_replay).toBe(false);
      expect(notifier.send).toHaveBeenCalledTimes(2);

      notifier.send.mockClear();

      const second = await service.sendCrashAlert('user-1', {
        lat: 49.1,
        lng: 16.75,
        alert_id: sharedId,
      });

      expect(second.idempotent_replay).toBe(true);
      expect(second.alert_id).toBe(sharedId);
      expect(second.contacts_notified).toBe(first.contacts_notified);
      expect(notifier.send).not.toHaveBeenCalled();
    });

    it('falls back to log channel when notifier is unconfigured (env unset)', async () => {
      // Simulate the production-with-no-creds path: the Twilio provider
      // would log instead of calling the API and report channel='log'.
      notifier.isConfigured.mockReturnValue(false);
      notifier.send.mockResolvedValue({
        channel: 'sms',
        provider_message_id: null,
      });

      const result = await service.sendCrashAlert('user-1', {
        lat: 49.1,
        lng: 16.75,
      });

      expect(result.contacts_notified).toBe(2);
      result.contacts.forEach((c) => {
        expect(c.channel).toBe('log');
        expect(c.provider_message_id).toBeNull();
        expect(c.status).toBe('sent');
      });
    });

    it('generates unique alert IDs when none provided', async () => {
      const r1 = await service.sendCrashAlert('user-1', {
        lat: 49.1,
        lng: 16.75,
      });
      const r2 = await service.sendCrashAlert('user-1', {
        lat: 49.1,
        lng: 16.75,
      });

      expect(r1.alert_id).not.toBe(r2.alert_id);
    });
  });
});
