import {
  IsObject,
  IsString,
  MaxLength,
  MinLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Upper bound on the serialised snapshot JSON.
 *
 * A multi-day planner trip with full route geometry is comfortably under this,
 * but we cap explicitly so a malformed client (or an abusive one) can't wedge
 * a 50 MB blob into the row.
 */
export const MAX_TRIP_SNAPSHOT_BYTES = 1_000_000;

@ValidatorConstraint({ name: 'snapshotSize', async: false })
class SnapshotSizeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) return false;
    try {
      // Serialised length is what we actually persist; measuring object
      // shape is misleading once JSONB enters the picture.
      return JSON.stringify(value).length <= MAX_TRIP_SNAPSHOT_BYTES;
    } catch {
      return false;
    }
  }

  defaultMessage(): string {
    return `Trip snapshot exceeds ${MAX_TRIP_SNAPSHOT_BYTES} bytes`;
  }
}

export class CreateTripShareDto {
  @ApiProperty({
    description: 'Display title for the shared trip (shown in listings).',
    minLength: 1,
    maxLength: 200,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiProperty({
    description:
      'Full client-side trip snapshot (days, waypoints, route geometry). Stored as JSONB and returned verbatim to public viewers.',
    type: 'object',
    additionalProperties: true,
  })
  @IsObject()
  @Validate(SnapshotSizeConstraint)
  snapshot!: Record<string, unknown>;
}

export class TripShareResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  share_token!: string;

  @ApiProperty()
  share_url!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  view_count!: number;

  @ApiProperty()
  created_at!: string;

  @ApiProperty()
  updated_at!: string;
}

export class TripSharePublicDto {
  @ApiProperty()
  share_token!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  owner_name!: string;

  @ApiProperty({
    description:
      'The full trip snapshot as captured at share time. Shape mirrors the companion `Trip` type; not validated server-side, the viewer renders it as-is.',
    type: 'object',
    additionalProperties: true,
  })
  snapshot!: Record<string, unknown>;

  @ApiProperty({
    description: 'Total times this token has been fetched (post-increment).',
  })
  view_count!: number;

  @ApiProperty()
  created_at!: string;

  @ApiProperty()
  updated_at!: string;
}

export class TripShareListResponseDto {
  @ApiProperty({ type: [TripShareResponseDto] })
  items!: TripShareResponseDto[];

  @ApiProperty()
  total!: number;
}
