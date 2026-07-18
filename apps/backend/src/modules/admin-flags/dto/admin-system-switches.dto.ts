import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Admin wire shapes for system switches (operator kill toggles, default
 * ON). The switch vocabulary is code-defined (`FEATURE_DEFINITIONS`); the
 * only operator action is disable (write force_off) / enable (clear). */

export class AdminSystemSwitchDto {
  @ApiProperty({ description: 'Registry system-switch key.' })
  key!: string;

  @ApiProperty() description!: string;

  @ApiProperty({ description: 'Resolved state — false when disabled.' })
  enabled!: boolean;

  @ApiProperty({
    nullable: true,
    description: 'Why it was disabled (only when disabled).',
  })
  disabled_reason!: string | null;

  @ApiProperty({ nullable: true }) disabled_by!: string | null;
  @ApiProperty({ nullable: true }) disabled_at!: string | null;
}

export class AdminSystemSwitchesResponseDto {
  @ApiProperty({ type: [AdminSystemSwitchDto] })
  switches!: AdminSystemSwitchDto[];
}

export class SetSystemSwitchDisabledDto {
  @ApiProperty({
    maxLength: 500,
    description:
      'Why the subsystem is being disabled — always required (a kill ' +
      'switch must carry incident context). Stored on the row, not audited.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
