import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SaveRouteDto, MAX_TRIP_DAYS } from './save-route.dto.js';

const day = (dayNumber: number) => ({
  dayNumber,
  startLinked: dayNumber > 1,
  waypoints: [
    { lat: 50, lng: 14, type: 'start' },
    { lat: 51, lng: 15, type: 'end' },
  ],
});

async function errorsFor(payload: unknown) {
  return validate(plainToInstance(SaveRouteDto, payload));
}

it('accepts a single-day payload', async () => {
  expect(await errorsFor({ days: [day(1)] })).toHaveLength(0);
});
it('accepts a multi-day payload', async () => {
  expect(await errorsFor({ days: [day(1), day(2)] })).toHaveLength(0);
});
it('rejects an empty days array', async () => {
  expect((await errorsFor({ days: [] })).length).toBeGreaterThan(0);
});
it('rejects more than MAX_TRIP_DAYS days', async () => {
  const days = Array.from({ length: MAX_TRIP_DAYS + 1 }, (_, i) => day(i + 1));
  expect((await errorsFor({ days })).length).toBeGreaterThan(0);
});
it('rejects a day with <2 waypoints', async () => {
  expect(
    (
      await errorsFor({
        days: [
          {
            dayNumber: 1,
            startLinked: false,
            waypoints: [{ lat: 0, lng: 0, type: 'start' }],
          },
        ],
      })
    ).length,
  ).toBeGreaterThan(0);
});
