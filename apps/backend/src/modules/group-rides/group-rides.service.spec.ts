/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { GroupRide } from '../../entities/group-ride.entity.js';
import { GroupRideMember } from '../../entities/group-ride-member.entity.js';
import { User } from '../../entities/user.entity.js';
import { EventsGateway } from '../events/events.gateway.js';
import { GroupRidesService } from './group-rides.service.js';

const RIDE_ID = '11111111-1111-1111-1111-111111111111';
const OWNER_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_ID = '00000000-0000-0000-0000-000000000002';
const NOW = new Date('2026-04-30T10:00:00.000Z');

function makeRide(overrides: Partial<GroupRide> = {}): GroupRide {
  return {
    id: RIDE_ID,
    owner_id: OWNER_ID,
    name: 'Sunday Loop',
    code: 'AB23CD',
    started_at: NOW,
    ended_at: null,
    ...overrides,
  } as GroupRide;
}

function makeMember(overrides: Partial<GroupRideMember> = {}): GroupRideMember {
  return {
    id: `m-${overrides.user_id ?? OWNER_ID}`,
    group_ride_id: RIDE_ID,
    user_id: OWNER_ID,
    joined_at: NOW,
    last_lat: null,
    last_lng: null,
    last_speed: null,
    last_heading: null,
    last_position_at: null,
    recent_path: [],
    ...overrides,
  } as GroupRideMember;
}

describe('GroupRidesService', () => {
  let service: GroupRidesService;
  let groupRideRepo: jest.Mocked<Repository<GroupRide>>;
  let memberRepo: jest.Mocked<Repository<GroupRideMember>>;
  let userRepo: {
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let events: jest.Mocked<Pick<EventsGateway, 'broadcastToGroupRide'>>;

  beforeEach(async () => {
    groupRideRepo = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      manager: {
        transaction: jest.fn().mockImplementation((cb: unknown) => {
          // Stand-in EntityManager just routes back to per-repo mocks
          // so individual tests can assert what was saved without
          // knowing TypeORM's transaction internals.
          const manager = {
            create: <T>(_ctor: unknown, data: T) => ({ ...data }),
            save: jest.fn().mockImplementation((entity: unknown) => {
              if (
                entity &&
                typeof entity === 'object' &&
                'code' in (entity as Record<string, unknown>)
              ) {
                return Promise.resolve({
                  ...(entity as Record<string, unknown>),
                  id: RIDE_ID,
                });
              }
              return Promise.resolve({
                ...(entity as object),
                id: 'm-new',
              });
            }),
          };
          return (cb as (m: typeof manager) => Promise<string>)(manager);
        }),
      },
    } as unknown as jest.Mocked<Repository<GroupRide>>;

    memberRepo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      save: jest.fn().mockImplementation((entity: unknown) =>
        Promise.resolve({
          ...(entity as object),
          id: 'm-new',
          joined_at: NOW,
        }),
      ),
      create: jest
        .fn()
        .mockImplementation((data: Partial<GroupRideMember>) => ({ ...data })),
    } as unknown as jest.Mocked<Repository<GroupRideMember>>;

    userRepo = {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: OTHER_ID, display_name: 'Other Rider' }),
      createQueryBuilder: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        whereInIds: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          { id: OWNER_ID, display_name: 'Owner Rider' },
          { id: OTHER_ID, display_name: 'Other Rider' },
        ]),
      }),
    };

    events = {
      broadcastToGroupRide: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GroupRidesService,
        { provide: getRepositoryToken(GroupRide), useValue: groupRideRepo },
        { provide: getRepositoryToken(GroupRideMember), useValue: memberRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: EventsGateway, useValue: events },
      ],
    }).compile();

    service = module.get(GroupRidesService);
  });

  describe('create', () => {
    it('persists the ride + creator membership and returns detail', async () => {
      // Two findOne calls: one for the ride detail, one inside members
      // path. We mock both via sequential returns.
      groupRideRepo.findOne.mockResolvedValue(makeRide());
      memberRepo.find.mockResolvedValue([makeMember()]);

      const detail = await service.create(OWNER_ID, { name: 'Sunday Loop' });

      expect(groupRideRepo.manager.transaction).toHaveBeenCalled();
      expect(detail).toMatchObject({
        id: RIDE_ID,
        owner_id: OWNER_ID,
        name: 'Sunday Loop',
        ended_at: null,
        members: [
          expect.objectContaining({
            user_id: OWNER_ID,
            display_name: 'Owner Rider',
          }),
        ],
      });
      // Code must look like the alphabet: 6 chars, no I/O/0/1
      expect(detail.code).toMatch(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{6}$/);
    });

    it('retries on partial-index code collision before giving up', async () => {
      // First two attempts fail with a unique-violation on the code
      // index; third succeeds. Ensures the retry loop is wired.
      let attempts = 0;
      (groupRideRepo.manager.transaction as jest.Mock).mockImplementation(
        (cb: unknown) => {
          attempts++;
          if (attempts < 3) {
            const err: Error & { code?: string; constraint?: string } =
              new Error('duplicate key');
            err.code = '23505';
            err.constraint = 'uq_group_rides_active_code';
            return Promise.reject(err);
          }
          const manager = {
            create: <T>(_c: unknown, d: T) => ({ ...d }),
            save: jest
              .fn()
              .mockImplementation((e: unknown) =>
                Promise.resolve({ ...(e as object), id: RIDE_ID }),
              ),
          };
          return (cb as (m: typeof manager) => Promise<string>)(manager);
        },
      );
      groupRideRepo.findOne.mockResolvedValue(makeRide());
      memberRepo.find.mockResolvedValue([makeMember()]);

      const detail = await service.create(OWNER_ID, { name: 'Loop' });
      expect(attempts).toBe(3);
      expect(detail.id).toBe(RIDE_ID);
    });
  });

  describe('join', () => {
    it('rejects an unknown or ended code with 404', async () => {
      groupRideRepo.findOne.mockResolvedValue(null);
      await expect(service.join(OTHER_ID, 'ZZZZZZ')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('inserts a fresh membership and broadcasts group:joined', async () => {
      // First findOne: the ride lookup. Second findOne (memberRepo) for
      // existing membership returns null. Detail's findOne again
      // returns the ride.
      groupRideRepo.findOne
        .mockResolvedValueOnce(makeRide())
        .mockResolvedValueOnce(makeRide());
      memberRepo.findOne.mockResolvedValue(null);
      memberRepo.find.mockResolvedValue([
        makeMember(),
        makeMember({ id: 'm-new', user_id: OTHER_ID }),
      ]);

      await service.join(OTHER_ID, 'ab23cd');

      expect(memberRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          group_ride_id: RIDE_ID,
          user_id: OTHER_ID,
        }),
      );
      expect(events.broadcastToGroupRide).toHaveBeenCalledWith(
        RIDE_ID,
        'group:joined',
        expect.objectContaining({
          group_ride_id: RIDE_ID,
          user_id: OTHER_ID,
          display_name: 'Other Rider',
        }),
      );
    });

    it('is idempotent for an existing member (no insert, no broadcast)', async () => {
      groupRideRepo.findOne
        .mockResolvedValueOnce(makeRide())
        .mockResolvedValueOnce(makeRide());
      memberRepo.findOne.mockResolvedValue(
        makeMember({ user_id: OTHER_ID, id: 'm-existing' }),
      );
      memberRepo.find.mockResolvedValue([
        makeMember(),
        makeMember({ id: 'm-existing', user_id: OTHER_ID }),
      ]);

      await service.join(OTHER_ID, 'AB23CD');

      expect(memberRepo.save).not.toHaveBeenCalled();
      expect(events.broadcastToGroupRide).not.toHaveBeenCalled();
    });

    it('normalises the code to uppercase before lookup', async () => {
      groupRideRepo.findOne
        .mockResolvedValueOnce(makeRide())
        .mockResolvedValueOnce(makeRide());
      memberRepo.findOne.mockResolvedValue(makeMember({ user_id: OTHER_ID }));
      memberRepo.find.mockResolvedValue([]);

      await service.join(OTHER_ID, '  ab23cd  ');

      expect(groupRideRepo.findOne).toHaveBeenCalledWith({
        where: expect.objectContaining({ code: 'AB23CD' }),
      });
    });
  });

  describe('leave', () => {
    it('rejects non-members with 404', async () => {
      groupRideRepo.findOne.mockResolvedValue(makeRide());
      memberRepo.findOne.mockResolvedValue(null);

      await expect(service.leave(OTHER_ID, RIDE_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(memberRepo.delete).not.toHaveBeenCalled();
    });

    it('rejects with 404 when the ride is already ended', async () => {
      groupRideRepo.findOne.mockResolvedValue(
        makeRide({ ended_at: new Date('2026-04-30T11:00:00Z') }),
      );

      await expect(service.leave(OWNER_ID, RIDE_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('deletes membership, broadcasts group:left, and ends ride if owner', async () => {
      groupRideRepo.findOne.mockResolvedValue(makeRide());
      memberRepo.findOne.mockResolvedValue(makeMember({ user_id: OWNER_ID }));
      memberRepo.count.mockResolvedValue(0);

      await service.leave(OWNER_ID, RIDE_ID);

      expect(memberRepo.delete).toHaveBeenCalled();
      // Two broadcasts: group:left, then group:ended (owner left ⇒ end ride).
      expect(events.broadcastToGroupRide).toHaveBeenCalledWith(
        RIDE_ID,
        'group:left',
        expect.objectContaining({ user_id: OWNER_ID }),
      );
      expect(events.broadcastToGroupRide).toHaveBeenCalledWith(
        RIDE_ID,
        'group:ended',
        expect.any(Object),
      );
      expect(groupRideRepo.update).toHaveBeenCalledWith(
        { id: RIDE_ID },
        expect.objectContaining({ ended_at: expect.any(Date) }),
      );
    });

    it('ends the ride when the last non-owner member leaves', async () => {
      groupRideRepo.findOne.mockResolvedValue(makeRide());
      memberRepo.findOne.mockResolvedValue(makeMember({ user_id: OTHER_ID }));
      memberRepo.count.mockResolvedValue(0);

      await service.leave(OTHER_ID, RIDE_ID);

      expect(events.broadcastToGroupRide).toHaveBeenCalledWith(
        RIDE_ID,
        'group:ended',
        expect.any(Object),
      );
    });

    it('does not end the ride when other members remain', async () => {
      groupRideRepo.findOne.mockResolvedValue(makeRide());
      memberRepo.findOne.mockResolvedValue(makeMember({ user_id: OTHER_ID }));
      memberRepo.count.mockResolvedValue(2);

      await service.leave(OTHER_ID, RIDE_ID);

      expect(events.broadcastToGroupRide).toHaveBeenCalledWith(
        RIDE_ID,
        'group:left',
        expect.any(Object),
      );
      expect(events.broadcastToGroupRide).not.toHaveBeenCalledWith(
        RIDE_ID,
        'group:ended',
        expect.any(Object),
      );
      expect(groupRideRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('end', () => {
    it('rejects callers who are not the owner', async () => {
      groupRideRepo.findOne.mockResolvedValue(makeRide());

      await expect(service.end(OTHER_ID, RIDE_ID)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(groupRideRepo.update).not.toHaveBeenCalled();
    });

    it('is a no-op when the ride is already ended', async () => {
      groupRideRepo.findOne.mockResolvedValue(
        makeRide({ ended_at: new Date('2026-04-30T11:00:00Z') }),
      );

      await service.end(OWNER_ID, RIDE_ID);

      expect(groupRideRepo.update).not.toHaveBeenCalled();
      expect(events.broadcastToGroupRide).not.toHaveBeenCalled();
    });

    it('flips ended_at and broadcasts group:ended', async () => {
      groupRideRepo.findOne.mockResolvedValue(makeRide());

      await service.end(OWNER_ID, RIDE_ID);

      expect(groupRideRepo.update).toHaveBeenCalledWith(
        { id: RIDE_ID },
        expect.objectContaining({ ended_at: expect.any(Date) }),
      );
      expect(events.broadcastToGroupRide).toHaveBeenCalledWith(
        RIDE_ID,
        'group:ended',
        expect.any(Object),
      );
    });

    it('wipes every member location + breadcrumb buffer on end (#752)', async () => {
      groupRideRepo.findOne.mockResolvedValue(makeRide());

      await service.end(OWNER_ID, RIDE_ID);

      expect(memberRepo.update).toHaveBeenCalledWith(
        { group_ride_id: RIDE_ID },
        {
          last_lat: null,
          last_lng: null,
          last_speed: null,
          last_heading: null,
          last_position_at: null,
          recent_path: [],
        },
      );
    });
  });

  describe('getDetail', () => {
    it('rejects non-members with 404', async () => {
      memberRepo.findOne.mockResolvedValue(null);

      await expect(service.getDetail(OTHER_ID, RIDE_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('returns members with display names and last-known positions', async () => {
      memberRepo.findOne.mockResolvedValue(makeMember({ user_id: OTHER_ID }));
      groupRideRepo.findOne.mockResolvedValue(makeRide());
      memberRepo.find.mockResolvedValue([
        makeMember({
          user_id: OWNER_ID,
          last_lat: 49.1,
          last_lng: 16.5,
          last_speed: 80,
          last_heading: 180,
          last_position_at: new Date('2026-04-30T10:30:00Z'),
          recent_path: [{ lat: 49.0, lng: 16.4, at: NOW.toISOString() }],
        }),
        makeMember({ user_id: OTHER_ID, id: 'm-other' }),
      ]);

      const detail = await service.getDetail(OTHER_ID, RIDE_ID);

      expect(detail.members).toHaveLength(2);
      expect(detail.members[0]).toMatchObject({
        user_id: OWNER_ID,
        display_name: 'Owner Rider',
        last_lat: 49.1,
        last_lng: 16.5,
        last_speed: 80,
        last_heading: 180,
        last_position_at: '2026-04-30T10:30:00.000Z',
        recent_path: [{ lat: 49.0, lng: 16.4, at: NOW.toISOString() }],
      });
    });
  });
});
