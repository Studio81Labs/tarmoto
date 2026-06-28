import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateFeatureFlagDto,
  UpdateFeatureFlagDto,
} from './admin-flags.dto.js';

describe('UpdateFeatureFlagDto validation', () => {
  it('rejects null enabled with a validation error', async () => {
    const dto = plainToInstance(UpdateFeatureFlagDto, { enabled: null });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('enabled');
  });

  it('accepts a boolean true for enabled', async () => {
    const dto = plainToInstance(UpdateFeatureFlagDto, { enabled: true });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts absent enabled (no field in payload)', async () => {
    const dto = plainToInstance(UpdateFeatureFlagDto, {});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});

describe('CreateFeatureFlagDto validation', () => {
  it('rejects null enabled with a validation error', async () => {
    const dto = plainToInstance(CreateFeatureFlagDto, {
      key: 'beta_ui',
      enabled: null,
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('enabled');
  });

  it('accepts absent enabled (no field in payload)', async () => {
    const dto = plainToInstance(CreateFeatureFlagDto, { key: 'beta_ui' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts a boolean false for enabled', async () => {
    const dto = plainToInstance(CreateFeatureFlagDto, {
      key: 'beta_ui',
      enabled: false,
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});
