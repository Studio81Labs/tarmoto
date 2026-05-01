import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AddRouteCollectionItemDto } from './route-collection.dto.js';

/**
 * Field-level validation tests for the add-item DTO. The cross-field
 * "exactly one of trip_id / ride_id" invariant is enforced in the service
 * (see `RouteCollectionsService.addItem` and `route-collections.service.spec`)
 * because class-validator's `@ValidateIf` short-circuits any peer decorator
 * the moment its predicate returns false — which makes the empty-body case
 * unreachable from a field-level constraint. These tests cover what the DTO
 * is actually responsible for: malformed UUID strings.
 */
describe('AddRouteCollectionItemDto field-level validation', () => {
  async function validatePayload(payload: Record<string, unknown>) {
    const dto = plainToInstance(AddRouteCollectionItemDto, payload);
    return validate(dto);
  }

  it('accepts a sole trip_id when it is a valid UUID', async () => {
    const errors = await validatePayload({
      trip_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    });
    expect(errors).toHaveLength(0);
  });

  it('accepts a sole ride_id when it is a valid UUID', async () => {
    const errors = await validatePayload({
      ride_id: 'a1b2c3d4-5678-4abc-9def-1234567890ab',
    });
    expect(errors).toHaveLength(0);
  });

  it('passes the empty-body case at the field layer (service catches it)', async () => {
    // Documented behaviour, not desired behaviour — see the DTO doc comment.
    // The service-level check is the authoritative gate; this test exists so
    // a future contributor doesn't assume the field-level validators cover
    // empty bodies and accidentally bypass the service guard.
    const errors = await validatePayload({});
    expect(errors).toHaveLength(0);
  });

  it('rejects a non-UUID trip_id', async () => {
    const errors = await validatePayload({ trip_id: 'not-a-uuid' });
    const messages = errors.flatMap((e) => Object.values(e.constraints ?? {}));
    expect(messages.some((m) => /uuid/i.test(m))).toBe(true);
  });

  it('rejects a non-UUID ride_id', async () => {
    const errors = await validatePayload({ ride_id: 'also-not' });
    const messages = errors.flatMap((e) => Object.values(e.constraints ?? {}));
    expect(messages.some((m) => /uuid/i.test(m))).toBe(true);
  });
});
