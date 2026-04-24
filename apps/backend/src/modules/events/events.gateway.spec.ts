/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { EventsGateway } from './events.gateway.js';
import { Ride } from '../../entities/ride.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { Server, Socket } from 'socket.io';

describe('EventsGateway', () => {
  let gateway: EventsGateway;
  let jwtService: jest.Mocked<JwtService>;
  let rideRepo: { findOne: jest.Mock };
  let tripMemberRepo: { findOne: jest.Mock };

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
      ],
    }).compile();

    gateway = module.get<EventsGateway>(EventsGateway);
    jwtService = module.get(JwtService);
    rideRepo = module.get(getRepositoryToken(Ride));
    tripMemberRepo = module.get(getRepositoryToken(TripMember));
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
    it('should broadcast to ride room excluding sender', () => {
      const mockTo = jest.fn().mockReturnValue({ emit: jest.fn() });
      const client = {
        id: 'client-1',
        data: { userId: 'user-1' },
        rooms: new Set(['client-1', 'ride:ride-1']),
        to: mockTo,
      } as unknown as Socket;

      gateway.handleLocationUpdate(client, {
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

    it('should reject authenticated client not in ride room', () => {
      const mockTo = jest.fn();
      const client = {
        id: 'client-1',
        data: { userId: 'user-1' },
        rooms: new Set(['client-1']), // not in ride:ride-1
        to: mockTo,
      } as unknown as Socket;

      gateway.handleLocationUpdate(client, {
        ride_id: 'ride-1',
        lat: 49.1,
        lng: 16.75,
      });

      expect(mockTo).not.toHaveBeenCalled();
    });

    it('should ignore unauthenticated clients', () => {
      const mockTo = jest.fn();
      const client = {
        id: 'client-2',
        data: {},
        rooms: new Set(['client-2']),
        to: mockTo,
      } as unknown as Socket;

      gateway.handleLocationUpdate(client, {
        ride_id: 'ride-1',
        lat: 49.1,
        lng: 16.75,
      });

      expect(mockTo).not.toHaveBeenCalled();
    });
  });

  describe('server-side emit methods', () => {
    it('emitHazardAlert should broadcast to correct grid cell', () => {
      gateway.emitHazardAlert(49.1, 16.75, {
        id: 'h-1',
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
});
