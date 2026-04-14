import { IsString, IsOptional, IsBoolean, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateContactDto {
  @ApiProperty({ example: 'Jane Doe' })
  @IsString()
  @MaxLength(100)
  name: string;

  @ApiProperty({ example: '+420123456789' })
  @IsString()
  @MaxLength(20)
  phone: string;

  @ApiProperty({ default: true, required: false })
  @IsOptional()
  @IsBoolean()
  is_emergency?: boolean;
}
