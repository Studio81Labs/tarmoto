import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';
import { User } from '../../entities/user.entity.js';
import { TileTokenResponseDto } from './dto/tile-token.dto.js';

/**
 * Lifetime of a tile token. Deliberately much shorter than the 1 h access
 * token it is minted from: the tile token travels in the QUERY STRING of every
 * vector-tile request, so it lands in CDN and reverse-proxy access logs. Short
 * enough that a log leak ages out fast, long enough that a rider panning a map
 * mints roughly four per hour.
 */
export const TILE_TOKEN_EXPIRY_SECONDS = 15 * 60;

/**
 * `type` claim that separates a tile token from an access or refresh token.
 * Every access-token verifier in the backend (`AuthGuard`, `OptionalAuthGuard`,
 * `UserScopedThrottlerGuard`) requires `type === 'access'`, so a leaked tile
 * token authenticates NOTHING beyond the tile clamp below — it cannot read a
 * profile, mint a refresh, or reach any other route.
 */
const TILE_TOKEN_TYPE = 'tile';

interface TileTokenPayload {
  sub: string;
  type: string;
}

/**
 * Mints and resolves the scoped tile token that carries rider identity into
 * `GET /roads/tiles/:z/:x/:y.mvt` (#1279).
 *
 * WHY A TOKEN IN THE URL RATHER THAN THE ACCESS BEARER IN A HEADER — the two
 * live map consumers are MapLibre tile sources, and neither can safely carry
 * the account bearer:
 *
 *  - **Companion (browser):** `Authorization` is not a CORS-safelisted header,
 *    so a cross-origin tile fetch that carries it needs a preflight, and the
 *    CORS preflight cache is keyed BY URL — every one of the ~40 tiles in a
 *    viewport would pay an extra round trip. A query parameter needs none.
 *  - **Mobile (native):** MapLibre's request transforms are registered on the
 *    shared native HTTP stack that also fetches the OpenFreeMap basemap. Both
 *    the header and the search-param transform are URL-scoped by a `match`
 *    regex, but only the search param keeps the blast radius of a mis-scoped
 *    regex down to a 15-minute tile token instead of the account bearer.
 *
 * The `Authorization` header path stays live and unchanged (#1108) — the
 * mobile offline-pack downloader issues plain HTTP requests where per-request
 * headers are both available and strictly safer than a URL parameter.
 */
@Injectable()
export class TileTokenService {
  constructor(
    private readonly jwt: JwtService,
    @InjectEntityManager()
    private readonly em: EntityManager,
  ) {}

  /** Mint a tile token for an already-authenticated rider. */
  async issue(userId: string): Promise<TileTokenResponseDto> {
    const token = await this.jwt.signAsync(
      { sub: userId, type: TILE_TOKEN_TYPE },
      { expiresIn: TILE_TOKEN_EXPIRY_SECONDS },
    );
    return { token, expires_in: TILE_TOKEN_EXPIRY_SECONDS };
  }

  /**
   * Resolve the rider behind a tile token, or `null` for anything that does
   * not resolve — absent, malformed, expired, wrong token type, or an account
   * that has since been soft-deleted.
   *
   * NEVER THROWS, and that is the load-bearing property: a tile request is one
   * of ~40 in a viewport with no client-side retry path, so a stale credential
   * must degrade the map to the anonymous (free-capped) view rather than fail
   * it. `null` is also the most-clamped answer, so every failure mode narrows.
   *
   * The soft-delete read mirrors `OptionalAuthGuard` exactly (one indexed PK
   * lookup) so both identity channels revoke a deleted account on the same
   * request rather than at the next token rotation.
   */
  async resolveUserId(token: string | undefined): Promise<string | null> {
    if (!token) return null;

    let payload: TileTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<TileTokenPayload>(token);
    } catch {
      // Expired or forged: anonymous, exactly like OptionalAuthGuard treats a
      // stale bearer on an optional-auth route.
      return null;
    }
    if (payload.type !== TILE_TOKEN_TYPE) return null;
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      return null;
    }

    const account = await this.em.findOne(User, {
      where: { id: payload.sub },
      select: { id: true, deleted_at: true },
    });
    if (!account || account.deleted_at != null) return null;

    return payload.sub;
  }
}
