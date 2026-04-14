import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { UserContact } from '../../entities/user-contact.entity.js';
import { User } from '../../entities/user.entity.js';
import { CrashAlertDto, CrashAlertResponseDto } from './dto/crash-alert.dto.js';
import { EventsGateway } from '../events/events.gateway.js';

@Injectable()
export class SafetyService {
  private readonly logger = new Logger(SafetyService.name);

  constructor(
    @InjectRepository(UserContact)
    private readonly contactRepo: Repository<UserContact>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly eventsGateway: EventsGateway,
  ) {}

  async sendCrashAlert(
    userId: string,
    dto: CrashAlertDto,
  ): Promise<CrashAlertResponseDto> {
    const alertId = randomUUID();

    // Load user and emergency contacts
    const [user, contacts] = await Promise.all([
      this.userRepo.findOne({ where: { id: userId } }),
      this.contactRepo.find({
        where: { user_id: userId, is_emergency: true },
      }),
    ]);

    if (!user) {
      return { contacts_notified: 0, alert_id: alertId };
    }

    const mapsLink = `https://maps.google.com/?q=${dto.lat},${dto.lng}`;

    // In production, this would integrate with an SMS/call service
    // (Twilio, MessageBird, etc.). For now, log and emit via WebSocket.
    for (const contact of contacts) {
      this.logger.warn(
        `CRASH ALERT [${alertId}]: Notifying ${contact.name} (${contact.phone}) ` +
          `for rider ${user.display_name} at ${dto.lat},${dto.lng} ` +
          `speed=${dto.speed_at_impact ?? 'unknown'} km/h ` +
          `ride=${dto.ride_id ?? 'none'} — ${mapsLink}`,
      );
    }

    // Emit real-time alert to the user's connected devices
    this.eventsGateway.emitToUser(userId, 'crash:alert-sent', {
      alert_id: alertId,
      contacts_notified: contacts.length,
      lat: dto.lat,
      lng: dto.lng,
      ride_id: dto.ride_id ?? null,
      speed_at_impact: dto.speed_at_impact ?? null,
      timestamp: new Date().toISOString(),
    });

    return {
      contacts_notified: contacts.length,
      alert_id: alertId,
    };
  }
}
