/* eslint-disable @typescript-eslint/require-await */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { SafetyService } from './safety.service.js';
import { UserContact } from '../../entities/user-contact.entity.js';
import { User } from '../../entities/user.entity.js';
import { CrashAlert } from '../../entities/crash-alert.entity.js';
import { EventsGateway } from '../events/events.gateway.js';
import { PushService } from '../push/index.js';
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
        // The service no longer sets created_at explicitly — the DB
        // default fills it. Honor an explicit value if a test seeded
        // one, else stamp now().
        const created_at = entity.created_at ?? new Date();
        const claimed_at = entity.claimed_at ?? created_at;
        alertStore.set(entity.id, {
          ...entity,
          created_at,
          claimed_at,
          claim_version: entity.claim_version ?? 0,
        });
        return { identifiers: [{ id: entity.id }], generatedMaps: [], raw: [] };
      }),
      update: jest.fn(
        async (
          criteria: {
            id: string;
            user_id?: string;
            claim_version?: number;
            dispatch_completed_at?: unknown;
          },
          patch: Partial<CrashAlert>,
        ) => {
          const existing = alertStore.get(criteria.id);
          if (!existing) return { affected: 0, raw: [], generatedMaps: [] };
          if (criteria.user_id && existing.user_id !== criteria.user_id) {
            return { affected: 0, raw: [], generatedMaps: [] };
          }
          // Optimistic-lock on claim_version: caller passes the exact
          // value it expects to find. Mismatch means another writer
          // already reclaimed (and bumped) the row.
          if (
            criteria.claim_version !== undefined &&
            existing.claim_version !== criteria.claim_version
          ) {
            return { affected: 0, raw: [], generatedMaps: [] };
          }
          // IsNull() check — only match still-incomplete rows.
          if (
            criteria.dispatch_completed_at !== undefined &&
            existing.dispatch_completed_at !== null
          ) {
            return { affected: 0, raw: [], generatedMaps: [] };
          }
          alertStore.set(criteria.id, { ...existing, ...patch });
          return { affected: 1, raw: [], generatedMaps: [] };
        },
      ),
      findOne: jest.fn(
        async (opts: { where: { id: string; user_id?: string } }) => {
          const row = alertStore.get(opts.where.id);
          if (!row) return null;
          if (opts.where.user_id && row.user_id !== opts.where.user_id) {
            return null;
          }
          return row;
        },
      ),
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
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SafetyService,
        { provide: getRepositoryToken(UserContact), useValue: contactRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(CrashAlert), useValue: alertRepo },
        { provide: EventsGateway, useValue: eventsGateway },
        { provide: CRASH_ALERT_NOTIFIER, useValue: notifier },
        {
          provide: PushService,
          useValue: { sendToUser: jest.fn().mockResolvedValue(undefined) },
        },
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
      });

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
      expect(first.dispatch_in_progress).toBe(false);
      expect(notifier.send).toHaveBeenCalledTimes(2);

      notifier.send.mockClear();

      const second = await service.sendCrashAlert('user-1', {
        lat: 49.1,
        lng: 16.75,
        alert_id: sharedId,
      });

      expect(second.idempotent_replay).toBe(true);
      expect(second.dispatch_in_progress).toBe(false);
      expect(second.alert_id).toBe(sharedId);
      expect(second.contacts_notified).toBe(first.contacts_notified);
      expect(notifier.send).not.toHaveBeenCalled();
    });

    it('rejects cross-user replay with 409 instead of leaking another user audit row', async () => {
      const sharedId = '00000000-0000-4000-8000-000000000999';

      // user-1 dispatches the alert and the audit row is keyed off the
      // shared UUID.
      await service.sendCrashAlert('user-1', {
        lat: 49.1,
        lng: 16.75,
        alert_id: sharedId,
      });

      // user-2 reuses the same alert_id. This collides on the PK, but
      // tenant scoping means the replay lookup misses and we refuse
      // with a Conflict instead of returning user-1's contacts.
      userRepo.findOne!.mockResolvedValueOnce({
        id: 'user-2',
        display_name: 'OtherRider',
        preferences: {},
      } as unknown as User);

      await expect(
        service.sendCrashAlert('user-2', {
          lat: 49.1,
          lng: 16.75,
          alert_id: sharedId,
        }),
      ).rejects.toMatchObject({ status: 409 });

      // Original user-1 row is untouched.
      const stored = alertStore.get(sharedId);
      expect(stored?.user_id).toBe('user-1');
    });

    it('returns dispatch_in_progress=true when the original request is still mid-flight', async () => {
      const sharedId = '00000000-0000-4000-8000-000000000abc';

      // Hold the first dispatch open so the placeholder row stays
      // un-completed while the retry comes in.
      let releaseSend!: () => void;
      const sendBlocker = new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
      notifier.send.mockImplementation(async () => {
        await sendBlocker;
        return { channel: 'sms', provider_message_id: 'SM-late' };
      });

      const first = service.sendCrashAlert('user-1', {
        lat: 49.1,
        lng: 16.75,
        alert_id: sharedId,
      });

      // Spin until the placeholder row is committed by the first call.
      while (!alertStore.has(sharedId)) {
        await new Promise((r) => setImmediate(r));
      }

      const second = await service.sendCrashAlert('user-1', {
        lat: 49.1,
        lng: 16.75,
        alert_id: sharedId,
      });

      expect(second.idempotent_replay).toBe(true);
      expect(second.dispatch_in_progress).toBe(true);
      expect(second.contacts).toHaveLength(0);

      releaseSend();
      const firstResolved = await first;
      expect(firstResolved.idempotent_replay).toBe(false);
      expect(firstResolved.dispatch_in_progress).toBe(false);
      // Once the first dispatch finishes the row is completed.
      expect(alertStore.get(sharedId)?.dispatch_completed_at).toBeInstanceOf(
        Date,
      );
    });

    it('persists a normalized short locale even when input is a long BCP-47 tag', async () => {
      // 18 chars — would overflow VARCHAR(16) without normalization.
      const result = await service.sendCrashAlert('user-1', {
        lat: 49.1,
        lng: 16.75,
        locale: 'ar-SA-u-ca-islamic',
      });

      const stored = alertStore.get(result.alert_id);
      // Normalized to the language subtag (≤ 5 chars). Falls back to
      // 'en' since 'ar' is not in the supported list.
      expect(stored?.locale?.length).toBeLessThanOrEqual(16);
      expect(stored?.locale).toBe('en');
    });

    it('records skipped (not sent) and 0 notified when notifier is unconfigured', async () => {
      // Simulate the production-with-no-creds path: the Twilio provider
      // logs instead of calling the API. The response must NOT claim the
      // contacts were notified — no SMS / voice call ever leaves the
      // system, so `contacts_notified` is 0 and per-contact `status`
      // is `skipped`. This keeps a misconfigured deployment honest in
      // a safety-critical flow.
      notifier.isConfigured.mockReturnValue(false);
      notifier.send.mockResolvedValue({
        channel: 'sms',
        provider_message_id: null,
      });

      const result = await service.sendCrashAlert('user-1', {
        lat: 49.1,
        lng: 16.75,
      });

      expect(result.contacts_notified).toBe(0);
      result.contacts.forEach((c) => {
        expect(c.channel).toBe('log');
        expect(c.provider_message_id).toBeNull();
        expect(c.status).toBe('skipped');
        expect(c.error).toContain('notifier not configured');
      });
    });

    it('reclaims a stale placeholder and re-dispatches when the original row never completed', async () => {
      const sharedId = '00000000-0000-4000-8000-0000000000ff';

      // First call inserts the placeholder, then we mutate the stored
      // row to look like the original process died right after the
      // insert: dispatch_completed_at stays null and created_at is
      // pushed back beyond STALE_DISPATCH_MS (5 min).
      notifier.send.mockRejectedValueOnce(new Error('process killed'));
      notifier.send.mockRejectedValueOnce(new Error('process killed'));
      await service.sendCrashAlert('user-1', {
        lat: 49.1,
        lng: 16.75,
        alert_id: sharedId,
      });

      const stored = alertStore.get(sharedId)!;
      // Simulate a process crash: erase completion + age the claim
      // (the staleness check measures from `claimed_at`, not the
      // immutable `created_at`).
      alertStore.set(sharedId, {
        ...stored,
        dispatch_completed_at: null,
        contacts_notified: 0,
        contact_results: [],
        claimed_at: new Date(Date.now() - 10 * 60 * 1000), // 10 min ago
      });

      // Retry — the stale row should be reclaimed and dispatch fresh.
      notifier.send.mockResolvedValue({
        channel: 'sms',
        provider_message_id: 'SM-recovered',
      });
      const retry = await service.sendCrashAlert('user-1', {
        lat: 49.1,
        lng: 16.75,
        alert_id: sharedId,
      });

      expect(retry.idempotent_replay).toBe(false);
      expect(retry.dispatch_in_progress).toBe(false);
      expect(retry.contacts_notified).toBe(2);

      const finalRow = alertStore.get(sharedId)!;
      expect(finalRow.dispatch_completed_at).toBeInstanceOf(Date);
      expect(finalRow.contacts_notified).toBe(2);
    });

    it('does not re-reclaim a freshly-reclaimed row even after the original incident is older than the stale window', async () => {
      // The bug: stale-detection used to measure from `created_at`,
      // which is anchored to the original incident. After a single
      // reclaim, every subsequent retry would still see "stale" and
      // reclaim AGAIN even though a healthy newer claim was actively
      // dispatching — fanning out duplicate SMS. The fix measures
      // staleness from `claimed_at`, which is refreshed on each
      // successful reclaim.
      const sharedId = '00000000-0000-4000-8000-0000000000bb';
      const now = Date.now();
      // Seed a row that's already been reclaimed once: created_at far
      // in the past (>STALE), claimed_at recently bumped, in flight.
      alertStore.set(sharedId, {
        id: sharedId,
        user_id: 'user-1',
        ride_id: null,
        lat: 0,
        lng: 0,
        speed_at_impact: null,
        severity: 'medium',
        locale: 'en',
        contacts_notified: 0,
        contacts_total: 2,
        contact_results: [],
        dispatch_completed_at: null,
        claim_version: 1, // already reclaimed once
        claimed_at: new Date(now - 30 * 1000), // 30 s ago — well within the 5-min window
        created_at: new Date(now - 10 * 60 * 1000), // 10 min ago — stale by created_at!
      } as CrashAlert);

      const result = await service.sendCrashAlert('user-1', {
        lat: 49.1,
        lng: 16.75,
        alert_id: sharedId,
      });

      // The retry must see the active claim as in-flight (NOT stale)
      // and skip the reclaim path entirely. claim_version stays at 1.
      expect(result.idempotent_replay).toBe(true);
      expect(result.dispatch_in_progress).toBe(true);
      expect(notifier.send).not.toHaveBeenCalled();
      expect(alertStore.get(sharedId)?.claim_version).toBe(1);
    });

    it('preserves created_at and bumps claim_version on stale reclaim', async () => {
      // `created_at` must stay anchored to the original incident — it
      // identifies WHEN the rider crashed, not when the latest reclaim
      // happened. `claim_version` is the optimistic-lock token that
      // gets bumped instead.
      const sharedId = '00000000-0000-4000-8000-0000000000aa';
      const originalCreatedAt = new Date(Date.now() - 10 * 60 * 1000);
      alertStore.set(sharedId, {
        id: sharedId,
        user_id: 'user-1',
        ride_id: null,
        lat: 0,
        lng: 0,
        speed_at_impact: null,
        severity: 'medium',
        locale: 'en',
        contacts_notified: 0,
        contacts_total: 2,
        contact_results: [],
        dispatch_completed_at: null,
        claim_version: 0,
        claimed_at: originalCreatedAt,
        created_at: originalCreatedAt,
      } as CrashAlert);

      notifier.send.mockResolvedValue({
        channel: 'sms',
        provider_message_id: 'SM-recovered',
      });
      await service.sendCrashAlert('user-1', {
        lat: 49.1,
        lng: 16.75,
        alert_id: sharedId,
      });

      const finalRow = alertStore.get(sharedId)!;
      // created_at preserved (audit row reflects the actual incident).
      expect(finalRow.created_at.getTime()).toBe(originalCreatedAt.getTime());
      // claim_version bumped so the new claim wins the optimistic lock.
      expect(finalRow.claim_version).toBe(1);
      // claimed_at refreshed so the new claim's grace window starts now.
      expect(finalRow.claimed_at.getTime()).toBeGreaterThan(
        originalCreatedAt.getTime(),
      );
    });

    it('serializes concurrent stale-row reclaims so SMS only goes out once', async () => {
      const sharedId = '00000000-0000-4000-8000-0000000000c0';

      // Seed a stale placeholder directly so two concurrent retries
      // race for the same reclaim slot.
      alertStore.set(sharedId, {
        id: sharedId,
        user_id: 'user-1',
        ride_id: null,
        lat: 0,
        lng: 0,
        speed_at_impact: null,
        severity: 'medium',
        locale: 'en',
        contacts_notified: 0,
        contacts_total: 0,
        contact_results: [],
        dispatch_completed_at: null,
        claim_version: 0,
        claimed_at: new Date(Date.now() - 10 * 60 * 1000),
        created_at: new Date(Date.now() - 10 * 60 * 1000),
      } as CrashAlert);

      notifier.send.mockResolvedValue({
        channel: 'sms',
        provider_message_id: 'SM-recovered',
      });

      const [a, b] = await Promise.all([
        service.sendCrashAlert('user-1', {
          lat: 49.1,
          lng: 16.75,
          alert_id: sharedId,
        }),
        service.sendCrashAlert('user-1', {
          lat: 49.1,
          lng: 16.75,
          alert_id: sharedId,
        }),
      ]);

      // Exactly one of the two parallel retries reclaimed the row and
      // dispatched. The loser sees `dispatch_in_progress: true`.
      const winners = [a, b].filter((r) => !r.idempotent_replay);
      const losers = [a, b].filter((r) => r.idempotent_replay);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0].dispatch_in_progress).toBe(true);

      // Notifier was called for one dispatch only — 2 contacts × 1
      // claim. No duplicate SMS landed.
      expect(notifier.send).toHaveBeenCalledTimes(2);
    });

    it('replays a completed row when the reclaim race ends with the original finishing', async () => {
      // Reclaim-update returns affected=0 in two cases: another
      // reclaimer won (in-flight), OR the original finally finished
      // between our findOne and our reclaim UPDATE. In the second
      // case the row is now completed; we must NOT report
      // `dispatch_in_progress: true` — the rider deserves the real
      // outcome.
      const sharedId = '00000000-0000-4000-8000-0000000000c1';

      // Seed a stale-looking row with completed=null. The mock's
      // optimistic-lock predicate (`claim_version: existing.claim_version`)
      // will flip it under us mid-call by the time the reclaim
      // UPDATE is attempted, so reclaimResult.affected=0.
      const originalCreatedAt = new Date(Date.now() - 10 * 60 * 1000);
      alertStore.set(sharedId, {
        id: sharedId,
        user_id: 'user-1',
        ride_id: null,
        lat: 0,
        lng: 0,
        speed_at_impact: null,
        severity: 'medium',
        locale: 'en',
        contacts_notified: 1,
        contacts_total: 2,
        contact_results: [
          {
            contact_id: 'c-1',
            name: 'Jane',
            phone: '+420111',
            channel: 'sms',
            status: 'sent',
            provider_message_id: 'SM-original',
            error: null,
          },
        ],
        dispatch_completed_at: null,
        claim_version: 0,
        claimed_at: originalCreatedAt,
        created_at: originalCreatedAt,
      } as CrashAlert);

      // Race window: between findOne and the reclaim UPDATE the
      // original request lands its completion. We simulate that by
      // mutating the row inside the update mock the first time it's
      // called for this id.
      const realUpdate = alertRepo.update!.getMockImplementation();
      alertRepo.update!.mockImplementationOnce(async (criteria, _patch) => {
        const c = criteria as { id: string };
        if (c.id === sharedId) {
          const existing = alertStore.get(sharedId);
          if (existing) {
            alertStore.set(sharedId, {
              ...existing,
              dispatch_completed_at: new Date(),
              claim_version: existing.claim_version + 1, // bump out of the lock window
            });
          }
          return { affected: 0, raw: [], generatedMaps: [] };
        }
        return realUpdate!(criteria, _patch);
      });

      const result = await service.sendCrashAlert('user-1', {
        lat: 49.1,
        lng: 16.75,
        alert_id: sharedId,
      });

      // Lost the reclaim race, but the row is COMPLETE — surface the
      // real recorded outcome, not a misleading "still dispatching".
      expect(result.idempotent_replay).toBe(true);
      expect(result.dispatch_in_progress).toBe(false);
      expect(result.contacts_notified).toBe(1);
      expect(result.contacts).toHaveLength(1);
      expect(result.contacts[0].provider_message_id).toBe('SM-original');
    });

    it('throws Conflict and skips the websocket emit when our claim is reclaimed mid-dispatch', async () => {
      // The completion UPDATE returns affected=0 when a stale-reclaim
      // bumped claim_version under us while we were sending SMS. Both
      // we and the reclaimer dispatched to the same contacts (real
      // duplicate notifications), so the audit row now belongs to the
      // reclaimer and our outcome is no longer the canonical record.
      // Returning success would lie to the rider's app — surface the
      // inconsistency as a 409 instead so the next retry replays the
      // reclaimer's outcome.
      eventsGateway.emitToUser.mockClear();
      // Mock the completion update to return affected=0 (lost the race).
      alertRepo.update!.mockResolvedValueOnce({
        affected: 0,
        raw: [],
        generatedMaps: [],
      });

      await expect(
        service.sendCrashAlert('user-1', { lat: 49.1, lng: 16.75 }),
      ).rejects.toMatchObject({ status: 409 });

      // Notifier ran (real SMS may have gone out under our claim) but
      // the websocket event MUST NOT fire — the audit row isn't ours.
      expect(notifier.send).toHaveBeenCalled();
      expect(eventsGateway.emitToUser).not.toHaveBeenCalled();
    });

    it('propagates a completion-update failure instead of silently leaving the row in-flight', async () => {
      // If the post-dispatch UPDATE itself fails (DB hiccup, connection
      // drop), swallowing it would leave `dispatch_completed_at = null`
      // forever — a retry within the stale window would then get a
      // misleading `dispatch_in_progress: true`, suppressing the proper
      // replay. Surfacing the error to the caller is the honest answer.
      alertRepo.update!.mockImplementationOnce(() => {
        throw new Error('connection lost');
      });

      await expect(
        service.sendCrashAlert('user-1', { lat: 49.1, lng: 16.75 }),
      ).rejects.toThrow('connection lost');

      // Notifier ran (so SMS already left the system) but the row
      // could not be marked complete — that's the inconsistency the
      // 5xx surfaces to ops.
      expect(notifier.send).toHaveBeenCalled();
    });

    it('still closes the audit row when dispatch throws mid-flight', async () => {
      // Mock Promise.all to throw — emulates an unexpected error in the
      // dispatch fan-out (out-of-memory, propagated DB hiccup, etc).
      notifier.send.mockRejectedValue(new Error('boom'));

      const result = await service
        .sendCrashAlert('user-1', { lat: 49.1, lng: 16.75 })
        .catch((e: Error) => e);

      // Per-contact failures don't bubble — the request returns with
      // status: 'failed' for every contact instead of throwing.
      expect(result).not.toBeInstanceOf(Error);
      const row = alertStore.get((result as { alert_id: string }).alert_id)!;
      // Try/finally must always close the row, even when sends fail.
      expect(row.dispatch_completed_at).toBeInstanceOf(Date);
      expect(row.contacts_notified).toBe(0);
      expect(row.contact_results).toHaveLength(2);
      expect(row.contact_results[0].status).toBe('failed');
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
