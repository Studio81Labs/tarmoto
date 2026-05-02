import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Body of `POST /trips/from-share` (#357).
 *
 * The mobile client opens the deep link
 * `tarmoto://trips/import?tripId=...&token=...`, fetches the share for the
 * preview UI, and on confirmation posts the token here. The backend reads
 * the snapshot stored under that token in `trip_shares` and reconstructs
 * the original multi-day trip (one `trip_days` row per snapshot day),
 * preserving the day breakdown that `POST /trips/import` collapses into a
 * single planned day.
 *
 * The token is the source of truth — the snapshot is read from the row,
 * not the request — so a revoked or rewritten share can never be replayed
 * by an old client and the request body stays small (just a 32-char hex
 * id), no special body-parser limit needed.
 */
export class FromShareTripDto {
  @ApiProperty({
    description:
      'The 32-char hex share token returned by `POST /trip-shares` and ' +
      'consumed by the `tarmoto://trips/import?token=...` deep link.',
    minLength: 1,
    maxLength: 64,
  })
  @IsString()
  @MinLength(1)
  // 64 leaves headroom over the 32-char hex token the server mints today
  // without making the column-side guarantee load-bearing for input
  // validation. Hex/url-safe-base64 chars only — anything else is a
  // typo or an attempt to smuggle a control char into the lookup.
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: 'share_token must be alphanumeric (with optional - and _)',
  })
  share_token!: string;
}
