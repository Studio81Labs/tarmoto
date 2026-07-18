import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  SetLimitGlobalValueDto,
  SetUserLimitOverrideDto,
} from './admin-limits.dto.js';

describe('SetLimitGlobalValueDto validation', () => {
  it('accepts a null (unlimited) value with a reason', async () => {
    const dto = plainToInstance(SetLimitGlobalValueDto, {
      value: null,
      reason: 'launch mode',
    });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('accepts a non-negative integer value with a reason', async () => {
    const dto = plainToInstance(SetLimitGlobalValueDto, {
      value: 3,
      reason: 'promo raise',
    });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rejects a missing value', async () => {
    const dto = plainToInstance(SetLimitGlobalValueDto, { reason: 'x' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.property).toBe('value');
  });

  it('rejects a negative value', async () => {
    const dto = plainToInstance(SetLimitGlobalValueDto, {
      value: -1,
      reason: 'x',
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.property).toBe('value');
  });

  it('rejects a non-integer value', async () => {
    const dto = plainToInstance(SetLimitGlobalValueDto, {
      value: 1.5,
      reason: 'x',
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.property).toBe('value');
  });

  it('rejects a missing reason (always required, unlike the toggle twin)', async () => {
    const dto = plainToInstance(SetLimitGlobalValueDto, { value: 3 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.property).toBe('reason');
  });

  it('rejects a whitespace-only reason (trimmed empty)', async () => {
    const dto = plainToInstance(SetLimitGlobalValueDto, {
      value: 3,
      reason: '   ',
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.property).toBe('reason');
  });

  it('rejects a reason over 500 chars', async () => {
    const dto = plainToInstance(SetLimitGlobalValueDto, {
      value: 3,
      reason: 'x'.repeat(501),
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.property).toBe('reason');
  });
});

describe('SetUserLimitOverrideDto validation', () => {
  it('accepts a null (unlimited) value', async () => {
    const dto = plainToInstance(SetUserLimitOverrideDto, { value: null });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('accepts a non-negative integer value', async () => {
    const dto = plainToInstance(SetUserLimitOverrideDto, { value: 5 });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rejects a missing value', async () => {
    const dto = plainToInstance(SetUserLimitOverrideDto, {});
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.property).toBe('value');
  });

  it('rejects a negative value', async () => {
    const dto = plainToInstance(SetUserLimitOverrideDto, { value: -1 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.property).toBe('value');
  });
});
