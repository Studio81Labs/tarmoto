import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PoiController } from './poi.controller.js';
import { PoiService } from './poi.service.js';
import { PoiStoreService } from './poi-store.service.js';

/**
 * HTTP-level coverage for `GET /poi/:id`. The route param is a Postgres UUID
 * column, so a non-UUID path must be rejected by `ParseUUIDPipe` (400) before
 * it reaches the store — otherwise `repo.findOne` raises `invalid input syntax
 * for type uuid` and the client sees a 500 instead of a clean 4xx.
 */
describe('PoiController — GET /poi/:id', () => {
  let app: INestApplication;
  const poiStore = { findInBbox: jest.fn(), findById: jest.fn() };
  const VALID_UUID = '11111111-1111-1111-1111-111111111111';

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PoiController],
      providers: [
        { provide: PoiService, useValue: {} },
        { provide: PoiStoreService, useValue: poiStore },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    jest.clearAllMocks();
  });

  it('400s a non-UUID id before touching the store', async () => {
    await request(app.getHttpServer() as App)
      .get('/poi/not-a-uuid')
      .expect(400);
    expect(poiStore.findById).not.toHaveBeenCalled();
  });

  it('404s a valid but unknown UUID', async () => {
    poiStore.findById.mockResolvedValue(null);
    await request(app.getHttpServer() as App)
      .get(`/poi/${VALID_UUID}`)
      .expect(404);
    expect(poiStore.findById).toHaveBeenCalledWith(VALID_UUID);
  });

  it('200s and returns the POI when found', async () => {
    poiStore.findById.mockResolvedValue({
      id: VALID_UUID,
      external_id: 'osm:node:1',
    });
    const res = await request(app.getHttpServer() as App)
      .get(`/poi/${VALID_UUID}`)
      .expect(200);
    expect((res.body as { external_id: string }).external_id).toBe(
      'osm:node:1',
    );
  });
});

describe('PoiController — GET /poi/health', () => {
  it('reports poiDb up/down without failing', async () => {
    const store = {
      isReady: () => Promise.resolve(false),
    } as unknown as PoiStoreService;
    const controller = new PoiController({} as PoiService, store);
    await expect(controller.health()).resolves.toEqual({ poiDb: 'down' });
  });
});

/**
 * HTTP-level coverage that `health` is registered ahead of the `:id`
 * catch-all. `'health'` is not a valid UUID, so if the route order ever
 * regresses, this request would be captured by `:id` and 400 from
 * `ParseUUIDPipe` instead of reaching the handler — the unit test above
 * calls `controller.health()` directly and can't see that failure mode.
 */
describe('PoiController — GET /poi/health (HTTP)', () => {
  let app: INestApplication;
  const poiStore = { isReady: jest.fn() };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PoiController],
      providers: [
        { provide: PoiService, useValue: {} },
        { provide: PoiStoreService, useValue: poiStore },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    jest.clearAllMocks();
  });

  it('is not shadowed by the :id catch-all', async () => {
    poiStore.isReady.mockResolvedValue(true);
    const res = await request(app.getHttpServer() as App)
      .get('/poi/health')
      .expect(200);
    expect(res.body).toEqual({ poiDb: 'up' });
  });
});
