import { ApiProperty } from '@nestjs/swagger';
import { HAZARD_PHOTO_EXPIRED } from '@tarmoto/shared';

/**
 * Body shape of the 409 raised by `POST /hazards` when the report tries to
 * attach a managed photo whose upload the orphan sweep already reclaimed (the
 * report sat queued past the 24h grace window). Documents the machine-readable
 * `code` so generated consumers can implement the required recovery — re-upload
 * from the retained local source and resubmit — without string-matching the
 * message. Mirrors the object passed to `ConflictException` in
 * `hazards.service.ts` (`hazardPhotoExpired`).
 */
export class HazardPhotoExpiredDto {
  @ApiProperty({ example: 409 })
  statusCode!: number;

  @ApiProperty({ example: 'Conflict' })
  error!: string;

  @ApiProperty({
    example:
      'The attached photo upload expired before the report was submitted; ' +
      're-upload the photo and resubmit.',
  })
  message!: string;

  @ApiProperty({
    example: HAZARD_PHOTO_EXPIRED,
    description:
      'Stable discriminator for an expired managed-photo attachment. Always ' +
      `"${HAZARD_PHOTO_EXPIRED}". The client re-uploads from its retained ` +
      'local photo URI and resubmits the report.',
  })
  code!: string;
}
