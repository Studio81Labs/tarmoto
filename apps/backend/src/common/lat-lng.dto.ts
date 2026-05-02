import { ApiProperty } from '@nestjs/swagger';

/**
 * Reusable lat/lng response shape. Hand-rolled per-DTO local classes
 * generate distinct schemas in the OpenAPI spec, which then become
 * three nominally-distinct types on the typed-client side. Re-exporting
 * one named `LatLngResponseDto` keeps the spec compact and lets
 * consumers compare positions structurally without per-feature aliases.
 */
export class LatLngResponseDto {
  @ApiProperty()
  lat!: number;

  @ApiProperty()
  lng!: number;
}
