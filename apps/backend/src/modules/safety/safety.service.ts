import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, QueryFailedError, Repository } from 'typeorm';
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
import {
  normalizeCrashAlertLocale,
  renderCrashAlertMessage,
} from './crash-alert-message.js';

/** Postgres unique-violation SQLSTATE — used to detect idempotency replays. */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * After this many ms a placeholder row whose dispatch never completed
 * is treated as abandoned (process crash, OOM, hard timeout) so a new
 * request with the same `alert_id` can reclaim it instead of being
 * locked into `dispatch_in_progress: true` forever.
 */
const STALE_DISPATCH_MS = 5 * 60 * 1000;

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
        dispatch_in_progress: false,
      };
    }

    // Idempotency gate: insert the audit row first. Postgres' PK
    // unique-violation tells us the same alert_id was already
    // dispatched, in which case we replay the original outcome
    // (scoped to the current user — see replayExistingAlert).
    const rawLocale =
      dto.locale ??
      (typeof user.preferences?.['locale'] === 'string'
        ? user.preferences['locale']
        : null);
    // Persist the canonical short tag so a long BCP-47 input never
    // overflows `crash_alerts.locale VARCHAR(16)` and trips a non-
    // unique-violation insert error that would bypass replay.
    const locale = normalizeCrashAlertLocale(rawLocale);

    const claim = await this.claimAlertRow(alertId, userId, {
      rideId: dto.ride_id ?? null,
      lat: dto.lat,
      lng: dto.lng,
      speedAtImpact: dto.speed_at_impact ?? null,
      severity,
      locale,
      contactsTotal: contacts.length,
    });
    if (claim.replay) return claim.replay;

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
    const message = renderCrashAlertMessage(baseContext, rawLocale);
    const context: CrashAlertContext = { ...baseContext, message };

    const useVoice = severity === 'high';

    let contactsNotified = 0;
    let flatResults: CrashAlertContactResult[] = [];
    try {
      const dispatchResults = await Promise.all(
        contacts.map((contact) =>
          this.dispatchToContact(contact, context, useVoice),
        ),
      );

      contactsNotified = dispatchResults.filter((r) =>
        r.some((entry) => entry.status === 'sent'),
      ).length;
      flatResults = dispatchResults.flat();
    } finally {
      // Always close the row, even if dispatch threw, so retries don't
      // see a permanent in-flight placeholder. A failure to write the
      // completion is logged loudly — the stale-row recovery path in
      // replayExistingAlert is the backstop for that case.
      try {
        await this.alertRepo.update(
          { id: alertId, user_id: userId },
          {
            contacts_notified: contactsNotified,
            contact_results: flatResults,
            dispatch_completed_at: new Date(),
          },
        );
      } catch (updateErr) {
        const msg =
          updateErr instanceof Error ? updateErr.message : String(updateErr);
        this.logger.error(
          `crash-alert ${alertId} completion update failed: ${msg} — ` +
            `placeholder row may be stale until reclaimed by a retry`,
        );
      }
    }

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
      dispatch_in_progress: false,
    };
  }

  /**
   * Insert the placeholder audit row, or — on a unique-violation —
   * decide whether to replay an existing dispatch or reclaim a stale
   * placeholder. Returns either a `replay` response (caller should
   * return it directly) or `replay: null` (caller proceeds with
   * dispatch). Cross-user collisions throw 409.
   */
  private async claimAlertRow(
    alertId: string,
    userId: string,
    fields: {
      rideId: string | null;
      lat: number;
      lng: number;
      speedAtImpact: number | null;
      severity: CrashAlertSeverity;
      locale: string | null;
      contactsTotal: number;
    },
  ): Promise<{ replay: CrashAlertResponseDto | null }> {
    try {
      await this.alertRepo.insert({
        id: alertId,
        user_id: userId,
        ride_id: fields.rideId,
        lat: fields.lat,
        lng: fields.lng,
        speed_at_impact: fields.speedAtImpact,
        severity: fields.severity,
        locale: fields.locale,
        contacts_notified: 0,
        contacts_total: fields.contactsTotal,
        contact_results: [],
        dispatch_completed_at: null,
      });
      return { replay: null };
    } catch (err) {
      if (!this.isUniqueViolation(err)) throw err;
    }

    const existing = await this.alertRepo.findOne({
      where: { id: alertId, user_id: userId },
    });
    if (!existing) {
      this.logger.warn(
        `crash-alert idempotency collision id=${alertId} user=${userId} — ` +
          'alert_id reused across users, refusing to dispatch or replay',
      );
      throw new ConflictException(
        'alert_id is already in use; generate a new one',
      );
    }

    if (existing.dispatch_completed_at !== null) {
      return { replay: this.toReplayResponse(existing, false) };
    }

    const ageMs = Date.now() - existing.created_at.getTime();
    if (ageMs <= STALE_DISPATCH_MS) {
      this.logger.warn(
        `crash-alert idempotent replay id=${alertId} — dispatch in progress`,
      );
      return {
        replay: {
          alert_id: existing.id,
          contacts_notified: 0,
          contacts: [],
          idempotent_replay: true,
          dispatch_in_progress: true,
        },
      };
    }

    // Stale placeholder: the original request died after the insert
    // but before the completion update. Reclaim the row so this
    // retry can dispatch fresh against the latest fields.
    this.logger.warn(
      `crash-alert reclaiming stale placeholder id=${alertId} ` +
        `age=${Math.round(ageMs / 1000)}s — original dispatch never completed`,
    );
    await this.alertRepo.update(
      // Constrain to still-incomplete rows so we don't accidentally
      // overwrite a completion that landed between findOne and update.
      { id: alertId, user_id: userId, dispatch_completed_at: IsNull() },
      {
        ride_id: fields.rideId,
        lat: fields.lat,
        lng: fields.lng,
        speed_at_impact: fields.speedAtImpact,
        severity: fields.severity,
        locale: fields.locale,
        contacts_notified: 0,
        contacts_total: fields.contactsTotal,
        contact_results: [],
      },
    );
    return { replay: null };
  }

  private toReplayResponse(
    existing: CrashAlert,
    dispatchInProgress: boolean,
  ): CrashAlertResponseDto {
    this.logger.warn(
      `crash-alert idempotent replay id=${existing.id} ` +
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
      dispatch_in_progress: dispatchInProgress,
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
      // Notifier-not-configured: the call returns successfully but
      // only emitted a log line. Tag this as `skipped` (channel=log)
      // so the response can't claim a contact was notified when no
      // SMS/voice ever left the system. `contacts_notified` only
      // counts `status: 'sent'` so unconfigured deployments stay
      // honest in the response.
      if (!this.notifier.isConfigured()) {
        return {
          contact_id: contact.id,
          name: contact.name,
          phone: contact.phone,
          channel: 'log',
          status: 'skipped',
          provider_message_id: null,
          error: 'notifier not configured (log-only fallback)',
        };
      }
      return {
        contact_id: contact.id,
        name: contact.name,
        phone: contact.phone,
        channel: dispatch.channel,
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

  private isUniqueViolation(err: unknown): boolean {
    if (!(err instanceof QueryFailedError)) return false;
    const driverErr = (
      err as QueryFailedError & { driverError?: { code?: string } }
    ).driverError;
    return driverErr?.code === PG_UNIQUE_VIOLATION;
  }
}
