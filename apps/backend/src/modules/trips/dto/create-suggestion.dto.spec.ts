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
