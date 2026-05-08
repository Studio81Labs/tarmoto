import {
  IsHexColor,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export const MAX_TRIP_FOLDER_NAME_LENGTH = 120;

/**
 * US-37 — payload for `POST /trip-folders`. The new folder is appended
 * to the end of the user's list (server allocates `position` so the
 * client doesn't need to know the current count).
 *
 * `color` is an optional CSS hex string (`#rrggbb` or `#rgb`). The
 * client renders the swatch; the server stores it verbatim. We hex-
 * validate to keep `'red'` / `'tomato'` / `'oklch(...)'` strings out of
 * the column so a downstream consumer can rely on the format.
 */
export class CreateTripFolderDto {
  @ApiProperty({ minLength: 1, maxLength: MAX_TRIP_FOLDER_NAME_LENGTH })
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_TRIP_FOLDER_NAME_LENGTH)
  name!: string;

  @ApiProperty({
    required: false,
    nullable: true,
    description:
      'Optional hex colour (e.g. `#22d3ee`). Used by the client to render the folder chip; stored verbatim.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsHexColor()
  color?: string | null;
}

/**
 * Partial update — at least one of `name` / `color` / `position` should
 * be provided. The service returns the unchanged folder when the body is
 * empty (consistent with the trip PATCH endpoint).
 */
export class UpdateTripFolderDto {
  @ApiProperty({
    required: false,
    minLength: 1,
    maxLength: MAX_TRIP_FOLDER_NAME_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_TRIP_FOLDER_NAME_LENGTH)
  name?: string;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Hex colour or `null` to clear the colour.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsHexColor()
  color?: string | null;

  @ApiProperty({
    required: false,
    minimum: 0,
    description:
      'Zero-based target position. The server shifts neighbouring folders so the renumber stays dense within the user.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
}

export class TripFolderResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  user_id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ nullable: true })
  color!: string | null;

  @ApiProperty()
  position!: number;

  @ApiProperty()
  created_at!: string;

  @ApiProperty()
  updated_at!: string;
}

export class TripFolderListResponseDto {
  @ApiProperty({ type: [TripFolderResponseDto] })
  items!: TripFolderResponseDto[];

  @ApiProperty()
  total!: number;
}
