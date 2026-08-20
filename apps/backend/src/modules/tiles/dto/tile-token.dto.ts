import { ApiProperty } from '@nestjs/swagger';

/**
 * A short-lived, tile-scoped credential the map clients append to vector-tile
 * URLs so `road_quality_max_zoom` resolves against the rider rather than the
 * anonymous free tier (#1279). It authenticates nothing else — see
 * `TileTokenService`.
 */
export class TileTokenResponseDto {
  @ApiProperty({
    description:
      'Opaque tile credential. Send it as the `tile_token` query parameter ' +
      'on GET /roads/tiles/:z/:x/:y.mvt. Never usable as an access token.',
  })
  token!: string;

  @ApiProperty({
    description:
      'Seconds until the token expires — the same relative form the auth ' +
      "responses use, so a client's clock offset cannot mistime rotation.",
    example: 900,
  })
  expires_in!: number;
}
