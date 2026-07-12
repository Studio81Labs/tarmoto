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
});
