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
    it('should join grid cell room', async () => {
      const client = {
        id: 'client-1',
        join: jest.fn(),
      } as unknown as Socket;

      await gateway.handleSubscribeHazards(client, {
        lat: 49.15,
        lng: 16.75,
      });

      // 49.15 * 10 = 491.5 → floor = 491, 16.75 * 10 = 167.5 → floor = 167
      expect(client.join).toHaveBeenCalledWith('hazards:491:167');
    });
  });

  describe('handleSubscribeGroupRide', () => {
    it('should join ride room', async () => {
      const client = {
        id: 'client-1',
        join: jest.fn(),
      } as unknown as Socket;

      await gateway.handleSubscribeGroupRide(client, {
        ride_id: 'ride-1',
      });

      expect(client.join).toHaveBeenCalledWith('ride:ride-1');
    });
  });

  describe('handleLocationUpdate', () => {
    it('should broadcast location to ride room', () => {
      const client = {
        id: 'client-1',
        data: { userId: 'user-1' },
      } as unknown as Socket;

      gateway.handleLocationUpdate(client, {
        ride_id: 'ride-1',
        lat: 49.1,
        lng: 16.75,
        speed: 15,
        heading: 180,
      });

      expect(mockServer.to).toHaveBeenCalledWith('ride:ride-1');
      expect(mockServer.emit).toHaveBeenCalledWith(
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

    it('should ignore unauthenticated clients', () => {
      const client = {
        id: 'client-2',
        data: {},
      } as unknown as Socket;

      gateway.handleLocationUpdate(client, {
        ride_id: 'ride-1',
        lat: 49.1,
        lng: 16.75,
      });

      expect(mockServer.to).not.toHaveBeenCalled();
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
