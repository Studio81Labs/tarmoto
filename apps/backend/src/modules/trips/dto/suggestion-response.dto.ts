import { ApiProperty } from '@nestjs/swagger';

export class SuggestionDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  trip_id!: string;

  @ApiProperty({ nullable: true })
  trip_day_id!: string | null;

  @ApiProperty()
  suggested_by!: string;

  @ApiProperty()
  suggester_display_name!: string;

  @ApiProperty({ nullable: true })
  road_segment_id!: string | null;

  @ApiProperty()
  title!: string;

  @ApiProperty({ nullable: true })
  description!: string | null;

  @ApiProperty({ nullable: true })
  lat!: number | null;

  @ApiProperty({ nullable: true })
  lng!: number | null;

  @ApiProperty({ enum: ['open', 'accepted', 'rejected'] })
  status!: string;

  @ApiProperty()
  up_votes!: number;

  @ApiProperty()
  down_votes!: number;

  @ApiProperty({
    enum: ['up', 'down'],
    nullable: true,
    description: "The caller's vote, or null if they haven't voted.",
  })
  caller_vote!: 'up' | 'down' | null;

  @ApiProperty()
  created_at!: string;

  @ApiProperty()
  updated_at!: string;
}
