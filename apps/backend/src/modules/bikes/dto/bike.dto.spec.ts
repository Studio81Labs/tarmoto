import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateBikeDto,
  MIN_BIKE_YEAR,
  UpdateBikeDto,
  maxBikeYear,
} from './bike.dto.js';

async function validateBody(body: unknown): Promise<string[]> {
  const dto = plainToInstance(CreateBikeDto, body);
  const errors = await validate(dto);
  return errors.flatMap((e) => Object.keys(e.constraints ?? {}));
}

const appValidationPipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

async function transformCreate(body: unknown): Promise<CreateBikeDto> {
  return appValidationPipe.transform(body, {
    type: 'body',
    metatype: CreateBikeDto,
  }) as Promise<CreateBikeDto>;
}

async function transformUpdate(body: unknown): Promise<UpdateBikeDto> {
  return appValidationPipe.transform(body, {
    type: 'body',
    metatype: UpdateBikeDto,
  }) as Promise<UpdateBikeDto>;
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
    expect(errors).toContain('isBikeYear');
  });

  it('rejects a year more than one year past the current calendar year', async () => {
    const errors = await validateBody({
      make: 'Honda',
      model: 'Africa Twin',
      year: maxBikeYear() + 1,
    });
    expect(errors).toContain('isBikeYear');
  });

  it('accepts the next-model-year value (currentYear + 1)', async () => {
    const errors = await validateBody({
      make: 'Honda',
      model: 'Africa Twin',
      year: maxBikeYear(),
    });
    expect(errors).toEqual([]);
  });

  it('recomputes the year ceiling per request (does not freeze at module load)', async () => {
    // Regression for the bug-bot finding: with `@Max(maxBikeYear())`
    // the ceiling was captured once at module load — a process that
    // booted in 2026 would keep rejecting 2028 bikes throughout 2027.
    // The custom validator reads `Date.now()` per call, so freezing
    // the wall-clock to next year must let the previously-rejected
    // "current + 2" value validate cleanly.
    const yearAhead = new Date().getUTCFullYear() + 1;
    jest
      .useFakeTimers()
      .setSystemTime(new Date(`${yearAhead}-06-15T00:00:00Z`));
    try {
      const errors = await validateBody({
        make: 'Honda',
        model: 'Africa Twin',
        // Was "currentYear + 2" (out of range) before the clock
        // advanced; now "currentYear + 1" relative to the fake clock.
        year: yearAhead + 1,
      });
      expect(errors).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
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
      photo_url: 'javascript:alert(1)',
    });
    expect(errors).toContain('isUrl');
  });

  it('accepts generated snake_case bike fields through the global validation pipe', async () => {
    await expect(
      transformCreate({
        make: 'Honda',
        model: 'Africa Twin',
        is_active: true,
        photo_url: 'https://example.com/bike.jpg',
      }),
    ).resolves.toMatchObject({
      make: 'Honda',
      model: 'Africa Twin',
      is_active: true,
      photo_url: 'https://example.com/bike.jpg',
    });
  });

  it('rejects legacy camelCase bike write fields through the global validation pipe', async () => {
    await expect(
      transformCreate({
        make: 'Honda',
        model: 'Africa Twin',
        isActive: true,
        photoUrl: 'https://example.com/bike.jpg',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('exports the expected boundary constants', () => {
    expect(MIN_BIKE_YEAR).toBe(1900);
    const fixed = new Date('2026-05-07T00:00:00Z');
    expect(maxBikeYear(fixed)).toBe(2027);
  });
});

describe('UpdateBikeDto', () => {
  it('accepts generated snake_case bike fields through the global validation pipe', async () => {
    await expect(
      transformUpdate({
        is_active: true,
        photo_url: 'https://example.com/bike.jpg',
      }),
    ).resolves.toMatchObject({
      is_active: true,
      photo_url: 'https://example.com/bike.jpg',
    });
  });

  it('rejects legacy camelCase bike write fields through the global validation pipe', async () => {
    await expect(
      transformUpdate({
        isActive: true,
        photoUrl: 'https://example.com/bike.jpg',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
