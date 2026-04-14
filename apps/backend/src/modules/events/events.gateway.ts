import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';

@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/events',
})
export class EventsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(EventsGateway.name);

  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
  ) {}

  async afterInit(server: Server): Promise<void> {
    const redisHost = this.config.get<string>('redis.host', 'localhost');
    const redisPort = this.config.get<number>('redis.port', 6379);

    try {
      const pubClient = createClient({
        url: `redis://${redisHost}:${redisPort}`,
      });
      const subClient = pubClient.duplicate();
      await Promise.all([pubClient.connect(), subClient.connect()]);
      server.adapter(createAdapter(pubClient, subClient));
      this.logger.log(`Redis adapter connected (${redisHost}:${redisPort})`);
    } catch (err) {
      this.logger.warn(
        'Redis adapter not available, falling back to in-memory',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async handleConnection(client: Socket): Promise<void> {
    const token = this.extractToken(client);
    if (!token) {
      this.logger.debug(`Client ${client.id} connected (anonymous)`);
      return;
    }

    try {
      const payload = await this.jwt.verifyAsync<{ sub: string }>(token);
      (client.data as Record<string, unknown>).userId = payload.sub;
      // Join user-specific room for targeted events
      await client.join(`user:${payload.sub}`);
      this.logger.debug(`Client ${client.id} authenticated as ${payload.sub}`);
    } catch {
      this.logger.debug(`Client ${client.id} connected (invalid token)`);
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`Client ${client.id} disconnected`);
  }

  /**
   * Subscribe to hazard alerts in a geographic area.
   * Client sends: { lat, lng, radius_m }
   */
  @SubscribeMessage('subscribe:hazards')
  async handleSubscribeHazards(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { lat: number; lng: number; radius_m?: number },
  ): Promise<void> {
    // Create a geohash-based room for the area (simplified: grid cell)
    const cellId = this.toGridCell(data.lat, data.lng);
    await client.join(`hazards:${cellId}`);
    this.logger.debug(
      `Client ${client.id} subscribed to hazards in cell ${cellId}`,
    );
  }

  /**
   * Subscribe to group ride location updates.
   * Client sends: { ride_id }
   */
  @SubscribeMessage('subscribe:group-ride')
  async handleSubscribeGroupRide(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { ride_id: string },
  ): Promise<void> {
    await client.join(`ride:${data.ride_id}`);
    this.logger.debug(`Client ${client.id} joined group ride ${data.ride_id}`);
  }

  /**
   * Share location update within a group ride.
   * Client sends: { ride_id, lat, lng, speed, heading }
   */
  @SubscribeMessage('location:update')
  handleLocationUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      ride_id: string;
      lat: number;
      lng: number;
      speed?: number;
      heading?: number;
    },
  ): void {
    const userId = (client.data as Record<string, unknown>).userId as
      | string
      | undefined;
    if (!userId) return;

    this.server.to(`ride:${data.ride_id}`).emit('rider:location', {
      user_id: userId,
      lat: data.lat,
      lng: data.lng,
      speed: data.speed,
      heading: data.heading,
      timestamp: new Date().toISOString(),
    });
  }

  // ── Server-side emit methods (called by other services) ──

  /**
   * Broadcast a new hazard alert to all clients in the area.
   */
  emitHazardAlert(
    lat: number,
    lng: number,
    hazard: {
      id: string;
      hazard_type: string;
      severity: string;
      lat: number;
      lng: number;
    },
  ): void {
    const cellId = this.toGridCell(lat, lng);
    this.server.to(`hazards:${cellId}`).emit('hazard:new', hazard);
  }

  /**
   * Send a targeted event to a specific user.
   */
  emitToUser(userId: string, event: string, data: unknown): void {
    this.server.to(`user:${userId}`).emit(event, data);
  }

  /**
   * Broadcast to all connected clients.
   */
  broadcast(event: string, data: unknown): void {
    this.server.emit(event, data);
  }

  // ── Helpers ──

  private extractToken(client: Socket): string | undefined {
    const auth = client.handshake.auth?.token as string | undefined;
    if (auth) return auth;

    const header = client.handshake.headers.authorization;
    if (header?.startsWith('Bearer ')) return header.slice(7);

    return undefined;
  }

  /**
   * Simple grid cell ID for geographic subscription.
   * Groups nearby clients into ~11km cells (0.1 degree).
   */
  private toGridCell(lat: number, lng: number): string {
    const latCell = Math.floor(lat * 10);
    const lngCell = Math.floor(lng * 10);
    return `${latCell}:${lngCell}`;
  }
}
