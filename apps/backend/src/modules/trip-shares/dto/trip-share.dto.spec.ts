import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateTripShareDto,
  MAX_TRIP_SNAPSHOT_BYTES,
} from './trip-share.dto.js';

describe('CreateTripShareDto snapshot size validation', () => {
  async function validatePayload(payload: {
    title: string;
    snapshot: Record<string, unknown>;
  }) {
    const dto = plainToInstance(CreateTripShareDto, payload);
    return validate(dto);
  }

  it('accepts a small snapshot', async () => {
    const errors = await validatePayload({
      title: 'Trip',
      snapshot: { days: [] },
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects a snapshot whose JSON byte length exceeds the cap', async () => {
    // `'a'.repeat(cap + 1)` produces a string whose UTF-8 byte length equals
    // its char count. After JSON-stringify the wrapper adds three extra bytes
    // (`{"x":"..."}`-like), so the serialised payload is guaranteed over.
    const oversize = 'a'.repeat(MAX_TRIP_SNAPSHOT_BYTES + 1);
    const errors = await validatePayload({
      title: 'Trip',
      snapshot: { x: oversize },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.constraints?.snapshotSize).toMatch(/exceeds .* bytes/i);
  });

  it('rejects a CJK snapshot whose char count is under the cap but byte count is over', async () => {
    // '日' is one UTF-16 code unit but three UTF-8 bytes. A string of length
    // ~340_000 chars is well under the 1 MB *character* limit but the
    // serialised UTF-8 body is ~1.02 MB — which the old `.length` check
    // accepted. The fixed validator measures bytes and must reject.
    const cjkCharCount = Math.ceil(MAX_TRIP_SNAPSHOT_BYTES / 3) + 1_000;
    const cjkString = '日'.repeat(cjkCharCount);
    const errors = await validatePayload({
      title: 'Trip',
      snapshot: { x: cjkString },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.constraints?.snapshotSize).toMatch(/exceeds .* bytes/i);
  });

  it('accepts a CJK snapshot whose byte count is under the cap', async () => {
    // Same alphabet, but sized so the serialised byte count stays within
    // the cap — we want the new byte-aware validator to keep accepting
    // realistic non-ASCII payloads, not just reject them.
    const cjkCharCount = Math.floor(MAX_TRIP_SNAPSHOT_BYTES / 3) - 1_000;
    const cjkString = '日'.repeat(cjkCharCount);
    const errors = await validatePayload({
      title: 'Trip',
      snapshot: { x: cjkString },
    });
    expect(errors).toHaveLength(0);
  });
});
