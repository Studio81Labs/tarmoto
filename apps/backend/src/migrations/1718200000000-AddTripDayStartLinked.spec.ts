import { AddTripDayStartLinked1718200000000 } from './1718200000000-AddTripDayStartLinked.js';

describe('AddTripDayStartLinked migration', () => {
  it('adds and drops the start_linked column', async () => {
    const queries: string[] = [];
    const qr = {
      query: async (q: string) => {
        queries.push(q);
      },
    } as never;
    const m = new AddTripDayStartLinked1718200000000();
    await m.up(qr);
    await m.down(qr);
    expect(queries[0]).toMatch(
      /ALTER TABLE trip_days ADD COLUMN IF NOT EXISTS start_linked boolean NOT NULL DEFAULT false/,
    );
    expect(queries[1]).toMatch(/DROP COLUMN IF EXISTS start_linked/);
  });
});
