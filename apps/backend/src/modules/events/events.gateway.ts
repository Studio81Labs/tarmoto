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
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';
import { Ride } from '../../entities/ride.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';

/**
 * Wire shape of the `hazard:new` WebSocket event. Must stay structurally
 * compatible with HazardResponseDto so clients can render markers directly
 * from the event without a follow-up REST fetch.
 */
export interface HazardAlertPayload {
  id: string;
  lat: number;
  lng: number;
  hazard_type: string;
  severity: string;
  note: string | null;
  confirmations: number;
  reporter: string | null;
  road_name: string | null;
  created_at: string;
  expires_at: string;
}

@SkipThrottle()
@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/events',
})
export class EventsGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleDestroy
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(EventsGateway.name);
  private pubClient: ReturnType<typeof createClient> | null = null;
  private subClient: ReturnType<typeof createClient> | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
    @InjectRepository(Ride)
    private readonly rideRepo: Repository<Ride>,
    @InjectRepository(TripMember)
    private readonly tripMemberRepo: Repository<TripMember>,
  ) {}

  async afterInit(server: Server): Promise<void> {
    const redisHost = this.config.get<string>('redis.host', 'localhost');
    const redisPort = this.config.get<number>('redis.port', 6379);

    const pub = createClient({ url: `redis://${redisHost}:${redisPort}` });
    const sub = pub.duplicate();

    try {
      await Promise.all([pub.connect(), sub.connect()]);
      this.pubClient = pub;
      this.subClient = sub;
      server.adapter(createAdapter(pub, sub));
      this.logger.log(`Redis adapter connected (${redisHost}:${redisPort})`);
    } catch (err) {
      // Clean up any partially connected clients
      await pub.close().catch(() => {});
      await sub.close().catch(() => {});
      this.pubClient = null;
      this.subClient = null;
      this.logger.warn(
        'Redis adapter not available, falling back to in-memory',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    // Gracefully close independently so one failure doesn't skip the other
    if (this.pubClient) {
      await this.pubClient.close().catch(() => {});
    }
    if (this.subClient) {
      await this.subClient.close().catch(() => {});
    }
  }

  async handleConnection(client: Socket): Promise<void> {
    const token = this.extractToken(client);
    if (!token) {
      this.logger.debug(`Client ${client.id} connected (anonymous)`);
      return;
    }

    try {
      const payload = await this.jwt.verifyAsync<{
        sub: string;
        type: string;
      }>(token);
      // Only accept access tokens — reject refresh tokens
      if (payload.type !== 'access') {
        this.logger.debug(
          `Client ${client.id} connected (wrong token type: ${payload.type})`,
        );
        return;
      }
      (client.data as Record<string, unknown>).userId = payload.sub;
      client.join(`user:${payload.sub}`);
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
  handleSubscribeHazards(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { lat: number; lng: number; radius_m?: number },
  ): void {
    // Leave previously joined hazard rooms to avoid accumulation
    for (const room of client.rooms) {
      if (room.startsWith('hazards:')) {
        client.leave(room);
      }
    }

    // Subscribe to the center cell plus adjacent cells to cover radius
    const cells = this.getCoveringCells(data.lat, data.lng, data.radius_m);
    const rooms = cells.map((c) => `hazards:${c}`);
    for (const room of rooms) {
      client.join(room);
    }
    this.logger.debug(
      `Client ${client.id} subscribed to hazards in ${rooms.length} cells`,
    );
  }

  /**
   * Subscribe to group ride location updates.
   * Requires authentication — ride positions are sensitive.
   * Client sends: { ride_id }
   */
  @SubscribeMessage('subscribe:group-ride')
  async handleSubscribeGroupRide(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { ride_id: string },
  ): Promise<void> {
    const userId = (client.data as Record<string, unknown>).userId as
      | string
      | undefined;
    if (!userId) {
      client.emit('error', { message: 'Authentication required' });
      return;
    }

    if (!data.ride_id || typeof data.ride_id !== 'string') {
      client.emit('error', { message: 'ride_id is required' });
      return;
    }

    // Verify user is the ride owner (ride participants would need a
    // ride_members table in future for full group ride support)
    const ride = await this.rideRepo.findOne({
      where: { id: data.ride_id, user_id: userId },
    });
    if (!ride) {
      client.emit('error', { message: 'Ride not found or access denied' });
      return;
    }

    client.join(`ride:${data.ride_id}`);
    this.logger.debug(`Client ${client.id} joined group ride ${data.ride_id}`);
  }

  /**
   * Share location update within a group ride.
   * Uses client.to() to exclude the sender from receiving their own update.
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

    // Verify client is a member of this ride room
    const rideRoom = `ride:${data.ride_id}`;
    if (!client.rooms.has(rideRoom)) return;

    // client.to() excludes the sender, unlike server.to()
    client.to(rideRoom).emit('rider:location', {
      user_id: userId,
      lat: data.lat,
      lng: data.lng,
      speed: data.speed,
      heading: data.heading,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Subscribe the client to a trip room so they receive live updates
   * when other members edit the trip, post suggestions, vote, or chat.
   * Membership is enforced before the join — non-members get an error
   * back rather than a silent success (which would look like the server
   * accepted them but just never emit anything).
   *
   * Client sends: { trip_id }
   */
  @SubscribeMessage('subscribe:trip')
  async handleSubscribeTrip(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { trip_id: string },
  ): Promise<void> {
    const userId = (client.data as Record<string, unknown>).userId as
      | string
      | undefined;
    if (!userId) {
      client.emit('error', { message: 'Authentication required' });
      return;
    }

    if (!data?.trip_id || typeof data.trip_id !== 'string') {
      client.emit('error', { message: 'trip_id is required' });
      return;
    }

    const membership = await this.tripMemberRepo.findOne({
      where: { trip_id: data.trip_id, user_id: userId },
    });
    if (!membership) {
      client.emit('error', { message: 'Trip not found or access denied' });
      return;
    }

    client.join(`trip:${data.trip_id}`);
    this.logger.debug(`Client ${client.id} joined trip ${data.trip_id}`);
  }

  /**
   * Leave a trip room. Useful when the user navigates away from a trip
   * detail screen so they don't accumulate updates for trips they're no
   * longer viewing.
   *
   * Client sends: { trip_id }
   */
  @SubscribeMessage('unsubscribe:trip')
  handleUnsubscribeTrip(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { trip_id: string },
  ): void {
    if (!data?.trip_id || typeof data.trip_id !== 'string') return;
    client.leave(`trip:${data.trip_id}`);
  }

  // ── Server-side emit methods (called by other services) ──

  /**
   * Broadcast a new hazard alert to all clients in the area. The payload is
   * the full hazard response — clients render markers (note, confirmations,
   * created_at, expires_at, …) directly from this event without a
   * follow-up REST fetch, so every field must be present.
   */
  emitHazardAlert(lat: number, lng: number, hazard: HazardAlertPayload): void {
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

  /**
   * Emit an event to every member currently subscribed to a trip room.
   * Generic over the event name so collab features (suggestions, votes,
   * chat, metadata updates) can reuse the same transport without having
   * to add one public method per event.
   */
  emitToTrip(tripId: string, event: string, data: unknown): void {
    this.server.to(`trip:${tripId}`).emit(event, data);
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

  /**
   * Get all grid cells that cover a radius around a point.
   * Returns the center cell + adjacent cells if radius exceeds half a cell.
   * Each cell is ~11km, so radius > 5500m needs neighbors.
   */
  private getCoveringCells(
    lat: number,
    lng: number,
    radiusM?: number,
  ): string[] {
    const centerLatCell = Math.floor(lat * 10);
    const centerLngCell = Math.floor(lng * 10);
    const center = `${centerLatCell}:${centerLngCell}`;

    // Default or small radius: center cell only
    if (!radiusM || radiusM <= 5500) {
      return [center];
    }

    // Larger radius: include all 8 neighbors (3x3 grid)
    const cells: string[] = [];
    for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLng = -1; dLng <= 1; dLng++) {
        cells.push(`${centerLatCell + dLat}:${centerLngCell + dLng}`);
      }
    }
    return cells;
  }
}
