import { toOptionalBoolean, toOptionalNumber } from './dto-transforms.js';

describe('toOptionalNumber', () => {
  it('returns undefined for nullish / blank / whitespace', () => {
    expect(toOptionalNumber({ value: undefined })).toBeUndefined();
    expect(toOptionalNumber({ value: null })).toBeUndefined();
    expect(toOptionalNumber({ value: '' })).toBeUndefined();
    expect(toOptionalNumber({ value: '   ' })).toBeUndefined();
  });

  it('coerces numeric strings through Number()', () => {
    expect(toOptionalNumber({ value: '42' })).toBe(42);
    expect(toOptionalNumber({ value: '-3.14' })).toBe(-3.14);
  });
});

describe('toOptionalBoolean', () => {
  it('returns undefined for nullish / blank / whitespace', () => {
    expect(toOptionalBoolean({ value: undefined })).toBeUndefined();
    expect(toOptionalBoolean({ value: null })).toBeUndefined();
    expect(toOptionalBoolean({ value: '' })).toBeUndefined();
    expect(toOptionalBoolean({ value: '   ' })).toBeUndefined();
  });

  it('parses "true"/"1" (any case) as true', () => {
    expect(toOptionalBoolean({ value: 'true' })).toBe(true);
    expect(toOptionalBoolean({ value: 'TRUE' })).toBe(true);
    expect(toOptionalBoolean({ value: '  True  ' })).toBe(true);
    expect(toOptionalBoolean({ value: '1' })).toBe(true);
  });

  it('parses "false"/"0" (any case) as false — the bug that motivated the helper', () => {
    // Boolean("false") === true, so the stock @Type(() => Boolean) would
    // incorrectly coerce these to true. Keep this locked in.
    expect(toOptionalBoolean({ value: 'false' })).toBe(false);
    expect(toOptionalBoolean({ value: 'FALSE' })).toBe(false);
    expect(toOptionalBoolean({ value: '  False  ' })).toBe(false);
    expect(toOptionalBoolean({ value: '0' })).toBe(false);
  });

  it('passes actual booleans through unchanged', () => {
    expect(toOptionalBoolean({ value: true })).toBe(true);
    expect(toOptionalBoolean({ value: false })).toBe(false);
  });

  it('returns unrecognised strings verbatim so @IsBoolean() can reject them', () => {
    expect(toOptionalBoolean({ value: 'yeah' })).toBe('yeah');
    expect(toOptionalBoolean({ value: 42 })).toBe(42);
  });
});
