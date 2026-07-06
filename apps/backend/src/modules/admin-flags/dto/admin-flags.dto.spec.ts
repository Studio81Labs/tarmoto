import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ListFeatureFlagUsersQueryDto,
  SetFeatureGlobalStateDto,
  SetFeatureOverrideDto,
} from './admin-flags.dto.js';

describe('SetFeatureGlobalStateDto validation', () => {
  it('accepts force_on without a reason', async () => {
    const dto = plainToInstance(SetFeatureGlobalStateDto, {
      state: 'force_on',
    });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('accepts force_off with a reason', async () => {
    const dto = plainToInstance(SetFeatureGlobalStateDto, {
      state: 'force_off',
      reason: 'Incident #123 — bad exports',
    });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rejects force_off without a reason (kill switch needs context)', async () => {
    const dto = plainToInstance(SetFeatureGlobalStateDto, {
      state: 'force_off',
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.property).toBe('reason');
  });

  it('rejects force_off with a whitespace-only reason (trimmed empty)', async () => {
    const dto = plainToInstance(SetFeatureGlobalStateDto, {
      state: 'force_off',
      reason: '   ',
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.property).toBe('reason');
  });

  it('rejects states outside the vocabulary', async () => {
    const dto = plainToInstance(SetFeatureGlobalStateDto, {
      state: 'default',
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.property).toBe('state');
  });

  it('rejects a reason over 500 chars', async () => {
    const dto = plainToInstance(SetFeatureGlobalStateDto, {
      state: 'force_on',
      reason: 'x'.repeat(501),
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.property).toBe('reason');
  });
});

describe('SetFeatureOverrideDto validation', () => {
  it('accepts a boolean', async () => {
    const dto = plainToInstance(SetFeatureOverrideDto, { enabled: false });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rejects a missing enabled', async () => {
    const dto = plainToInstance(SetFeatureOverrideDto, {});
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.property).toBe('enabled');
  });
});

describe('ListFeatureFlagUsersQueryDto validation', () => {
  it('accepts an empty query (defaults)', async () => {
    const dto = plainToInstance(ListFeatureFlagUsersQueryDto, {});
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('coerces numeric strings for page/pageSize', async () => {
    const dto = plainToInstance(ListFeatureFlagUsersQueryDto, {
      page: '2',
      pageSize: '50',
    });
    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.page).toBe(2);
    expect(dto.pageSize).toBe(50);
  });

  it('rejects a pageSize over 100', async () => {
    const dto = plainToInstance(ListFeatureFlagUsersQueryDto, {
      pageSize: '500',
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.property).toBe('pageSize');
  });

  it('rejects an override filter outside force_on/force_off', async () => {
    const dto = plainToInstance(ListFeatureFlagUsersQueryDto, {
      override: 'default',
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.property).toBe('override');
  });
});
