import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListMessagesDto } from './list-messages.dto.js';

describe('ListMessagesDto cursor pairing', () => {
  async function validateQuery(query: Record<string, unknown>) {
    const dto = plainToInstance(ListMessagesDto, query);
    return validate(dto);
  }

  it('accepts an empty query (first page)', async () => {
    const errors = await validateQuery({});
    expect(errors).toHaveLength(0);
  });

  it('accepts a `before` ISO timestamp paired with a UUID `before_id`', async () => {
    const errors = await validateQuery({
      before: '2026-04-24T09:00:00.000Z',
      before_id: '123e4567-e89b-42d3-a456-556642440000',
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects a `before` without a paired `before_id` — the tie-breaker is required to avoid skipping tied-timestamp messages', async () => {
    const errors = await validateQuery({ before: '2026-04-24T09:00:00.000Z' });
    expect(errors.length).toBeGreaterThan(0);
    const err = errors.find((e) => e.property === 'before_id');
    expect(err).toBeDefined();
  });

  it('rejects a non-UUID `before_id`', async () => {
    const errors = await validateQuery({
      before: '2026-04-24T09:00:00.000Z',
      before_id: 'not-a-uuid',
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a lone `before_id` without `before` — would otherwise be silently ignored and loop the same page', async () => {
    const errors = await validateQuery({
      before_id: '123e4567-e89b-42d3-a456-556642440000',
    });
    expect(errors.length).toBeGreaterThan(0);
    const err = errors.find((e) => e.property === 'before');
    expect(err).toBeDefined();
  });
});
