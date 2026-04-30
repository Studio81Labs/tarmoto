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
 * A "10k+ ridden segments" snapshot at ~80 bytes/segment fits well below this,
 * but the cap prevents an abusive client from pushing megabyte-scale blobs
 * into the row.
 */
export const MAX_MAP_SNAPSHOT_BYTES = 2_000_000;

@ValidatorConstraint({ name: 'mapSnapshotSize', async: false })
class MapSnapshotSizeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) return false;
    try {
      return (
        Buffer.byteLength(JSON.stringify(value), 'utf8') <=
        MAX_MAP_SNAPSHOT_BYTES
      );
    } catch {
      return false;
    }
  }

  defaultMessage(): string {
    return `Map snapshot exceeds ${MAX_MAP_SNAPSHOT_BYTES} bytes`;
  }
}

export class CreateMapShareDto {
  @ApiProperty({
    description: 'Display title for the shared road map (shown in listings).',
    minLength: 1,
    maxLength: 200,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiProperty({
    description:
      'Snapshot of the rider exploration state at share time (totals + ridden segment ids/metadata). Stored as JSONB and returned verbatim to public viewers.',
    type: 'object',
    additionalProperties: true,
  })
  @IsObject()
  @Validate(MapSnapshotSizeConstraint)
  snapshot!: Record<string, unknown>;
}

export class MapShareResponseDto {
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

export class MapSharePublicDto {
  @ApiProperty()
  share_token!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  owner_name!: string;

  @ApiProperty({
    description:
      'The full road-map snapshot as captured at share time. Shape mirrors the companion `MapShareSnapshot` type; not validated server-side.',
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

export class MapShareListResponseDto {
  @ApiProperty({ type: [MapShareResponseDto] })
  items!: MapShareResponseDto[];

  @ApiProperty()
  total!: number;
}
