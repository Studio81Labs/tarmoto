import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UpdateProfileDto } from './update-profile.dto.js';

async function validatePreferences(preferences: Record<string, unknown>) {
  const dto = plainToInstance(UpdateProfileDto, { preferences });
  const errors = await validate(dto);
  return { dto, errors };
}

describe('UpdateProfileDto preferences validation', () => {
  it('accepts and canonicalizes a valid format_locale', async () => {
    const { dto, errors } = await validatePreferences({
      format_locale: 'CS-cz',
    });
    expect(errors).toHaveLength(0);
    expect(dto.preferences?.format_locale).toBe('cs-CZ');
  });

  it('rejects a malformed format_locale', async () => {
    const { errors } = await validatePreferences({
      format_locale: 'not a locale!',
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts a valid IANA timezone', async () => {
    const { errors } = await validatePreferences({
      timezone: 'Europe/Prague',
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects an unknown timezone', async () => {
    const { errors } = await validatePreferences({
      timezone: 'Mars/Olympus_Mons',
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts enum units and rejects arbitrary strings (closes the @IsString gap)', async () => {
    expect(
      (await validatePreferences({ units: 'imperial' })).errors,
    ).toHaveLength(0);
    expect(
      (await validatePreferences({ units: 'nautical' })).errors.length,
    ).toBeGreaterThan(0);
  });

  it('still accepts a preferences patch that omits the new fields', async () => {
    const { errors } = await validatePreferences({ daily_km: 250 });
    expect(errors).toHaveLength(0);
  });
});
