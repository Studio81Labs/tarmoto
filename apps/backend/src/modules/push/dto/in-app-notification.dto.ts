import { ApiProperty } from '@nestjs/swagger';
import type {
  InAppNotification,
  InAppNotificationListResponse,
  NotificationCategory,
} from '@tarmoto/shared';

export class InAppNotificationDto implements InAppNotification {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    enum: [
      'hazard_alert',
      'crash_followup',
      'trip_collaboration',
      'new_follower',
      'ride_like',
      'route_comment',
      'weather_alert',
      'subscription_billing',
    ],
  })
  category!: NotificationCategory;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  body!: string;

  @ApiProperty({ additionalProperties: { type: 'string' } })
  data!: Record<string, string>;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  read_at!: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;
}

export class InAppNotificationListResponseDto implements InAppNotificationListResponse {
  @ApiProperty({ type: InAppNotificationDto, isArray: true })
  items!: InAppNotificationDto[];

  @ApiProperty()
  unread_count!: number;
}
