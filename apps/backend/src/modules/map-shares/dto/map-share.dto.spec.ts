import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateMapShareDto, MAX_MAP_SNAPSHOT_BYTES } from './map-share.dto.js';

describe('CreateMapShareDto snapshot size validation', () => {
  async function validatePayload(payload: {
    title: string;
    snapshot: Record<string, unknown>;
  }) {
    const dto = plainToInstance(CreateMapShareDto, payload);
    return validate(dto);
  }

  it('accepts a small snapshot', async () => {
    const errors = await validatePayload({
      title: 'My explored Czechia',
      snapshot: { ridden_segments: 1234, segments: [] },
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects a snapshot whose JSON byte length exceeds the cap', async () => {
    const oversize = 'a'.repeat(MAX_MAP_SNAPSHOT_BYTES + 1);
    const errors = await validatePayload({
      title: 'Map',
      snapshot: { x: oversize },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.constraints?.mapSnapshotSize).toMatch(
      /exceeds .* bytes/i,
    );
  });
});
