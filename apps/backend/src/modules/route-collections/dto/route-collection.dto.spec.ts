import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AddRouteCollectionItemDto } from './route-collection.dto.js';

/**
 * Field-level validation tests for the add-item DTO. Collections hold rides
 * only, so `ride_id` is the sole (required) target — these tests cover a valid
 * UUID, a malformed UUID, and the missing-field case.
 */
describe('AddRouteCollectionItemDto field-level validation', () => {
  async function validatePayload(payload: Record<string, unknown>) {
    const dto = plainToInstance(AddRouteCollectionItemDto, payload);
    return validate(dto);
  }

  it('accepts a sole ride_id when it is a valid UUID', async () => {
    const errors = await validatePayload({
      ride_id: 'a1b2c3d4-5678-4abc-9def-1234567890ab',
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects a missing ride_id', async () => {
    const errors = await validatePayload({});
    const messages = errors.flatMap((e) => Object.values(e.constraints ?? {}));
    expect(messages.some((m) => /uuid/i.test(m))).toBe(true);
  });

  it('rejects a non-UUID ride_id', async () => {
    const errors = await validatePayload({ ride_id: 'also-not' });
    const messages = errors.flatMap((e) => Object.values(e.constraints ?? {}));
    expect(messages.some((m) => /uuid/i.test(m))).toBe(true);
  });
});
