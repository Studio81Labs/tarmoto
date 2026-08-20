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
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { Ride } from '../../entities/ride.entity.js';
import { TripMember } from '../../entities/trip-member.entity.js';
import { GroupRideMember } from '../../entities/group-ride-member.entity.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';
import { ConcurrencyLimiter } from '../../common/concurrency-limiter.js';
import { RedisIoAdapter } from './redis-io.adapter.js';

// Shared between subscribe handlers so a malformed id never reaches a
// UUID column and bubbles up as a Postgres "invalid input syntax"
// error instead of a controlled socket error.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * Payload emitted on `trip:cursor` when a collaborator moves their
 * pointer over the trip planner map. Ephemeral — never persisted.
 * Identity comes from the authenticated socket so clients can't spoof
 * each other.
 */
export interface TripCursorPayload {
  user_id: string;
  trip_id: string;
  lat: number;
  lng: number;
  at: string;
}

/** Payload emitted when a member joins/leaves a trip's live room. */
export interface TripPresencePayload {
  trip_id: string;
  user_id: string;
  online: boolean;
  at: string;
}

/**
 * US-26 — wire shape of the `group:position` event. Used in both
 * directions: clients emit `{ group_ride_id, lat, lng, speed?, heading? }`
 * to publish their own position; the server fans out the same event
 * with `user_id` and `at` filled in from the authenticated socket so
 * peers cannot spoof identity.
 */
export interface GroupPositionPayload {
  group_ride_id: string;
  user_id: string;
  lat: number;
  lng: number;
  speed: number | null;
  heading: number | null;
  at: string;
}

// US-26 — capped breadcrumb buffer. Keeps `recent_path` bounded for
// long rides (a 4-hour ride at 1 Hz would otherwise persist 14k points
// to JSONB on every position update).
const GROUP_RIDE_PATH_LIMIT = 60;

// Server-side throttle floor for `group:position`. The AC caps publishes
// to ≤ 1 Hz; a misbehaving client could otherwise flood the channel and
// chew through other riders' cellular bandwidth. Tracked in-memory per
// process — multi-instance deploys still bound the per-process fanout.
const GROUP_POSITION_THROTTLE_MS = 1000;

// US-35 — server-side throttle floor for `trip:cursor`. Companions
// already throttle to ~7 Hz client-side, but the gateway must enforce
// its own ≤ 10 Hz cap (100 ms) per the US-35 acceptance criterion so a
// misbehaving or hostile client can't flood every other collaborator
// with unbounded mouse-move fanout. Drop, don't queue — collaborators
// only need the latest position.
const TRIP_CURSOR_THROTTLE_MS = 100;

// Bounds `evictNonEntitledFromGroupRideRooms`'s per-distinct-rider
// `resolveForUser` resolution (#1104 review, PR #1287): the admin-triggered
// path already tolerates a fully serial resolution because it runs off one
// HTTP request, but the startup sweep in `onApplicationBootstrap` can face
// the WHOLE cluster's active group-ride membership, and serial resolution
// there scales both DB load and wall time linearly with it. A small,
// fixed cap keeps a busy cluster's sweep bounded without needing a config
// knob for a codepath that only ever touches connected-socket counts.
const GROUP_RIDES_EVICTION_SWEEP_CONCURRENCY = 10;

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
    OnApplicationBootstrap
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(EventsGateway.name);
  // Per `(group_ride_id, user_id)` last-broadcast timestamp used to
  // enforce the 1 Hz floor on `group:position` events. See
  // `GROUP_POSITION_THROTTLE_MS`.
  private readonly groupPositionThrottle = new Map<string, number>();
  // Per `(trip_id, user_id)` last-broadcast timestamp used to enforce
  // the ~12 Hz floor on `trip:cursor` fanout. See
  // `TRIP_CURSOR_THROTTLE_MS`.
  private readonly tripCursorThrottle = new Map<string, number>();

  constructor(
    private readonly jwt: JwtService,
    @InjectRepository(Ride)
    private readonly rideRepo: Repository<Ride>,
    @InjectRepository(TripMember)
    private readonly tripMemberRepo: Repository<TripMember>,
    // The `GroupRide` entity is registered in `EventsModule` so the
    // `relations: { group_ride: true }` lookup below resolves, but the
    // gateway never needs to query it directly — every membership +
    // active-state read goes through `groupRideMemberRepo`.
    @InjectRepository(GroupRideMember)
    private readonly groupRideMemberRepo: Repository<GroupRideMember>,
    private readonly featureResolver: FeatureResolver,
  ) {}

  /**
   * Live `group_rides` entitlement check for the socket path. The REST
   * surface is enforced by `FeatureGuard` on `/group-rides/*`; the
   * gateway must apply the same rule or a global `force_off` (kill
   * switch) / tier revoke would only block HTTP while existing members
   * kept streaming positions over Socket.IO. Fails closed: a resolver
   * error (e.g. the account was deleted mid-session) counts as
   * not-entitled.
   */
  private async hasGroupRidesFeature(userId: string): Promise<boolean> {
    try {
      const features = await this.featureResolver.resolveForUser(userId);
      return features.group_rides;
    } catch {
      return false;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async afterInit(server: Server): Promise<void> {
    // Redis adapter is wired via RedisIoAdapter in main.ts. This hook
    // must exist for OnGatewayInit but the adapter is already configured
    // before createIOServer runs.
  }

  /**
   * Startup sweep that closes the gap `AdminFlagsService.clearGlobalState`
   * already covers for the admin-triggered path (#1104 review, migration
   * 1839): a raw-SQL migration that removes the `group_rides` launch-mode
   * override changes the DB row, but can't reach this gateway's in-memory
   * Socket.IO room state. During a rolling deploy an OLD instance can keep
   * serving already-connected passive listeners the live-location fanout
   * after the DB says they're no longer entitled. `evictNonEntitledFrom
   * GroupRideRooms` is cluster-wide via the Redis adapter's `fetchSockets`/
   * `leave`, so it only needs to run once, on whichever instance's bootstrap
   * reaches this hook first — a no-op when nobody is non-entitled.
   *
   * Deliberately NOT awaited (Codex P2, PR #1287 review): the sweep's cost
   * scales with the WHOLE cluster's active group-ride listeners, resolved
   * at bounded concurrency (see `evictNonEntitledFromGroupRideRooms`) but
   * still not free, and `onApplicationBootstrap` is awaited before
   * `app.listen()` in `main.ts` — a busy cluster could otherwise make a
   * rolling-deploy container miss its readiness deadline over a startup
   * task that exists purely as a best-effort safety net. Fire-and-forget
   * keeps the sweep off the startup critical path; a resolver hiccup or
   * fetch failure only logs.
   *
   * Scope is logged honestly rather than skipped (Codex P1, PR #1287
   * review — "the sweep trusts an incomplete local view"): when THIS
   * process never attached the Redis adapter (`RedisIoAdapter.
   * connectRedis` is a single best-effort attempt in `main.ts` with no
   * later retry — see its own doc comment — so a `false` reading here is
   * permanent for this process's lifetime), `fetchSockets()` only reaches
   * this instance's own local sockets. Skipping the sweep entirely in that
   * case would be WORSE, not safer: those local sockets are equally
   * invisible to every OTHER instance's cluster-wide sweep (the in-memory
   * fallback isn't part of any Redis mesh), so nobody else will ever evict
   * them either. Running the local sweep anyway still correctly evicts the
   * sockets this instance can see; the warning exists so an operator does
   * not read "sweep ran" as proof the WHOLE fleet is clean.
   */
  onApplicationBootstrap(): void {
    if (!RedisIoAdapter.isClusterAdapterActive) {
      this.logger.warn(
        'Startup group-rides eviction sweep is running in LOCAL-ONLY mode ' +
          '(no Redis adapter attached this boot) — only sockets connected ' +
          'to THIS instance are covered; other instances in the fleet are ' +
          'not reached and must be swept independently (their own boot, or ' +
          'the admin clearGlobalState endpoint).',
      );
    }
    void this.evictNonEntitledFromGroupRideRooms().catch((err: unknown) => {
      this.logger.warn(
        `Startup group-rides eviction sweep failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
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
    const userId = (client.data as Record<string, unknown>).userId as
      string | undefined;
    const joinedTrips = (client.data as Record<string, unknown>).joinedTrips as
      Set<string> | undefined;

    if (userId && joinedTrips && joinedTrips.size > 0) {
      // Announce offline to every trip room this socket had joined.
      // Other sockets for the same user may still be in the room — the
      // client is responsible for de-duplicating presence by `user_id`
      // and its own known-online socket count.
      const at = new Date().toISOString();
      for (const tripId of joinedTrips) {
        const payload: TripPresencePayload = {
          trip_id: tripId,
          user_id: userId,
          online: false,
          at,
        };
        this.server.to(`trip:${tripId}`).emit('trip:presence', payload);
        // Drop the cursor-throttle slot so a future reconnect from the
        // same user starts fresh — without this, an in-window
        // disconnect would force the next reconnect's first cursor to
        // be dropped because the stale timestamp is still ≤ 83 ms old.
        this.tripCursorThrottle.delete(`${tripId}:${userId}`);
      }
    }

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
   * Leave every hazard room. Clients emit this when they stop showing hazard
   * alerts (rider toggle, or the `hazard_alerts` kill switch flipping to
   * `force_off` on a live session): the sweep in `handleSubscribeHazards`
   * only runs on the NEXT subscribe, and after a kill no next subscribe is
   * coming — without this the server keeps emitting `hazard:new` to a client
   * that ignores it (#1160). No payload; membership is per-socket.
   */
  @SubscribeMessage('unsubscribe:hazards')
  handleUnsubscribeHazards(@ConnectedSocket() client: Socket): void {
    for (const room of client.rooms) {
      if (room.startsWith('hazards:')) {
        client.leave(room);
      }
    }
    this.logger.debug(`Client ${client.id} unsubscribed from hazards`);
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
      string | undefined;
    if (!userId) {
      client.emit('error', { message: 'Authentication required' });
      return;
    }

    if (!data.ride_id || typeof data.ride_id !== 'string') {
      client.emit('error', { message: 'ride_id is required' });
      return;
    }

    // Same entitlement as /group-rides/* — a room join is the gate for
    // the legacy ride-room sharing path (`location:update` fanout only
    // reaches sockets already in the room).
    if (!(await this.hasGroupRidesFeature(userId))) {
      client.emit('error', { message: 'Feature unavailable: group_rides' });
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
  async handleLocationUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      ride_id: string;
      lat: number;
      lng: number;
      speed?: number;
      heading?: number;
    },
  ): Promise<void> {
    const userId = (client.data as Record<string, unknown>).userId as
      string | undefined;
    if (!userId) return;

    // Verify client is a member of this ride room
    const rideRoom = `ride:${data.ride_id}`;
    if (!client.rooms.has(rideRoom)) return;

    // Re-check the group_rides entitlement on every update, same as the
    // group:position path: room membership was granted at subscribe
    // time, and without this re-check a client already in the room
    // would keep broadcasting after a force_off / tier revoke. Detach
    // on failure so subsequent sends short-circuit on the room check
    // instead of re-resolving.
    if (!(await this.hasGroupRidesFeature(userId))) {
      client.leave(rideRoom);
      return;
    }

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
      string | undefined;
    if (!userId) {
      client.emit('error', { message: 'Authentication required' });
      return;
    }

    if (!data?.trip_id || typeof data.trip_id !== 'string') {
      client.emit('error', { message: 'trip_id is required' });
      return;
    }

    // Reject anything that doesn't look like a UUID before we hit the
    // DB — `trip_id` is a UUID column and a malformed value (e.g.
    // "abc") would otherwise surface to the client as a server-side
    // `invalid input syntax for type uuid` error instead of a
    // controlled socket error.
    if (!UUID_PATTERN.test(data.trip_id)) {
      client.emit('error', { message: 'trip_id must be a UUID' });
      return;
    }

    // Idempotent per socket. Clients replay `subscribe:trip` on every
    // `connect` (see companion `lib/socket.ts#subscribedTripIds`) and
    // can also issue duplicate subscribes mid-flight. Without this
    // guard a second subscribe would emit another `online: true` while
    // `handleDisconnect` only emits one `online: false`, leaving the
    // client-side per-user socket counter permanently above zero.
    const room = `trip:${data.trip_id}`;
    if (client.rooms?.has(room)) return;

    const membership = await this.tripMemberRepo.findOne({
      where: { trip_id: data.trip_id, user_id: userId },
    });
    if (!membership) {
      client.emit('error', { message: 'Trip not found or access denied' });
      return;
    }

    client.join(room);
    // Record the joined trips on the socket so `handleDisconnect` can
    // emit `trip:presence { online: false }` to every room without
    // having to parse the room name set. Using the socket's `data` bag
    // keeps the bookkeeping tied to the socket lifetime automatically.
    const joinedTrips = (client.data as Record<string, unknown>).joinedTrips as
      Set<string> | undefined;
    const trips = joinedTrips ?? new Set<string>();
    trips.add(data.trip_id);
    (client.data as Record<string, unknown>).joinedTrips = trips;

    const presence: TripPresencePayload = {
      trip_id: data.trip_id,
      user_id: userId,
      online: true,
      at: new Date().toISOString(),
    };
    this.server.to(room).emit('trip:presence', presence);
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
    const userId = (client.data as Record<string, unknown>).userId as
      string | undefined;
    const room = `trip:${data.trip_id}`;
    if (!client.rooms.has(room)) return;

    client.leave(room);
    const joinedTrips = (client.data as Record<string, unknown>).joinedTrips as
      Set<string> | undefined;
    joinedTrips?.delete(data.trip_id);

    if (userId) {
      const presence: TripPresencePayload = {
        trip_id: data.trip_id,
        user_id: userId,
        online: false,
        at: new Date().toISOString(),
      };
      this.server.to(room).emit('trip:presence', presence);
      // Same rationale as in `handleDisconnect` — stale cursor-throttle
      // entries from a prior session would otherwise eat the first
      // tick after a re-subscribe.
      this.tripCursorThrottle.delete(`${data.trip_id}:${userId}`);
    }
  }

  /**
   * Broadcast a live cursor position to other collaborators in the trip
   * room. The sender is excluded via `client.to()` so they don't receive
   * their own echoes. Identity is taken from the authenticated socket —
   * clients cannot spoof `user_id`. Silently ignores cursors for rooms
   * the client hasn't been granted membership to, to prevent cross-trip
   * leakage if a misbehaving client emits to a room it was never in.
   *
   * Server-side throttling caps fanout at ≤ 10 Hz per (trip, user) per
   * the US-35 acceptance criterion. The companion already throttles
   * client-side, but the gateway must enforce its own floor so a
   * misbehaving or hostile client can't chew through every other
   * collaborator's bandwidth. Drops are silent — cursors only carry
   * the latest position, so queueing stale ticks would just lag the
   * rendered dot.
   */
  @SubscribeMessage('trip:cursor')
  handleTripCursor(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { trip_id: string; lat: number; lng: number },
  ): void {
    const userId = (client.data as Record<string, unknown>).userId as
      string | undefined;
    if (!userId) return;
    if (!data?.trip_id) return;
    if (typeof data.lat !== 'number' || typeof data.lng !== 'number') return;

    const room = `trip:${data.trip_id}`;
    if (!client.rooms.has(room)) return;

    const throttleKey = `${data.trip_id}:${userId}`;
    const nowMs = Date.now();
    const last = this.tripCursorThrottle.get(throttleKey) ?? 0;
    if (nowMs - last < TRIP_CURSOR_THROTTLE_MS) return;
    this.tripCursorThrottle.set(throttleKey, nowMs);

    const payload: TripCursorPayload = {
      user_id: userId,
      trip_id: data.trip_id,
      lat: data.lat,
      lng: data.lng,
      at: new Date(nowMs).toISOString(),
    };
    client.to(room).emit('trip:cursor', payload);
  }

  /**
   * US-26 — subscribe to a group ride room so the client receives the
   * `group:position`, `group:joined`, `group:left`, and `group:ended`
   * fanout for that ride. Membership is verified against the database
   * rather than the trip room pattern's "owner-only" check, because
   * group rides are explicitly multi-member by design.
   *
   * Folds non-membership into a generic 404-ish error rather than a
   * specific "you're not a member" so the endpoint cannot be used to
   * probe whether a given group_ride_id exists at all.
   */
  @SubscribeMessage('subscribe:group')
  async handleSubscribeGroup(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { group_ride_id: string },
  ): Promise<void> {
    const userId = (client.data as Record<string, unknown>).userId as
      string | undefined;
    if (!userId) {
      client.emit('error', { message: 'Authentication required' });
      return;
    }
    if (!data?.group_ride_id || typeof data.group_ride_id !== 'string') {
      client.emit('error', { message: 'group_ride_id is required' });
      return;
    }
    if (!UUID_PATTERN.test(data.group_ride_id)) {
      client.emit('error', { message: 'group_ride_id must be a UUID' });
      return;
    }

    const room = `group-ride:${data.group_ride_id}`;
    if (client.rooms.has(room)) return;

    const [entitled, membership] = await Promise.all([
      this.hasGroupRidesFeature(userId),
      this.groupRideMemberRepo.findOne({
        where: { group_ride_id: data.group_ride_id, user_id: userId },
        relations: { group_ride: true },
      }),
    ]);
    if (!entitled) {
      client.emit('error', { message: 'Feature unavailable: group_rides' });
      return;
    }
    if (!membership) {
      client.emit('error', {
        message: 'Group ride not found or access denied',
      });
      return;
    }

    // Membership rows survive ride termination (we keep them so a
    // GET /group-rides/:id can still surface who was in the ride),
    // but a client reconnecting after `group:ended` already fired
    // would otherwise join a dead room and get stuck "active" with
    // no further events to nudge it back to idle. Refuse the join
    // and tell the client explicitly so the screen can drop back
    // to the create/join form.
    if (membership.group_ride.ended_at !== null) {
      client.emit('error', { message: 'Group ride has ended' });
      return;
    }

    client.join(room);
    this.logger.debug(
      `Client ${client.id} joined group ride ${data.group_ride_id}`,
    );
  }

  @SubscribeMessage('unsubscribe:group')
  handleUnsubscribeGroup(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { group_ride_id: string },
  ): void {
    if (!data?.group_ride_id || typeof data.group_ride_id !== 'string') return;
    const room = `group-ride:${data.group_ride_id}`;
    if (!client.rooms.has(room)) return;
    client.leave(room);
  }

  /**
   * US-26 — accept a position publish from a member, persist the last-
   * known position + a capped breadcrumb trail, then fan out
   * `group:position` to every other member in the room.
   *
   * Identity is taken from the authenticated socket (clients can't
   * spoof `user_id`). The 1 Hz throttle is enforced server-side because
   * we can't trust clients to honour it — a buggy build would
   * otherwise flood the channel and starve everyone else's bandwidth.
   * Persistence happens BEFORE broadcast so a `GET /group-rides/:id`
   * issued immediately after by a reconnecting client always reflects
   * at least the last accepted point.
   *
   * Silently drops messages from clients that aren't in the room. We
   * intentionally don't echo errors back here — a flapping connection
   * should fail closed without spamming the client with errors on every
   * dropped tick.
   */
  @SubscribeMessage('group:position')
  async handleGroupPosition(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      group_ride_id: string;
      lat: number;
      lng: number;
      speed?: number;
      heading?: number;
    },
  ): Promise<void> {
    const userId = (client.data as Record<string, unknown>).userId as
      string | undefined;
    if (!userId) return;
    if (!data?.group_ride_id) return;
    if (typeof data.lat !== 'number' || typeof data.lng !== 'number') return;
    if (!UUID_PATTERN.test(data.group_ride_id)) return;

    const room = `group-ride:${data.group_ride_id}`;
    if (!client.rooms.has(room)) return;

    const throttleKey = `${data.group_ride_id}:${userId}`;
    const nowMs = Date.now();
    const last = this.groupPositionThrottle.get(throttleKey) ?? 0;
    if (nowMs - last < GROUP_POSITION_THROTTLE_MS) return;

    // Claim the slot SYNCHRONOUSLY, before yielding on the membership
    // lookup. If we wrote `nowMs` only after the await, two ticks
    // arriving within the same event-loop turn would both pass the
    // check above, then both await in parallel, then both broadcast —
    // bypassing the 1 Hz floor that's the trust boundary for the
    // bandwidth budget. Setting it first means concurrent ticks see
    // the updated timestamp and bail before doing any DB work.
    this.groupPositionThrottle.set(throttleKey, nowMs);

    // Re-verify membership, active state, AND the group_rides
    // entitlement on every accepted update. A client that joined the
    // socket room then was kicked from the ride (or whose ride ended,
    // or whose feature was force_off'd / tier-revoked) must stop
    // publishing — without this re-check, the gateway would continue
    // broadcasting their points until the connection drops, making the
    // kill switch only cover HTTP.
    const [entitled, membership] = await Promise.all([
      this.hasGroupRidesFeature(userId),
      this.groupRideMemberRepo.findOne({
        where: { group_ride_id: data.group_ride_id, user_id: userId },
        relations: { group_ride: true },
      }),
    ]);
    if (!entitled || !membership || membership.group_ride.ended_at !== null) {
      // Race: either left, or the owner ended the ride. Detach the
      // client from the room so subsequent ticks short-circuit before
      // hitting the DB. Drop the throttle entry so the next position
      // attempt — which we'll silently swallow on the room-membership
      // check — doesn't sit in the map forever.
      this.groupPositionThrottle.delete(throttleKey);
      client.leave(room);
      return;
    }

    const at = new Date(nowMs);
    const point = { lat: data.lat, lng: data.lng, at: at.toISOString() };
    const path = Array.isArray(membership.recent_path)
      ? [...membership.recent_path, point]
      : [point];
    if (path.length > GROUP_RIDE_PATH_LIMIT) {
      path.splice(0, path.length - GROUP_RIDE_PATH_LIMIT);
    }

    await this.groupRideMemberRepo.update(
      { id: membership.id },
      {
        last_lat: data.lat,
        last_lng: data.lng,
        last_speed: data.speed ?? null,
        last_heading: data.heading ?? null,
        last_position_at: at,
        recent_path: path,
      },
    );

    const payload: GroupPositionPayload = {
      group_ride_id: data.group_ride_id,
      user_id: userId,
      lat: data.lat,
      lng: data.lng,
      speed: data.speed ?? null,
      heading: data.heading ?? null,
      at: at.toISOString(),
    };
    // `client.to(room)` excludes the sender — they already have their
    // own position locally and re-rendering their own dot from the
    // round-tripped event would visibly lag.
    client.to(room).emit('group:position', payload);
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
   * Evict a user's sockets (or, with no argument, every socket) from
   * group-ride rooms after a `group_rides` entitlement revoke. The
   * publisher-side re-checks stop revoked members from SENDING, but a
   * passive listener would otherwise keep RECEIVING the room's position
   * fanout until they publish or disconnect — a revoke must cut off the
   * sensitive location stream live. Covers both the US-26
   * (`group-ride:<id>`) and legacy (`ride:<id>`) rooms; works across
   * cluster nodes because the Redis adapter's `fetchSockets`/`leave`
   * operate on remote sockets too.
   */
  async evictFromGroupRideRooms(userId?: string): Promise<void> {
    const scope = userId ? this.server.in(`user:${userId}`) : this.server;
    const sockets = await scope.fetchSockets();
    for (const socket of sockets) {
      for (const room of socket.rooms) {
        if (room.startsWith('group-ride:') || room.startsWith('ride:')) {
          socket.leave(room);
        }
      }
    }
  }

  /**
   * Selective variant for entitlement-policy changes that revoke SOME
   * users (e.g. clearing the launch-mode `force_on` so tier enforcement
   * goes live): re-resolves each connected room member and evicts only
   * those who no longer hold `group_rides` — kicking still-entitled
   * premium riders too would silently break their live screens (clients
   * don't re-subscribe on an unexpected room eviction). Sockets without
   * an authenticated user id fail closed.
   *
   * Resolution runs at bounded concurrency (Codex P2, PR #1287 review): a
   * caller with many distinct room members — the `onApplicationBootstrap`
   * startup sweep in particular — must not serialize one `resolveForUser`
   * (3 DB reads) after another; that scales DB load and wall time linearly
   * with room membership. `GROUP_RIDES_EVICTION_SWEEP_CONCURRENCY` caps how
   * many resolutions run at once instead.
   */
  async evictNonEntitledFromGroupRideRooms(): Promise<void> {
    const sockets = await this.server.fetchSockets();
    // One resolution per distinct user, not per socket — collected as a
    // first pass so the resolution pass below can run them concurrently
    // instead of interleaving with the fetch.
    const roomsBySocket = new Map<(typeof sockets)[number], string[]>();
    const distinctUserIds = new Set<string>();
    for (const socket of sockets) {
      const rooms = [...socket.rooms].filter(
        (room) => room.startsWith('group-ride:') || room.startsWith('ride:'),
      );
      if (rooms.length === 0) continue;
      roomsBySocket.set(socket, rooms);
      const userId = (socket.data as Record<string, unknown> | undefined)
        ?.userId as string | undefined;
      if (userId) distinctUserIds.add(userId);
    }

    const limiter = new ConcurrencyLimiter(
      GROUP_RIDES_EVICTION_SWEEP_CONCURRENCY,
    );
    const entitledByUser = new Map<string, boolean>(
      await Promise.all(
        [...distinctUserIds].map(async (userId): Promise<[string, boolean]> => {
          try {
            const entitled = await limiter.run(
              async () =>
                (await this.featureResolver.resolveForUser(userId)).group_rides,
            );
            return [userId, entitled];
          } catch {
            // Fail closed — an unresolvable user keeps no live stream.
            return [userId, false];
          }
        }),
      ),
    );

    for (const [socket, rooms] of roomsBySocket) {
      const userId = (socket.data as Record<string, unknown> | undefined)
        ?.userId as string | undefined;
      const entitled = userId ? (entitledByUser.get(userId) ?? false) : false;
      if (!entitled) {
        for (const room of rooms) socket.leave(room);
      }
    }
  }

  /**
   * Broadcast to all connected clients.
   */
  broadcast(event: string, data: unknown): void {
    this.server.emit(event, data);
  }

  /**
   * Kick a user's live sockets out of a trip room. Membership is only
   * checked when `subscribe:trip` is handled, so without this a member
   * removed by the owner would keep receiving `trip:*` broadcasts until
   * they disconnected. Each evicted socket also gets a `trip:evicted`
   * event so an open planner can react instead of silently going stale.
   */
  async evictFromTrip(tripId: string, userId: string): Promise<void> {
    const room = `trip:${tripId}`;
    const sockets = await this.server.in(room).fetchSockets();
    for (const socket of sockets) {
      if ((socket.data as Record<string, unknown>).userId !== userId) {
        continue;
      }
      socket.leave(room);
      socket.emit('trip:evicted', { trip_id: tripId });
      // Keep the per-socket bookkeeping honest so the disconnect
      // handler doesn't broadcast a presence-left event for a trip the
      // socket was already evicted from. Local adapter only — with a
      // remote adapter the data mutation is best-effort.
      const joined = (socket.data as Record<string, unknown>).joinedTrips;
      if (joined instanceof Set) joined.delete(tripId);
    }
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

  /**
   * US-26 — broadcast a non-position event (`group:joined`, `group:left`,
   * `group:ended`) to every client subscribed to a group ride room.
   * Position fanout uses `client.to(...)` inside the socket handler so
   * the sender doesn't echo themselves; everything else uses this
   * `server.to(...)` form because every member should see the event,
   * including whoever triggered it via REST.
   *
   * Also drops the throttle bookkeeping for the ride when it ends so a
   * future ride with a coincidentally-matching id can't inherit stale
   * state.
   */
  broadcastToGroupRide(
    groupRideId: string,
    event: string,
    data: unknown,
  ): void {
    this.server.to(`group-ride:${groupRideId}`).emit(event, data);
    if (event === 'group:ended') {
      for (const key of this.groupPositionThrottle.keys()) {
        if (key.startsWith(`${groupRideId}:`)) {
          this.groupPositionThrottle.delete(key);
        }
      }
    }
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
