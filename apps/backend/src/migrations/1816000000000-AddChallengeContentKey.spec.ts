import { AddChallengeContentKey1816000000000 } from './1816000000000-AddChallengeContentKey.js';

describe('AddChallengeContentKey migration', () => {
  it('backfills canonical content keys for legacy challenge metrics', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: (query: string) => {
        queries.push(query);
        return Promise.resolve();
      },
    } as never;

    await new AddChallengeContentKey1816000000000().up(queryRunner);

    expect(queries[1]).toMatch(
      /WHEN metric = 'total_km' THEN 'total_distance'/,
    );
    expect(queries[1]).toMatch(
      /WHEN metric = 'unique_segments' THEN 'roads_discovered'/,
    );
  });
});
