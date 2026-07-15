import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsString } from 'class-validator';
import { EMAIL_BLOCK_TYPES } from '@tarmoto/shared';

/**
 * Wire form of the shared `EmailBlock` union (see
 * `packages/shared/src/email-blocks.ts`). Documentation/type shape only —
 * never class-validator-nested-validated. The single source of truth for
 * deep block-shape rules is `validateBlockDocument`, called from the service.
 */
export class EmailBlockDto {
  @ApiProperty({ enum: EMAIL_BLOCK_TYPES, description: 'Block kind.' })
  type!: (typeof EMAIL_BLOCK_TYPES)[number];

  @ApiPropertyOptional({
    description: 'heading/paragraph text; may contain whitelisted {vars}.',
  })
  text?: string;

  @ApiPropertyOptional({
    description: 'button/stat-row label; may contain {vars}.',
  })
  label?: string;

  @ApiPropertyOptional({
    description: 'button target — a whitelisted url var key.',
  })
  urlVar?: string;

  @ApiPropertyOptional({ description: 'stat-row value; may contain {vars}.' })
  value?: string;
}

export class EmailTemplateWhitelistDto {
  @ApiProperty({ type: [String] }) textVars!: string[];
  @ApiProperty({ type: [String] }) urlVars!: string[];
}

export class EmailTemplateSummaryDto {
  @ApiProperty() tag!: string;
  @ApiProperty() label!: string;
  @ApiProperty() hasDraft!: boolean;
  @ApiProperty() hasPublished!: boolean;
  @ApiProperty() legalSensitive!: boolean;
}

export class EmailTemplateDetailDto {
  @ApiProperty() tag!: string;
  @ApiProperty() locale!: string;
  @ApiProperty() subject!: string;

  @ApiProperty({ type: [EmailBlockDto] })
  blocks!: EmailBlockDto[];

  @ApiProperty({ enum: ['draft', 'published', 'none'] })
  status!: 'draft' | 'published' | 'none';

  @ApiProperty() version!: number;

  @ApiProperty({ type: EmailTemplateWhitelistDto })
  whitelist!: EmailTemplateWhitelistDto;
}

export class EmailTemplateVersionDto {
  @ApiProperty() version!: number;

  @ApiProperty({ enum: ['published', 'archived'] })
  status!: 'published' | 'archived';

  // Always present in the response; value may be null (system/seed rows) →
  // ApiProperty + nullable so the generated client types it `string | null`,
  // not an optional `string | null | undefined`.
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Publisher email; null = system/seed.',
  })
  author!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'ISO timestamp the version went live; null if never.',
  })
  publishedAt!: string | null;

  @ApiProperty() subject!: string;

  @ApiProperty({ type: [EmailBlockDto] })
  blocks!: EmailBlockDto[];
}

export class SaveDraftDto {
  @ApiProperty({
    description: 'Plain-text subject; may contain whitelisted {vars}.',
  })
  @IsString()
  subject!: string;

  @ApiProperty({
    type: [EmailBlockDto],
    description:
      'Block document body; deep shape validated by validateBlockDocument in the service.',
  })
  @IsArray()
  blocks!: unknown[];
}

export class PreviewRequestDto {
  @ApiProperty({
    description: 'Plain-text subject; may contain whitelisted {vars}.',
  })
  @IsString()
  subject!: string;

  @ApiProperty({
    type: [EmailBlockDto],
    description:
      'Block document body; deep shape validated by validateBlockDocument in the service.',
  })
  @IsArray()
  blocks!: unknown[];
}

export class PreviewResponseDto {
  @ApiProperty() subject!: string;
  @ApiProperty() html!: string;
  @ApiProperty() text!: string;
}

export class TestSendResponseDto {
  @ApiProperty({ enum: ['sent', 'failed'] })
  status!: 'sent' | 'failed';
}
