/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { EventsGateway } from './events.gateway.js';
import { Server, Socket } from 'socket.io';

describe('EventsGateway', () => {
  let gateway: EventsGateway;
  let jwtService: jest.Mocked<JwtService>;

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
      ],
    }).compile();

    gateway = module.get<EventsGateway>(EventsGateway);
    jwtService = module.get(JwtService);
    gateway.server = mockServer;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('handleConnection', () => {
    it('should authenticate client with valid token', async () => {
      jwtService.verifyAsync.mockResolvedValueOnce({ sub: 'user-1' });

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
      jwtService.verifyAsync.mockResolvedValueOnce({ sub: 'user-2' });

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
        join: jest.fn(),
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
        join: jest.fn(),
      } as unknown as Socket;

      gateway.handleSubscribeHazards(client, {
        lat: 49.15,
        lng: 16.75,
        radius_m: 10000,
      });

      expect(client.join).toHaveBeenCalledTimes(9);
      expect(client.join).toHaveBeenCalledWith('hazards:491:167');
      expect(client.join).toHaveBeenCalledWith('hazards:490:166');
      expect(client.join).toHaveBeenCalledWith('hazards:492:168');
    });
  });

  describe('handleSubscribeGroupRide', () => {
    it('should join ride room for authenticated client', () => {
      const client = {
        id: 'client-1',
        data: { userId: 'user-1' },
        join: jest.fn(),
        emit: jest.fn(),
      } as unknown as Socket;

      gateway.handleSubscribeGroupRide(client, {
        ride_id: 'ride-1',
      });

      expect(client.join).toHaveBeenCalledWith('ride:ride-1');
    });

    it('should reject unauthenticated client', () => {
      const client = {
        id: 'client-2',
        data: {},
        join: jest.fn(),
        emit: jest.fn(),
      } as unknown as Socket;

      gateway.handleSubscribeGroupRide(client, {
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
  });
});
