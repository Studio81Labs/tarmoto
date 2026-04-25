import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { UserContact } from '../../entities/user-contact.entity.js';
import { User } from '../../entities/user.entity.js';
import {
  CrashAlert,
  type CrashAlertContactResult,
  type CrashAlertSeverity,
} from '../../entities/crash-alert.entity.js';
import { CrashAlertDto, CrashAlertResponseDto } from './dto/crash-alert.dto.js';
import { EventsGateway } from '../events/events.gateway.js';
import {
  CRASH_ALERT_NOTIFIER,
  type CrashAlertChannel,
  type CrashAlertContext,
  type CrashAlertNotifier,
} from './crash-alert-notifier.interface.js';
import { renderCrashAlertMessage } from './crash-alert-message.js';

/** Postgres unique-violation SQLSTATE — used to detect idempotency replays. */
const PG_UNIQUE_VIOLATION = '23505';

@Injectable()
export class SafetyService {
  private readonly logger = new Logger(SafetyService.name);

  constructor(
    @InjectRepository(UserContact)
    private readonly contactRepo: Repository<UserContact>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(CrashAlert)
    private readonly alertRepo: Repository<CrashAlert>,
    private readonly eventsGateway: EventsGateway,
    @Inject(CRASH_ALERT_NOTIFIER)
    private readonly notifier: CrashAlertNotifier,
  ) {}

  async sendCrashAlert(
    userId: string,
    dto: CrashAlertDto,
  ): Promise<CrashAlertResponseDto> {
    const alertId = dto.alert_id ?? randomUUID();
    const severity: CrashAlertSeverity = dto.severity ?? 'medium';

    const [user, contacts] = await Promise.all([
      this.userRepo.findOne({ where: { id: userId } }),
      this.contactRepo.find({
        where: { user_id: userId, is_emergency: true },
      }),
    ]);

    if (!user) {
      return {
        contacts_notified: 0,
        alert_id: alertId,
        contacts: [],
        idempotent_replay: false,
      };
    }

    // Idempotency gate: insert the audit row first. Postgres' PK
    // unique-violation tells us the same alert_id was already
    // dispatched, in which case we replay the original outcome.
    const locale =
      dto.locale ??
      (typeof user.preferences?.['locale'] === 'string'
        ? user.preferences['locale']
        : null);

    try {
      await this.alertRepo.insert({
        id: alertId,
        user_id: userId,
        ride_id: dto.ride_id ?? null,
        lat: dto.lat,
        lng: dto.lng,
        speed_at_impact: dto.speed_at_impact ?? null,
        severity,
        locale,
        contacts_notified: 0,
        contacts_total: contacts.length,
        contact_results: [],
      });
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        return this.replayExistingAlert(alertId);
      }
      throw err;
    }

    const mapsLink = `https://maps.google.com/?q=${dto.lat},${dto.lng}`;
    const timestamp = new Date().toISOString();
    const baseContext = {
      alert_id: alertId,
      rider_name: user.display_name,
      lat: dto.lat,
      lng: dto.lng,
      maps_link: mapsLink,
      ride_id: dto.ride_id ?? null,
      speed_kmh: dto.speed_at_impact ?? null,
      severity,
      timestamp,
    } as const;
    const message = renderCrashAlertMessage(baseContext, locale);
    const context: CrashAlertContext = { ...baseContext, message };

    const useVoice = severity === 'high';
    const dispatchResults = await Promise.all(
      contacts.map((contact) =>
        this.dispatchToContact(contact, context, useVoice),
      ),
    );

    const contactsNotified = dispatchResults.filter((r) =>
      r.some((entry) => entry.status === 'sent'),
    ).length;

    const flatResults: CrashAlertContactResult[] = dispatchResults.flat();

    await this.alertRepo.update(
      { id: alertId },
      {
        contacts_notified: contactsNotified,
        contact_results: flatResults,
      },
    );

    this.eventsGateway.emitToUser(userId, 'crash:alert-sent', {
      alert_id: alertId,
      contacts_notified: contactsNotified,
      contacts_total: contacts.length,
      lat: dto.lat,
      lng: dto.lng,
      ride_id: dto.ride_id ?? null,
      speed_at_impact: dto.speed_at_impact ?? null,
      severity,
      timestamp,
    });

    this.logger.warn(
      `crash-alert dispatched id=${alertId} user=${userId} severity=${severity} ` +
        `notified=${contactsNotified}/${contacts.length} provider=${this.notifier.name}`,
    );

    return {
      alert_id: alertId,
      contacts_notified: contactsNotified,
      contacts: flatResults.map((r) => ({
        contact_id: r.contact_id,
        name: r.name,
        channel: r.channel,
        status: r.status,
        provider_message_id: r.provider_message_id,
        error: r.error,
      })),
      idempotent_replay: false,
    };
  }

  /**
   * Dispatch SMS (and optionally voice) to a single contact, returning
   * one audit entry per attempted channel. Failures are recorded but
   * never thrown — the request stays a success even if every contact
   * fails so the rider's app sees the response and the audit row is
   * persisted for follow-up.
   */
  private async dispatchToContact(
    contact: UserContact,
    context: CrashAlertContext,
    includeVoice: boolean,
  ): Promise<CrashAlertContactResult[]> {
    const results: CrashAlertContactResult[] = [];

    results.push(await this.dispatchOne('sms', contact, context));

    if (includeVoice) {
      results.push(await this.dispatchOne('voice', contact, context));
    }

    return results;
  }

  private async dispatchOne(
    channel: CrashAlertChannel,
    contact: UserContact,
    context: CrashAlertContext,
  ): Promise<CrashAlertContactResult> {
    try {
      const dispatch = await this.notifier.send(
        channel,
        {
          contact_id: contact.id,
          name: contact.name,
          phone: contact.phone,
        },
        context,
      );
      return {
        contact_id: contact.id,
        name: contact.name,
        phone: contact.phone,
        channel: this.notifier.isConfigured() ? dispatch.channel : 'log',
        status: 'sent',
        provider_message_id: dispatch.provider_message_id,
        error: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `crash-alert ${context.alert_id} ${channel} dispatch failed for ` +
          `contact=${contact.id} (${contact.phone}): ${message}`,
      );
      return {
        contact_id: contact.id,
        name: contact.name,
        phone: contact.phone,
        channel,
        status: 'failed',
        provider_message_id: null,
        error: message,
      };
    }
  }

  private async replayExistingAlert(
    alertId: string,
  ): Promise<CrashAlertResponseDto> {
    const existing = await this.alertRepo.findOne({ where: { id: alertId } });
    if (!existing) {
      // Race: another request lost the insert but its row vanished
      // before we could read it. Surface as not-replayed with zero
      // notifications rather than re-dispatching.
      return {
        alert_id: alertId,
        contacts_notified: 0,
        contacts: [],
        idempotent_replay: true,
      };
    }
    this.logger.warn(
      `crash-alert idempotent replay id=${alertId} ` +
        `notified=${existing.contacts_notified}/${existing.contacts_total}`,
    );
    return {
      alert_id: existing.id,
      contacts_notified: existing.contacts_notified,
      contacts: existing.contact_results.map((r) => ({
        contact_id: r.contact_id,
        name: r.name,
        channel: r.channel,
        status: r.status,
        provider_message_id: r.provider_message_id,
        error: r.error,
      })),
      idempotent_replay: true,
    };
  }

  private isUniqueViolation(err: unknown): boolean {
    if (!(err instanceof QueryFailedError)) return false;
    const driverErr = (
      err as QueryFailedError & { driverError?: { code?: string } }
    ).driverError;
    return driverErr?.code === PG_UNIQUE_VIOLATION;
  }
}
