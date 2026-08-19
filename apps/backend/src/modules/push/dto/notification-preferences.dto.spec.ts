import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateNotificationPreferencesDto } from './notification-preferences.dto.js';

/**
 * Validation contract for the typed PUT body. The companion calls this
 * endpoint with partial payloads (changing only the fields the user
 * touched), so EVERY field must be optional, but supplied fields must
 * be the right shape.
 */
describe('UpdateNotificationPreferencesDto', () => {
  it('accepts an empty payload (everything optional)', async () => {
    const dto = plainToInstance(UpdateNotificationPreferencesDto, {});
    expect(await validate(dto)).toEqual([]);
  });

  it('accepts a fully-populated payload', async () => {
    const dto = plainToInstance(UpdateNotificationPreferencesDto, {
      email_digest: 'daily',
      marketing_emails: true,
      quiet_hours_start: 22 * 60,
      quiet_hours_end: 6 * 60,
      quiet_hours_timezone: 'Europe/Prague',
      categories: {
        hazard_alert: { email: false, push: true, in_app: true },
        route_comment: { email: true, push: true, in_app: true },
      },
    });
    expect(await validate(dto)).toEqual([]);
  });

  it('rejects unknown email_digest values', async () => {
    const dto = plainToInstance(UpdateNotificationPreferencesDto, {
      email_digest: 'hourly',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.property).toBe('email_digest');
  });

  it('rejects out-of-range quiet_hours_start', async () => {
    const dto = plainToInstance(UpdateNotificationPreferencesDto, {
      quiet_hours_start: 1500,
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.property).toBe('quiet_hours_start');
  });

  it('rejects negative quiet_hours_end', async () => {
    const dto = plainToInstance(UpdateNotificationPreferencesDto, {
      quiet_hours_end: -1,
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.property).toBe('quiet_hours_end');
  });

  it('rejects non-string quiet_hours_timezone', async () => {
    const dto = plainToInstance(UpdateNotificationPreferencesDto, {
      quiet_hours_timezone: 42,
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.property).toBe('quiet_hours_timezone');
  });

  it('rejects non-boolean marketing_emails', async () => {
    const dto = plainToInstance(UpdateNotificationPreferencesDto, {
      marketing_emails: 'yes',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.property).toBe('marketing_emails');
  });
});
