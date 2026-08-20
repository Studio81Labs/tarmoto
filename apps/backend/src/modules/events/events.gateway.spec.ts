/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { EventsGateway } from './events.gateway.js';
import { Ride } from '../../entities/ride.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { GroupRideMember } from '../../entities/group-ride-member.entity.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';
import { Server, Socket } from 'socket.io';
import { buildFeatureSnapshot } from '@tarmoto/shared';

describe('EventsGateway', () => {
  let gateway: EventsGateway;
  let jwtService: jest.Mocked<JwtService>;
  let rideRepo: { findOne: jest.Mock };
  let tripMemberRepo: { findOne: jest.Mock };
  let groupRideMemberRepo: {
    findOne: jest.Mock;
    update: jest.Mock;
  };
  let featureResolver: { resolveForUser: jest.Mock };

  const mockServer = {
    adapter: jest.fn(),
    to: jest.fn().mockReturnThis(),
    emit: jest.fn(),
  } as unknown as Server;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsGateway,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string, def?: unknown) => {
              if (key === 'redis.host') return 'localhost';
              if (key === 'redis.port') return 6379;
              return def;
            }),
          },
        },
        {
          provide: JwtService,
          useValue: {
            verifyAsync: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Ride),
          useValue: {
            findOne: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: getRepositoryToken(TripMember),
          useValue: {
            findOne: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: getRepositoryToken(GroupRideMember),
          useValue: {
            findOne: jest.fn().mockResolvedValue(null),
            update: jest.fn().mockResolvedValue({ affected: 1 }),
          },
        },
        {
          provide: FeatureResolver,
          useValue: {
            // Default: entitled — the launch-mode force_on posture.
            resolveForUser: jest
              .fn()
              .mockResolvedValue(
                buildFeatureSnapshot('free', {}, { group_rides: 'force_on' }),
              ),
          },
        },
      ],
    }).compile();

    gateway = module.get<EventsGateway>(EventsGateway);
    jwtService = module.get(JwtService);
    rideRepo = module.get(getRepositoryToken(Ride));
    tripMemberRepo = module.get(getRepositoryToken(TripMember));
    groupRideMemberRepo = module.get(getRepositoryToken(GroupRideMember));
    featureResolver = module.get(FeatureResolver);
    gateway.server = mockServer;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('handleConnection', () => {
    it('should authenticate client with valid access token', async () => {
      jwtService.verifyAsync.mockResolvedValueOnce({
        sub: 'user-1',
        type: 'access',
      });

      const client = {
        id: 'client-1',
        data: {},
        handshake: { auth: { token: 'valid-jwt' }, headers: {} },
        join: jest.fn(),
      } as unknown as Socket;

      await gateway.handleConnection(client);

      expect(jwtService.verifyAsync).toHaveBeenCalledWith('valid-jwt');
      expect(client.data.userId).toBe('user-1');
      expect(client.join).toHaveBeenCalledWith('user:user-1');
    });

    it('should accept anonymous connections', async () => {
      const client = {
        id: 'client-2',
        data: {},
        handshake: { auth: {}, headers: {} },
        join: jest.fn(),
      } as unknown as Socket;

      await gateway.handleConnection(client);

      expect(jwtService.verifyAsync).not.toHaveBeenCalled();
      expect(client.join).not.toHaveBeenCalled();
    });

    it('should reject refresh tokens', async () => {
      jwtService.verifyAsync.mockResolvedValueOnce({
        sub: 'user-1',
        type: 'refresh',
      });

      const client = {
        id: 'client-reject',
        data: {},
        handshake: { auth: { token: 'refresh-jwt' }, headers: {} },
        join: jest.fn(),
      } as unknown as Socket;

      await gateway.handleConnection(client);

      expect(client.data.userId).toBeUndefined();
      expect(client.join).not.toHaveBeenCalled();
    });

    it('should handle invalid token gracefully', async () => {
      jwtService.verifyAsync.mockRejectedValueOnce(new Error('invalid'));

      const client = {
        id: 'client-3',
        data: {},
        handshake: { auth: { token: 'bad-token' }, headers: {} },
        join: jest.fn(),
      } as unknown as Socket;

      await gateway.handleConnection(client);

      expect(client.data.userId).toBeUndefined();
    });

    it('should extract token from Authorization header', async () => {
      jwtService.verifyAsync.mockResolvedValueOnce({
        sub: 'user-2',
        type: 'access',
      });

      const client = {
        id: 'client-4',
        data: {},
        handshake: {
          auth: {},
          headers: { authorization: 'Bearer header-jwt' },
        },
        join: jest.fn(),
      } as unknown as Socket;

      await gateway.handleConnection(client);

      expect(jwtService.verifyAsync).toHaveBeenCalledWith('header-jwt');
    });
  });

  describe('handleSubscribeHazards', () => {
    it('should join center cell for small radius', () => {
      const client = {
        id: 'client-1',
        rooms: new Set(['client-1']),
        join: jest.fn(),
        leave: jest.fn(),
      } as unknown as Socket;

      gateway.handleSubscribeHazards(client, {
        lat: 49.15,
        lng: 16.75,
      });

      expect(client.join).toHaveBeenCalledTimes(1);
      expect(client.join).toHaveBeenCalledWith('hazards:491:167');
    });

    it('should join 9 cells for large radius', () => {
      const client = {
        id: 'client-1',
        rooms: new Set(['client-1']),
        join: jest.fn(),
        leave: jest.fn(),
      } as unknown as Socket;

      gateway.handleSubscribeHazards(client, {
        lat: 49.15,
        lng: 16.75,
        radius_m: 10000,
      });

      expect(client.join).toHaveBeenCalledTimes(9);
    });

    it('should leave old hazard rooms before joining new ones', () => {
      const client = {
        id: 'client-1',
        rooms: new Set(['client-1', 'hazards:490:166', 'hazards:491:167']),
        join: jest.fn(),
        leave: jest.fn(),
      } as unknown as Socket;

      gateway.handleSubscribeHazards(client, {
        lat: 50.0,
        lng: 17.0,
      });

      // Should leave old hazard rooms
      expect(client.leave).toHaveBeenCalledWith('hazards:490:166');
      expect(client.leave).toHaveBeenCalledWith('hazards:491:167');
      // Should join new cell
      expect(client.join).toHaveBeenCalledWith('hazards:500:170');
    });
  });

  describe('handleUnsubscribeHazards', () => {
    it('leaves every hazard room and nothing else (#1160 — a kill-switch flip must stop the fanout)', () => {
      const client = {
        id: 'client-1',
        rooms: new Set([
          'client-1',
          'hazards:490:166',
          'hazards:491:167',
          'trip:11111111-2222-4333-8444-555555555555',
        ]),
        join: jest.fn(),
        leave: jest.fn(),
      } as unknown as Socket;

      gateway.handleUnsubscribeHazards(client);

      expect(client.leave).toHaveBeenCalledTimes(2);
      expect(client.leave).toHaveBeenCalledWith('hazards:490:166');
      expect(client.leave).toHaveBeenCalledWith('hazards:491:167');
      expect(client.join).not.toHaveBeenCalled();
    });

    it('is a no-op for a client in no hazard rooms', () => {
      const client = {
        id: 'client-1',
        rooms: new Set(['client-1', 'user:abc']),
        join: jest.fn(),
        leave: jest.fn(),
      } as unknown as Socket;

      gateway.handleUnsubscribeHazards(client);

      expect(client.leave).not.toHaveBeenCalled();
    });
  });

  describe('handleSubscribeGroupRide', () => {
    it('should join ride room for ride owner', async () => {
      rideRepo.findOne.mockResolvedValueOnce({
        id: 'ride-1',
        user_id: 'user-1',
      });
      const client = {
        id: 'client-1',
        data: { userId: 'user-1' },
        join: jest.fn(),
        emit: jest.fn(),
      } as unknown as Socket;

      await gateway.handleSubscribeGroupRide(client, {
        ride_id: 'ride-1',
      });

      expect(client.join).toHaveBeenCalledWith('ride:ride-1');
    });

    it('should reject missing ride_id', async () => {
      const client = {
        id: 'client-1',
        data: { userId: 'user-1' },
        join: jest.fn(),
        emit: jest.fn(),
      } as unknown as Socket;

      await gateway.handleSubscribeGroupRide(client, {} as never);

      expect(client.join).not.toHaveBeenCalled();
      expect(rideRepo.findOne).not.toHaveBeenCalled();
      expect(client.emit).toHaveBeenCalledWith('error', {
        message: 'ride_id is required',
      });
    });

    it('should reject user who does not own the ride', async () => {
      rideRepo.findOne.mockResolvedValueOnce(null);
      const client = {
        id: 'client-1',
        data: { userId: 'user-2' },
        join: jest.fn(),
        emit: jest.fn(),
      } as unknown as Socket;

      await gateway.handleSubscribeGroupRide(client, {
        ride_id: 'ride-1',
      });

      expect(client.join).not.toHaveBeenCalled();
      expect(client.emit).toHaveBeenCalledWith('error', {
        message: 'Ride not found or access denied',
      });
    });

    it('should reject unauthenticated client', async () => {
      const client = {
        id: 'client-2',
        data: {},
        join: jest.fn(),
        emit: jest.fn(),
      } as unknown as Socket;

      await gateway.handleSubscribeGroupRide(client, {
        ride_id: 'ride-1',
      });

      expect(client.join).not.toHaveBeenCalled();
      expect(client.emit).toHaveBeenCalledWith('error', {
        message: 'Authentication required',
      });
    });
  });

  describe('handleLocationUpdate', () => {
    it('should broadcast to ride room excluding sender', async () => {
      const mockTo = jest.fn().mockReturnValue({ emit: jest.fn() });
      const client = {
        id: 'client-1',
        data: { userId: 'user-1' },
        rooms: new Set(['client-1', 'ride:ride-1']),
        to: mockTo,
        leave: jest.fn(),
      } as unknown as Socket;

      await gateway.handleLocationUpdate(client, {
        ride_id: 'ride-1',
        lat: 49.1,
        lng: 16.75,
        speed: 15,
        heading: 180,
      });

      expect(mockTo).toHaveBeenCalledWith('ride:ride-1');
      expect(mockTo('ride:ride-1').emit).toHaveBeenCalledWith(
        'rider:location',
        expect.objectContaining({
          user_id: 'user-1',
          lat: 49.1,
          lng: 16.75,
          speed: 15,
          heading: 180,
        }),
      );
    });

    it('should reject authenticated client not in ride room', async () => {
      const mockTo = jest.fn();
      const client = {
        id: 'client-1',
        data: { userId: 'user-1' },
        rooms: new Set(['client-1']), // not in ride:ride-1
        to: mockTo,
        leave: jest.fn(),
      } as unknown as Socket;

      await gateway.handleLocationUpdate(client, {
        ride_id: 'ride-1',
        lat: 49.1,
        lng: 16.75,
      });

      expect(mockTo).not.toHaveBeenCalled();
    });

    it('should ignore unauthenticated clients', async () => {
      const mockTo = jest.fn();
      const client = {
        id: 'client-2',
        data: {},
        rooms: new Set(['client-2']),
        to: mockTo,
        leave: jest.fn(),
      } as unknown as Socket;

      await gateway.handleLocationUpdate(client, {
        ride_id: 'ride-1',
        lat: 49.1,
        lng: 16.75,
      });

      expect(mockTo).not.toHaveBeenCalled();
    });

    it('drops the update and detaches the client when the entitlement is revoked', async () => {
      featureResolver.resolveForUser.mockResolvedValueOnce(
        buildFeatureSnapshot('free', {}, { group_rides: 'force_off' }),
      );
      const mockTo = jest.fn();
      const client = {
        id: 'client-1',
        data: { userId: 'user-1' },
        rooms: new Set(['client-1', 'ride:ride-1']),
        to: mockTo,
        leave: jest.fn(),
      } as unknown as Socket;

      await gateway.handleLocationUpdate(client, {
        ride_id: 'ride-1',
        lat: 49.1,
        lng: 16.75,
      });

      expect(mockTo).not.toHaveBeenCalled();
      expect(client.leave).toHaveBeenCalledWith('ride:ride-1');
    });
  });

  describe('evictFromGroupRideRooms', () => {
    function makeRemoteSocket(rooms: string[]) {
      return { rooms: new Set(rooms), leave: jest.fn() };
    }

    it('kicks a specific user out of group + legacy ride rooms only', async () => {
      const socket = makeRemoteSocket([
        'c-1',
        'user:user-1',
        'group-ride:gr-1',
        'ride:ride-1',
        'trip:trip-1',
      ]);
      const fetchSockets = jest.fn().mockResolvedValue([socket]);
      (gateway.server as unknown as { in: jest.Mock }).in = jest
        .fn()
        .mockReturnValue({ fetchSockets });

      await gateway.evictFromGroupRideRooms('user-1');

      expect(
        (gateway.server as unknown as { in: jest.Mock }).in,
      ).toHaveBeenCalledWith('user:user-1');
      expect(socket.leave).toHaveBeenCalledWith('group-ride:gr-1');
      expect(socket.leave).toHaveBeenCalledWith('ride:ride-1');
      expect(socket.leave).not.toHaveBeenCalledWith('trip:trip-1');
      expect(socket.leave).not.toHaveBeenCalledWith('user:user-1');
    });

    it('kicks every socket out of group rooms when called without a user (kill switch)', async () => {
      const member = makeRemoteSocket(['c-1', 'group-ride:gr-1']);
      const bystander = makeRemoteSocket(['c-2', 'hazards:491:167']);
      const fetchSockets = jest.fn().mockResolvedValue([member, bystander]);
      (gateway.server as unknown as { fetchSockets: jest.Mock }).fetchSockets =
        fetchSockets;

      await gateway.evictFromGroupRideRooms();

      expect(member.leave).toHaveBeenCalledWith('group-ride:gr-1');
      expect(bystander.leave).not.toHaveBeenCalled();
    });
  });

  describe('evictNonEntitledFromGroupRideRooms', () => {
    function makeRemoteSocket(rooms: string[], userId?: string) {
      return {
        rooms: new Set(rooms),
        data: userId ? { userId } : {},
        leave: jest.fn(),
      };
    }

    it('evicts only members who no longer resolve group_rides', async () => {
      // free-1 lost the entitlement when force_on was cleared; prem-1
      // holds it via tier and must stay connected.
      featureResolver.resolveForUser.mockImplementation((userId: string) =>
        Promise.resolve(
          buildFeatureSnapshot(
            userId === 'prem-1' ? 'premium' : 'free',
            {},
            {},
          ),
        ),
      );
      const revoked = makeRemoteSocket(['c-1', 'group-ride:gr-1'], 'free-1');
      const entitled = makeRemoteSocket(['c-2', 'group-ride:gr-1'], 'prem-1');
      const anonymous = makeRemoteSocket(['c-3', 'group-ride:gr-1']);
      const bystander = makeRemoteSocket(['c-4', 'trip:t-1'], 'free-2');
      (gateway.server as unknown as { fetchSockets: jest.Mock }).fetchSockets =
        jest.fn().mockResolvedValue([revoked, entitled, anonymous, bystander]);

      await gateway.evictNonEntitledFromGroupRideRooms();

      expect(revoked.leave).toHaveBeenCalledWith('group-ride:gr-1');
      expect(entitled.leave).not.toHaveBeenCalled();
      // no authenticated user on the socket → fail closed
      expect(anonymous.leave).toHaveBeenCalledWith('group-ride:gr-1');
      // sockets outside group rooms are never touched (and never resolved)
      expect(bystander.leave).not.toHaveBeenCalled();
    });

    it('fails closed when a member cannot be resolved', async () => {
      featureResolver.resolveForUser.mockRejectedValueOnce(
        new Error('user vanished'),
      );
      const socket = makeRemoteSocket(['c-1', 'ride:r-1'], 'ghost');
      (gateway.server as unknown as { fetchSockets: jest.Mock }).fetchSockets =
        jest.fn().mockResolvedValue([socket]);

      await gateway.evictNonEntitledFromGroupRideRooms();

      expect(socket.leave).toHaveBeenCalledWith('ride:r-1');
    });
  });

  describe('onApplicationBootstrap (#1104 review — cross-node startup sweep)', () => {
    function makeRemoteSocket(rooms: string[], userId?: string) {
      return {
        rooms: new Set(rooms),
        data: userId ? { userId } : {},
        leave: jest.fn(),
      };
    }

    it('runs the same eviction sweep as an admin clearGlobalState() on boot', async () => {
      // Mirrors clearGlobalState/migration 1839 clearing the group_rides
      // launch-mode override: a rider mid-connection who no longer
      // resolves the entitlement must be dropped from the live room.
      featureResolver.resolveForUser.mockResolvedValue(
        buildFeatureSnapshot('free', {}, {}),
      );
      const revoked = makeRemoteSocket(['c-1', 'group-ride:gr-1'], 'free-1');
      (gateway.server as unknown as { fetchSockets: jest.Mock }).fetchSockets =
        jest.fn().mockResolvedValue([revoked]);

      await gateway.onApplicationBootstrap();

      expect(revoked.leave).toHaveBeenCalledWith('group-ride:gr-1');
    });

    it('never throws — a resolver/fetch failure must not fail app startup', async () => {
      (gateway.server as unknown as { fetchSockets: jest.Mock }).fetchSockets =
        jest.fn().mockRejectedValue(new Error('redis unreachable'));

      await expect(gateway.onApplicationBootstrap()).resolves.toBeUndefined();
    });
  });

  describe('server-side emit methods', () => {
    it('emitHazardAlert should broadcast to correct grid cell', () => {
      gateway.emitHazardAlert(49.1, 16.75, {
        id: 'h-1',
        note: null,
        confirmations: 0,
        reporter: null,
        road_name: null,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        hazard_type: 'pothole',
        severity: 'high',
        lat: 49.1,
        lng: 16.75,
      });

      expect(mockServer.to).toHaveBeenCalledWith('hazards:491:167');
      expect(mockServer.emit).toHaveBeenCalledWith(
        'hazard:new',
        expect.objectContaining({ hazard_type: 'pothole' }),
      );
    });

    it('emitToUser should target user room', () => {
      gateway.emitToUser('user-1', 'test:event', { foo: 'bar' });

      expect(mockServer.to).toHaveBeenCalledWith('user:user-1');
      expect(mockServer.emit).toHaveBeenCalledWith('test:event', {
        foo: 'bar',
      });
    });

    it('broadcast should emit to all', () => {
      gateway.broadcast('global:event', { msg: 'hello' });

      expect(mockServer.emit).toHaveBeenCalledWith('global:event', {
        msg: 'hello',
      });
    });

    it('emitToTrip targets the trip room', () => {
      gateway.emitToTrip('trip-1', 'trip:message', { body: 'hi' });

      expect(mockServer.to).toHaveBeenCalledWith('trip:trip-1');
      expect(mockServer.emit).toHaveBeenCalledWith('trip:message', {
        body: 'hi',
      });
    });
  });

  describe('handleSubscribeTrip', () => {
    it('rejects unauthenticated clients', async () => {
      const client = {
        id: 'c-1',
        data: {},
        join: jest.fn(),
        emit: jest.fn(),
      } as unknown as Socket;

      await gateway.handleSubscribeTrip(client, { trip_id: 'trip-1' });

      expect(client.join).not.toHaveBeenCalled();
      expect(tripMemberRepo.findOne).not.toHaveBeenCalled();
      expect(client.emit).toHaveBeenCalledWith('error', {
        message: 'Authentication required',
      });
    });

    it('rejects a missing trip_id', async () => {
      const client = {
        id: 'c-1',
        data: { userId: 'user-1' },
        join: jest.fn(),
        emit: jest.fn(),
      } as unknown as Socket;

      await gateway.handleSubscribeTrip(client, {} as never);

      expect(client.join).not.toHaveBeenCalled();
      expect(tripMemberRepo.findOne).not.toHaveBeenCalled();
      expect(client.emit).toHaveBeenCalledWith('error', {
        message: 'trip_id is required',
      });
    });

    it('rejects a non-UUID trip_id BEFORE hitting the DB — keeps Postgres "invalid input syntax" errors from leaking to clients', async () => {
      const client = {
        id: 'c-1',
        data: { userId: 'user-1' },
        join: jest.fn(),
        emit: jest.fn(),
      } as unknown as Socket;

      await gateway.handleSubscribeTrip(client, { trip_id: 'abc' });

      expect(client.join).not.toHaveBeenCalled();
      expect(tripMemberRepo.findOne).not.toHaveBeenCalled();
      expect(client.emit).toHaveBeenCalledWith('error', {
        message: 'trip_id must be a UUID',
      });
    });

    it('rejects a non-member with the same error as a missing trip', async () => {
      tripMemberRepo.findOne.mockResolvedValueOnce(null);
      const client = {
        id: 'c-1',
        data: { userId: 'user-1' },
        join: jest.fn(),
        emit: jest.fn(),
      } as unknown as Socket;

      await gateway.handleSubscribeTrip(client, {
        trip_id: '123e4567-e89b-42d3-a456-556642440000',
      });

      expect(client.join).not.toHaveBeenCalled();
      expect(client.emit).toHaveBeenCalledWith('error', {
        message: 'Trip not found or access denied',
      });
    });

    it('joins the trip room for a verified member and broadcasts presence', async () => {
      tripMemberRepo.findOne.mockResolvedValueOnce({
        trip_id: '123e4567-e89b-42d3-a456-556642440000',
        user_id: 'user-1',
      });
      const client = {
        id: 'c-1',
        data: { userId: 'user-1' },
        join: jest.fn(),
        emit: jest.fn(),
      } as unknown as Socket;

      await gateway.handleSubscribeTrip(client, {
        trip_id: '123e4567-e89b-42d3-a456-556642440000',
      });

      expect(client.join).toHaveBeenCalledWith(
        'trip:123e4567-e89b-42d3-a456-556642440000',
      );
      // Presence broadcast so other collaborators see the new arrival.
      expect(mockServer.to).toHaveBeenCalledWith(
        'trip:123e4567-e89b-42d3-a456-556642440000',
      );
      expect(mockServer.emit).toHaveBeenCalledWith(
        'trip:presence',
        expect.objectContaining({
          trip_id: '123e4567-e89b-42d3-a456-556642440000',
          user_id: 'user-1',
          online: true,
        }),
      );
    });

    it('is idempotent per socket — a duplicate subscribe does NOT re-emit presence or re-query membership', async () => {
      // Simulates the client-side reconnect replay (`subscribe:trip`
      // fired on every `connect`) landing on a socket that already has
      // the room in its rooms set. Without the guard this would emit a
      // second `online: true` while only one `online: false` goes out
      // on disconnect — the client's per-user socket counter would
      // drift positive and never flip `online` back to false.
      const room = 'trip:123e4567-e89b-42d3-a456-556642440000';
      const client = {
        id: 'c-1',
        data: { userId: 'user-1' },
        rooms: new Set(['c-1', room]),
        join: jest.fn(),
        emit: jest.fn(),
      } as unknown as Socket;

      await gateway.handleSubscribeTrip(client, {
        trip_id: '123e4567-e89b-42d3-a456-556642440000',
      });

      expect(tripMemberRepo.findOne).not.toHaveBeenCalled();
      expect(client.join).not.toHaveBeenCalled();
      expect(mockServer.emit).not.toHaveBeenCalled();
    });
  });

  describe('handleTripCursor', () => {
    it('broadcasts the cursor to other members in the room (sender excluded)', () => {
      const mockTo = jest.fn().mockReturnValue({ emit: jest.fn() });
      const client = {
        id: 'c-1',
        data: { userId: 'user-1' },
        rooms: new Set(['c-1', 'trip:trip-1']),
        to: mockTo,
      } as unknown as Socket;

      gateway.handleTripCursor(client, {
        trip_id: 'trip-1',
        lat: 49.1,
        lng: 16.75,
      });

      expect(mockTo).toHaveBeenCalledWith('trip:trip-1');
      expect(mockTo('trip:trip-1').emit).toHaveBeenCalledWith(
        'trip:cursor',
        expect.objectContaining({
          user_id: 'user-1',
          trip_id: 'trip-1',
          lat: 49.1,
          lng: 16.75,
        }),
      );
    });

    it('silently drops cursors for rooms the client has not joined', () => {
      const mockTo = jest.fn();
      const client = {
        id: 'c-1',
        data: { userId: 'user-1' },
        rooms: new Set(['c-1']),
        to: mockTo,
      } as unknown as Socket;

      gateway.handleTripCursor(client, {
        trip_id: 'trip-x',
        lat: 0,
        lng: 0,
      });

      expect(mockTo).not.toHaveBeenCalled();
    });

    it('ignores unauthenticated sockets', () => {
      const mockTo = jest.fn();
      const client = {
        id: 'c-1',
        data: {},
        rooms: new Set(['c-1', 'trip:trip-1']),
        to: mockTo,
      } as unknown as Socket;

      gateway.handleTripCursor(client, {
        trip_id: 'trip-1',
        lat: 0,
        lng: 0,
      });

      expect(mockTo).not.toHaveBeenCalled();
    });

    it('drops the second cursor inside the 10 Hz throttle window (US-35)', () => {
      // Acceptance criterion: "Throttled at 10 Hz max per sender (drop,
      // don't queue)". The gateway enforces ≤ 10 Hz (100 ms floor) so
      // a misbehaving client can't flood every other collaborator.
      const emit = jest.fn();
      const mockTo = jest.fn().mockReturnValue({ emit });
      const client = {
        id: 'c-1',
        data: { userId: 'user-1' },
        rooms: new Set(['c-1', 'trip:trip-1']),
        to: mockTo,
      } as unknown as Socket;

      const payload = { trip_id: 'trip-1', lat: 49.1, lng: 16.75 };
      gateway.handleTripCursor(client, payload);
      gateway.handleTripCursor(client, payload);

      expect(emit).toHaveBeenCalledTimes(1);
    });

    it('throttles per (trip, user) so different rooms do NOT block each other', () => {
      // Same socket emits cursors into two different trips it has
      // joined — both should land. A naive global throttle would only
      // accept the first.
      const emit = jest.fn();
      const mockTo = jest.fn().mockReturnValue({ emit });
      const client = {
        id: 'c-1',
        data: { userId: 'user-1' },
        rooms: new Set(['c-1', 'trip:trip-1', 'trip:trip-2']),
        to: mockTo,
      } as unknown as Socket;

      gateway.handleTripCursor(client, {
        trip_id: 'trip-1',
        lat: 49.1,
        lng: 16.75,
      });
      gateway.handleTripCursor(client, {
        trip_id: 'trip-2',
        lat: 49.2,
        lng: 16.85,
      });

      expect(emit).toHaveBeenCalledTimes(2);
    });
  });

  describe('handleUnsubscribeTrip', () => {
    it('leaves the trip room', () => {
      const client = {
        id: 'c-1',
        data: { userId: 'user-1', joinedTrips: new Set(['trip-1']) },
        rooms: new Set(['c-1', 'trip:trip-1']),
        leave: jest.fn(),
      } as unknown as Socket;

      gateway.handleUnsubscribeTrip(client, { trip_id: 'trip-1' });

      expect(client.leave).toHaveBeenCalledWith('trip:trip-1');
      // Presence broadcast on leave so other members see the departure.
      expect(mockServer.emit).toHaveBeenCalledWith(
        'trip:presence',
        expect.objectContaining({
          trip_id: 'trip-1',
          user_id: 'user-1',
          online: false,
        }),
      );
    });

    it('ignores a missing trip_id rather than throwing', () => {
      const client = {
        id: 'c-1',
        data: {},
        rooms: new Set(['c-1']),
        leave: jest.fn(),
      } as unknown as Socket;

      gateway.handleUnsubscribeTrip(client, {} as never);

      expect(client.leave).not.toHaveBeenCalled();
    });
  });

  describe('handleSubscribeGroup (US-26)', () => {
    const RIDE_ID = '11111111-1111-1111-1111-111111111111';

    it('rejects unauthenticated clients', async () => {
      const client = {
        id: 'c-1',
        data: {},
        rooms: new Set(['c-1']),
        join: jest.fn(),
        emit: jest.fn(),
      } as unknown as Socket;

      await gateway.handleSubscribeGroup(client, { group_ride_id: RIDE_ID });

      expect(groupRideMemberRepo.findOne).not.toHaveBeenCalled();
      expect(client.emit).toHaveBeenCalledWith('error', expect.any(Object));
      expect(client.join).not.toHaveBeenCalled();
    });

    it('rejects non-UUID ride ids before hitting the database', async () => {
      const client = {
        id: 'c-1',
        data: { userId: 'user-1' },
        rooms: new Set(['c-1']),
        join: jest.fn(),
        emit: jest.fn(),
      } as unknown as Socket;

      await gateway.handleSubscribeGroup(client, { group_ride_id: 'not-uuid' });

      expect(groupRideMemberRepo.findOne).not.toHaveBeenCalled();
      expect(client.emit).toHaveBeenCalledWith(
        'error',
        expect.objectContaining({ message: 'group_ride_id must be a UUID' }),
      );
    });

    it('rejects callers who are not members of the ride', async () => {
      groupRideMemberRepo.findOne.mockResolvedValueOnce(null);
      const client = {
        id: 'c-1',
        data: { userId: 'user-1' },
        rooms: new Set(['c-1']),
        join: jest.fn(),
        emit: jest.fn(),
      } as unknown as Socket;

      await gateway.handleSubscribeGroup(client, { group_ride_id: RIDE_ID });

      expect(client.join).not.toHaveBeenCalled();
      expect(client.emit).toHaveBeenCalledWith('error', expect.any(Object));
    });

    it('joins the room when the caller is a member', async () => {
      groupRideMemberRepo.findOne.mockResolvedValueOnce({
        id: 'm-1',
        group_ride_id: RIDE_ID,
        user_id: 'user-1',
        group_ride: { id: RIDE_ID, ended_at: null },
      });
      const client = {
        id: 'c-1',
        data: { userId: 'user-1' },
        rooms: new Set(['c-1']),
        join: jest.fn(),
        emit: jest.fn(),
      } as unknown as Socket;

      await gateway.handleSubscribeGroup(client, { group_ride_id: RIDE_ID });

      expect(client.join).toHaveBeenCalledWith(`group-ride:${RIDE_ID}`);
    });

    it('rejects members whose group_rides entitlement is off (kill switch parity with REST)', async () => {
      featureResolver.resolveForUser.mockResolvedValueOnce(
        buildFeatureSnapshot('free', {}, { group_rides: 'force_off' }),
      );
      groupRideMemberRepo.findOne.mockResolvedValueOnce({
        id: 'm-1',
        group_ride_id: RIDE_ID,
        user_id: 'user-1',
        group_ride: { id: RIDE_ID, ended_at: null },
      });
      const client = {
        id: 'c-1',
        data: { userId: 'user-1' },
        rooms: new Set(['c-1']),
        join: jest.fn(),
        emit: jest.fn(),
      } as unknown as Socket;

      await gateway.handleSubscribeGroup(client, { group_ride_id: RIDE_ID });

      expect(client.join).not.toHaveBeenCalled();
      expect(client.emit).toHaveBeenCalledWith(
        'error',
        expect.objectContaining({
          message: 'Feature unavailable: group_rides',
        }),
      );
    });

    it('fails closed when the entitlement lookup throws', async () => {
      featureResolver.resolveForUser.mockRejectedValueOnce(
        new Error('user vanished'),
      );
      groupRideMemberRepo.findOne.mockResolvedValueOnce({
        id: 'm-1',
        group_ride_id: RIDE_ID,
        user_id: 'user-1',
        group_ride: { id: RIDE_ID, ended_at: null },
      });
      const client = {
        id: 'c-1',
        data: { userId: 'user-1' },
        rooms: new Set(['c-1']),
        join: jest.fn(),
        emit: jest.fn(),
      } as unknown as Socket;

      await gateway.handleSubscribeGroup(client, { group_ride_id: RIDE_ID });

      expect(client.join).not.toHaveBeenCalled();
      expect(client.emit).toHaveBeenCalledWith('error', expect.any(Object));
    });

    it('refuses to join when the ride has already ended', async () => {
      // Reconnecting member of a ride that ended while they were
      // offline: membership row survives but the room is dead. We
      // tell them explicitly so the screen can drop to the idle
      // state — without this, `group:ended` had already fired before
      // they reconnected and they'd sit in an "active" UI forever.
      groupRideMemberRepo.findOne.mockResolvedValueOnce({
        id: 'm-1',
        group_ride_id: RIDE_ID,
        user_id: 'user-1',
        group_ride: { id: RIDE_ID, ended_at: new Date() },
      });
      const client = {
        id: 'c-1',
        data: { userId: 'user-1' },
        rooms: new Set(['c-1']),
        join: jest.fn(),
        emit: jest.fn(),
      } as unknown as Socket;

      await gateway.handleSubscribeGroup(client, { group_ride_id: RIDE_ID });

      expect(client.join).not.toHaveBeenCalled();
      expect(client.emit).toHaveBeenCalledWith(
        'error',
        expect.objectContaining({ message: 'Group ride has ended' }),
      );
    });

    it('is idempotent for an already-joined client', async () => {
      const client = {
        id: 'c-1',
        data: { userId: 'user-1' },
        rooms: new Set(['c-1', `group-ride:${RIDE_ID}`]),
        join: jest.fn(),
        emit: jest.fn(),
      } as unknown as Socket;

      await gateway.handleSubscribeGroup(client, { group_ride_id: RIDE_ID });

      expect(groupRideMemberRepo.findOne).not.toHaveBeenCalled();
      expect(client.join).not.toHaveBeenCalled();
    });
  });

  describe('handleGroupPosition (US-26)', () => {
    const RIDE_ID = '11111111-1111-1111-1111-111111111111';

    function makeMembership(): Record<string, unknown> {
      return {
        id: 'm-1',
        group_ride_id: RIDE_ID,
        user_id: 'user-1',
        recent_path: [],
        group_ride: { id: RIDE_ID, ended_at: null },
      };
    }

    it('does nothing when sender is not in the room (broadcast scoping)', async () => {
      const mockTo = jest.fn().mockReturnValue({ emit: jest.fn() });
      const client = {
        id: 'c-1',
        data: { userId: 'user-1' },
        rooms: new Set(['c-1']), // not in `group-ride:...`
        to: mockTo,
        leave: jest.fn(),
      } as unknown as Socket;

      await gateway.handleGroupPosition(client, {
        group_ride_id: RIDE_ID,
        lat: 49.1,
        lng: 16.5,
      });

      expect(groupRideMemberRepo.findOne).not.toHaveBeenCalled();
      expect(mockTo).not.toHaveBeenCalled();
    });

    it('drops the update and detaches the client when the entitlement is revoked mid-ride', async () => {
      featureResolver.resolveForUser.mockResolvedValueOnce(
        buildFeatureSnapshot('free', {}, { group_rides: 'force_off' }),
      );
      groupRideMemberRepo.findOne.mockResolvedValueOnce(makeMembership());
      const emit = jest.fn();
      const mockTo = jest.fn().mockReturnValue({ emit });
      const client = {
        id: 'c-1',
        data: { userId: 'user-1' },
        rooms: new Set(['c-1', `group-ride:${RIDE_ID}`]),
        to: mockTo,
        leave: jest.fn(),
      } as unknown as Socket;

      await gateway.handleGroupPosition(client, {
        group_ride_id: RIDE_ID,
        lat: 49.1,
        lng: 16.5,
      });

      expect(groupRideMemberRepo.update).not.toHaveBeenCalled();
      expect(mockTo).not.toHaveBeenCalled();
      expect(client.leave).toHaveBeenCalledWith(`group-ride:${RIDE_ID}`);
    });

    it('persists the position and broadcasts to the room (excluding sender)', async () => {
      groupRideMemberRepo.findOne.mockResolvedValueOnce(makeMembership());
      const emit = jest.fn();
      const mockTo = jest.fn().mockReturnValue({ emit });
      const client = {
        id: 'c-1',
        data: { userId: 'user-1' },
        rooms: new Set(['c-1', `group-ride:${RIDE_ID}`]),
        to: mockTo,
        leave: jest.fn(),
      } as unknown as Socket;

      await gateway.handleGroupPosition(client, {
        group_ride_id: RIDE_ID,
        lat: 49.1,
        lng: 16.5,
        speed: 80,
        heading: 180,
      });

      expect(groupRideMemberRepo.update).toHaveBeenCalledWith(
        { id: 'm-1' },
        expect.objectContaining({
          last_lat: 49.1,
          last_lng: 16.5,
          last_speed: 80,
          last_heading: 180,
        }),
      );
      const updateCall = groupRideMemberRepo.update.mock.calls[0]?.[1] as {
        last_position_at: Date;
        recent_path: { lat: number; lng: number; at: string }[];
      };
      expect(updateCall.last_position_at).toBeInstanceOf(Date);
      expect(updateCall.recent_path).toEqual([
        { lat: 49.1, lng: 16.5, at: expect.any(String) as string },
      ]);
      // `client.to(room)` excludes sender — that's the AC for "fan out
      // to group members only" (the sender already has their own
      // position locally).
      expect(mockTo).toHaveBeenCalledWith(`group-ride:${RIDE_ID}`);
      expect(emit).toHaveBeenCalledWith(
        'group:position',
        expect.objectContaining({
          group_ride_id: RIDE_ID,
          user_id: 'user-1',
          lat: 49.1,
          lng: 16.5,
        }),
      );
    });

    it('drops the second update inside the throttle window', async () => {
      groupRideMemberRepo.findOne.mockResolvedValue(makeMembership());
      const emit = jest.fn();
      const mockTo = jest.fn().mockReturnValue({ emit });
      const client = {
        id: 'c-1',
        data: { userId: 'user-1' },
        rooms: new Set(['c-1', `group-ride:${RIDE_ID}`]),
        to: mockTo,
        leave: jest.fn(),
      } as unknown as Socket;

      const payload = {
        group_ride_id: RIDE_ID,
        lat: 49.1,
        lng: 16.5,
      };
      await gateway.handleGroupPosition(client, payload);
      await gateway.handleGroupPosition(client, payload);

      expect(emit).toHaveBeenCalledTimes(1);
    });

    it('claims the throttle slot synchronously so concurrent ticks bail', async () => {
      // Regression: previously the throttle entry was written AFTER the
      // membership await. Two ticks arriving in the same event-loop turn
      // would both pass the synchronous check, both await in parallel,
      // and both broadcast — bypassing the 1 Hz floor.
      let resolveFindOne!: (value: Record<string, unknown>) => void;
      groupRideMemberRepo.findOne.mockImplementation(
        () =>
          new Promise<Record<string, unknown>>((r) => {
            resolveFindOne = r;
          }),
      );
      const emit = jest.fn();
      const mockTo = jest.fn().mockReturnValue({ emit });
      const client = {
        id: 'c-1',
        data: { userId: 'user-1' },
        rooms: new Set(['c-1', `group-ride:${RIDE_ID}`]),
        to: mockTo,
        leave: jest.fn(),
      } as unknown as Socket;

      const payload = {
        group_ride_id: RIDE_ID,
        lat: 49.1,
        lng: 16.5,
      };
      // Fire two handlers without awaiting — the second must observe
      // the throttle entry the first wrote synchronously and exit
      // before doing any DB work.
      const first = gateway.handleGroupPosition(client, payload);
      const second = gateway.handleGroupPosition(client, payload);

      // Second already short-circuited, so even one resolve drains
      // every outstanding lookup. (`findOne` is only invoked once.)
      resolveFindOne(makeMembership());
      await Promise.all([first, second]);

      expect(groupRideMemberRepo.findOne).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledTimes(1);
    });

    it('drops broadcasts after the ride has ended', async () => {
      groupRideMemberRepo.findOne.mockResolvedValueOnce({
        ...makeMembership(),
        group_ride: { id: RIDE_ID, ended_at: new Date() },
      });
      const emit = jest.fn();
      const mockTo = jest.fn().mockReturnValue({ emit });
      const leave = jest.fn();
      const client = {
        id: 'c-1',
        data: { userId: 'user-1' },
        rooms: new Set(['c-1', `group-ride:${RIDE_ID}`]),
        to: mockTo,
        leave,
      } as unknown as Socket;

      await gateway.handleGroupPosition(client, {
        group_ride_id: RIDE_ID,
        lat: 49.1,
        lng: 16.5,
      });

      // Sender is detached so subsequent ticks short-circuit before
      // the DB lookup.
      expect(leave).toHaveBeenCalledWith(`group-ride:${RIDE_ID}`);
      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('broadcastToGroupRide (US-26)', () => {
    const RIDE_ID = '11111111-1111-1111-1111-111111111111';

    it('emits to the group ride room', () => {
      gateway.broadcastToGroupRide(RIDE_ID, 'group:joined', { user_id: 'u' });
      expect(mockServer.to).toHaveBeenCalledWith(`group-ride:${RIDE_ID}`);
      expect(mockServer.emit).toHaveBeenCalledWith('group:joined', {
        user_id: 'u',
      });
    });
  });
});
