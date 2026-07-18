import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SetSystemSwitchDisabledDto } from './admin-system-switches.dto.js';

describe('SetSystemSwitchDisabledDto validation', () => {
  it('accepts a reason', async () => {
    const dto = plainToInstance(SetSystemSwitchDisabledDto, {
      reason: 'incident 123',
    });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rejects a missing reason', async () => {
    const dto = plainToInstance(SetSystemSwitchDisabledDto, {});
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.property).toBe('reason');
  });

  it('rejects a blank reason', async () => {
    const dto = plainToInstance(SetSystemSwitchDisabledDto, { reason: '' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.property).toBe('reason');
  });

  it('rejects a whitespace-only reason (trimmed empty)', async () => {
    const dto = plainToInstance(SetSystemSwitchDisabledDto, {
      reason: '   ',
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.property).toBe('reason');
  });

  it('rejects a reason over 500 chars', async () => {
    const dto = plainToInstance(SetSystemSwitchDisabledDto, {
      reason: 'x'.repeat(501),
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.property).toBe('reason');
  });

  it('trims the reason', async () => {
    const dto = plainToInstance(SetSystemSwitchDisabledDto, {
      reason: '  incident 123  ',
    });
    await validate(dto);
    expect(dto.reason).toBe('incident 123');
  });
});
