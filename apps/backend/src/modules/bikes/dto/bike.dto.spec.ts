import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateBikeDto, MIN_BIKE_YEAR, maxBikeYear } from './bike.dto.js';

async function validateBody(body: unknown): Promise<string[]> {
  const dto = plainToInstance(CreateBikeDto, body);
  const errors = await validate(dto);
  return errors.flatMap((e) => Object.keys(e.constraints ?? {}));
}

describe('CreateBikeDto', () => {
  it('accepts a minimal valid payload', async () => {
    const errors = await validateBody({
      make: 'Honda',
      model: 'Africa Twin',
    });
    expect(errors).toEqual([]);
  });

  it('rejects an empty make / model', async () => {
    const errors = await validateBody({ make: '', model: '' });
    expect(errors).toContain('minLength');
  });

  it('rejects a year before 1900', async () => {
    const errors = await validateBody({
      make: 'Honda',
      model: 'Africa Twin',
      year: 1899,
    });
    expect(errors).toContain('min');
  });

  it('rejects a year more than one year past the current calendar year', async () => {
    const errors = await validateBody({
      make: 'Honda',
      model: 'Africa Twin',
      year: maxBikeYear() + 1,
    });
    expect(errors).toContain('max');
  });

  it('accepts the next-model-year value (currentYear + 1)', async () => {
    const errors = await validateBody({
      make: 'Honda',
      model: 'Africa Twin',
      year: maxBikeYear(),
    });
    expect(errors).toEqual([]);
  });

  it('rejects an icon longer than 32 chars', async () => {
    const errors = await validateBody({
      make: 'Honda',
      model: 'Africa Twin',
      icon: 'x'.repeat(33),
    });
    expect(errors).toContain('maxLength');
  });

  it('accepts free-form notes up to 1000 chars', async () => {
    const errors = await validateBody({
      make: 'Honda',
      model: 'Africa Twin',
      notes: 'x'.repeat(1000),
    });
    expect(errors).toEqual([]);
  });

  it('rejects notes over 1000 chars', async () => {
    const errors = await validateBody({
      make: 'Honda',
      model: 'Africa Twin',
      notes: 'x'.repeat(1001),
    });
    expect(errors).toContain('maxLength');
  });

  it('rejects a non-http photo URL', async () => {
    const errors = await validateBody({
      make: 'Honda',
      model: 'Africa Twin',
      photoUrl: 'javascript:alert(1)',
    });
    expect(errors).toContain('isUrl');
  });

  it('exports the expected boundary constants', () => {
    expect(MIN_BIKE_YEAR).toBe(1900);
    const fixed = new Date('2026-05-07T00:00:00Z');
    expect(maxBikeYear(fixed)).toBe(2027);
  });
});
