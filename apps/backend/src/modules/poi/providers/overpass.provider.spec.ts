import { parseStarsTag } from './overpass.provider.js';

describe('parseStarsTag', () => {
  it('returns null for falsy or non-numeric input', () => {
    expect(parseStarsTag(undefined)).toBeNull();
    expect(parseStarsTag(null)).toBeNull();
    expect(parseStarsTag('')).toBeNull();
    expect(parseStarsTag('star')).toBeNull();
  });

  it('returns plain integer ratings verbatim', () => {
    expect(parseStarsTag('3')).toBe(3);
    expect(parseStarsTag('5')).toBe(5);
  });

  it('floors fractional ratings instead of splitting the decimal', () => {
    expect(parseStarsTag('4.5')).toBe(4);
    expect(parseStarsTag('3.9')).toBe(3);
  });

  it('handles the trailing superior marker', () => {
    expect(parseStarsTag('4S')).toBe(4);
    expect(parseStarsTag('5 S')).toBe(5);
  });

  it('picks the upper endpoint of a range', () => {
    expect(parseStarsTag('3-4')).toBe(4);
    expect(parseStarsTag('4-4.5')).toBe(4);
    expect(parseStarsTag('2-5')).toBe(5);
  });

  it('rejects values outside the 1..5 UI range', () => {
    expect(parseStarsTag('0')).toBeNull();
    expect(parseStarsTag('6')).toBeNull();
    expect(parseStarsTag('6S')).toBeNull();
    expect(parseStarsTag('10')).toBeNull();
  });
});
