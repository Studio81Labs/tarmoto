import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UserRoutePrefsDto, UpdateProfileDto } from './update-profile.dto.js';

async function validatePrefs(body: unknown): Promise<string[]> {
  const dto = plainToInstance(UserRoutePrefsDto, body);
  const errors = await validate(dto);
  return errors.flatMap((e) => Object.keys(e.constraints ?? {}));
}

async function validateProfile(body: unknown): Promise<string[]> {
  const dto = plainToInstance(UpdateProfileDto, body);
  const errors = await validate(dto);
  return errors.flatMap((e) => Object.keys(e.constraints ?? {}));
}

async function validatePreferences(preferences: Record<string, unknown>) {
  const dto = plainToInstance(UpdateProfileDto, { preferences });
  const errors = await validate(dto);
  return { dto, errors };
}

const VALID_PREFS = {
  road_preference: 'direct',
  avoid_highways: false,
  avoid_tolls: false,
  avoid_unpaved: true,
  surfaces: ['asphalt'],
  min_quality: 'any',
};

describe('UserRoutePrefsDto', () => {
  it('accepts a valid payload', async () => {
    expect(await validatePrefs(VALID_PREFS)).toEqual([]);
  });

  it('rejects a bare string for surfaces', async () => {
    // `each` alone lets a non-array string through (it validates the
    // value itself) — that string would land in the JSONB and crash
    // the companion's surfaces.filter(...) on the next prefs load.
    const errors = await validatePrefs({
      ...VALID_PREFS,
      surfaces: 'asphalt',
    });
    expect(errors).toContain('isArray');
  });

  it('rejects non-string surface entries', async () => {
    const errors = await validatePrefs({
      ...VALID_PREFS,
      surfaces: ['asphalt', 42],
    });
    expect(errors).toContain('isString');
  });
});

describe('UpdateProfileDto / language', () => {
  it('accepts a supported locale', async () => {
    expect(await validateProfile({ language: 'en' })).toEqual([]);
  });

  it('accepts an omitted language (optional)', async () => {
    expect(await validateProfile({ display_name: 'Rider' })).toEqual([]);
  });

  it('rejects an unsupported locale', async () => {
    const errors = await validateProfile({ language: 'xx' });
    expect(errors).toContain('isIn');
  });

  it('rejects an explicit null (column is NOT NULL, unlike its nullable siblings)', async () => {
    // Regression: `@IsOptional()` would have skipped validation for `null`
    // too, letting `{ language: null }` reach the service and crash the
    // NOT NULL column instead of failing validation with a 400.
    const errors = await validateProfile({ language: null });
    expect(errors).toContain('isIn');
  });
});

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

  // Regression: `@IsOptional()` skips validators for explicit `null` too, so a
  // PATCH like `{preferences: {format_locale: null}}` would sail past
  // validation and the merge would persist a null into the JSONB even though
  // the response contract declares these as optional STRINGS. Same
  // undefined-only-skip rule as `language` (see the @ValidateIf note there).
  it('rejects explicit null for units, format_locale, and timezone', async () => {
    expect(
      (await validatePreferences({ format_locale: null })).errors.length,
    ).toBeGreaterThan(0);
    expect(
      (await validatePreferences({ timezone: null })).errors.length,
    ).toBeGreaterThan(0);
    expect(
      (await validatePreferences({ units: null })).errors.length,
    ).toBeGreaterThan(0);
  });
});
