/* eslint-disable @typescript-eslint/no-unsafe-call */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SafetyService } from './safety.service.js';
import { UserContact } from '../../entities/user-contact.entity.js';
import { User } from '../../entities/user.entity.js';
import { EventsGateway } from '../events/events.gateway.js';

describe('SafetyService', () => {
  let service: SafetyService;
  let contactRepo: jest.Mocked<Partial<Repository<UserContact>>>;
  let userRepo: jest.Mocked<Partial<Repository<User>>>;
  let eventsGateway: { emitToUser: jest.Mock };

  const mockUser = {
    id: 'user-1',
    display_name: 'TestRider',
  } as User;

  const mockContacts = [
    { id: 'c-1', name: 'Jane', phone: '+420111', is_emergency: true },
    { id: 'c-2', name: 'Bob', phone: '+420222', is_emergency: true },
  ] as UserContact[];

  beforeEach(async () => {
    contactRepo = {
      find: jest.fn().mockResolvedValue(mockContacts),
    };
    userRepo = {
      findOne: jest.fn().mockResolvedValue(mockUser),
    };
    eventsGateway = {
      emitToUser: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SafetyService,
        { provide: getRepositoryToken(UserContact), useValue: contactRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: EventsGateway, useValue: eventsGateway },
      ],
    }).compile();

    service = module.get<SafetyService>(SafetyService);
  });

  describe('sendCrashAlert', () => {
    it('should notify emergency contacts and return count', async () => {
      const result = await service.sendCrashAlert('user-1', {
        lat: 49.1,
        lng: 16.75,
      });

      expect(result.contacts_notified).toBe(2);
      expect(result.alert_id).toBeDefined();
      expect(contactRepo.find).toHaveBeenCalledWith({
        where: { user_id: 'user-1', is_emergency: true },
      });
    });

    it('should include speed_at_impact in alert', async () => {
      const result = await service.sendCrashAlert('user-1', {
        lat: 49.1,
        lng: 16.75,
        speed_at_impact: 72,
        ride_id: 'ride-1',
      });

      expect(result.contacts_notified).toBe(2);
    });

    it('should emit WebSocket event to user', async () => {
      await service.sendCrashAlert('user-1', {
        lat: 49.1,
        lng: 16.75,
      });

      expect(eventsGateway.emitToUser).toHaveBeenCalledWith(
        'user-1',
        'crash:alert-sent',
        expect.objectContaining({
          contacts_notified: 2,
          lat: 49.1,
          lng: 16.75,
        }),
      );
    });

    it('should return 0 contacts when user has none', async () => {
      contactRepo.find!.mockResolvedValueOnce([]);

      const result = await service.sendCrashAlert('user-1', {
        lat: 49.1,
        lng: 16.75,
      });

      expect(result.contacts_notified).toBe(0);
    });

    it('should return 0 contacts when user not found', async () => {
      userRepo.findOne!.mockResolvedValueOnce(null);

      const result = await service.sendCrashAlert('missing', {
        lat: 49.1,
        lng: 16.75,
      });

      expect(result.contacts_notified).toBe(0);
    });

    it('should generate unique alert IDs', async () => {
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
