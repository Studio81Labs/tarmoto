import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateSuggestionDto } from './create-suggestion.dto.js';

describe('CreateSuggestionDto coordinate pairing', () => {
  async function validatePayload(payload: Record<string, unknown>) {
    const dto = plainToInstance(CreateSuggestionDto, payload);
    return validate(dto);
  }

  it('accepts a suggestion with no coordinates at all', async () => {
    const errors = await validatePayload({ title: 'Detour via Pordoi' });
    expect(errors).toHaveLength(0);
  });

  it('accepts a suggestion with both lat and lng', async () => {
    const errors = await validatePayload({
      title: 'Marker',
      lat: 46.49,
      lng: 11.34,
    });
    expect(errors).toHaveLength(0);
  });

  it('accepts an explicit null pair (clients clearing a marker by sending JSON nulls)', async () => {
    // Contract says both fields are `nullable: true` — a client
    // serializing "no marker" as `{ lat: null, lng: null }` must not
    // fail DTO validation even though the previous `!== undefined`
    // guard treated null as "present".
    const errors = await validatePayload({
      title: 'No marker',
      lat: null,
      lng: null,
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects a mixed null/value pair (lat null, lng number)', async () => {
    const errors = await validatePayload({
      title: 'Mixed',
      lat: null,
      lng: 11.34,
    });
    expect(errors.length).toBeGreaterThan(0);
    const latError = errors.find((e) => e.property === 'lat');
    expect(latError).toBeDefined();
  });

  it('rejects a lone null lat (lng entirely absent from payload)', async () => {
    // The all-or-nothing rule means a single `null` without the
    // paired key must 400 — otherwise a typo'd client eliding `lng`
    // would be silently accepted as "no marker", masking a real bug.
    const errors = await validatePayload({
      title: 'Lone null',
      lat: null,
    });
    expect(errors.length).toBeGreaterThan(0);
    const lngError = errors.find((e) => e.property === 'lng');
    expect(lngError).toBeDefined();
  });

  it('rejects a lone null lng (lat entirely absent from payload)', async () => {
    const errors = await validatePayload({
      title: 'Lone null',
      lng: null,
    });
    expect(errors.length).toBeGreaterThan(0);
    const latError = errors.find((e) => e.property === 'lat');
    expect(latError).toBeDefined();
  });

  it('rejects a lat-value with explicit null lng (value/null mix)', async () => {
    const errors = await validatePayload({
      title: 'Value/null',
      lat: 46.49,
      lng: null,
    });
    expect(errors.length).toBeGreaterThan(0);
    const lngError = errors.find((e) => e.property === 'lng');
    expect(lngError).toBeDefined();
  });

  it('rejects a lone lat without lng (would otherwise silently drop the coordinate)', async () => {
    const errors = await validatePayload({
      title: 'Marker',
      lat: 46.49,
    });
    expect(errors.length).toBeGreaterThan(0);
    const lngError = errors.find((e) => e.property === 'lng');
    expect(lngError).toBeDefined();
  });

  it('rejects a lone lng without lat', async () => {
    const errors = await validatePayload({
      title: 'Marker',
      lng: 11.34,
    });
    expect(errors.length).toBeGreaterThan(0);
    const latError = errors.find((e) => e.property === 'lat');
    expect(latError).toBeDefined();
  });

  it('rejects out-of-range coordinates even when paired', async () => {
    const errors = await validatePayload({
      title: 'Bad coords',
      lat: 9999,
      lng: 11.34,
    });
    expect(errors.length).toBeGreaterThan(0);
    const latError = errors.find((e) => e.property === 'lat');
    expect(latError?.constraints?.isLatitude).toBeDefined();
  });
});
