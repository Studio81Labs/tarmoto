import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Poi } from '../../entities/poi.entity.js';
import { osmDetailUrl } from './providers/overpass.provider.js';
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  StoredPoiDto,
} from './dto/stored-poi.dto.js';

interface Bbox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

/**
 * Read path over the offline `pois` store (#849). Unlike `PoiService` — which
 * hits Overpass live per request — this serves the mirrored PostGIS rows the
 * weekly import (#848 / #850) populates, so a pannable POI map layer and the
 * companion category bar don't hammer Overpass on every pan.
 *
 * Queries go through `createQueryBuilder` (not `repo.query`) so TypeORM
 * hydrates `geom` back into a GeoJSON Point — same reason the passes service
 * does; a raw query would hand back a WKB hex string and `toStoredPoiDto`
 * would crash on `.coordinates`.
 */
@Injectable()
export class PoiStoreService {
  constructor(
    @InjectRepository(Poi)
    private readonly repo: Repository<Poi>,
  ) {}

  /**
   * List stored POIs whose point falls inside the bounding box, optionally
   * filtered to a set of `kind`s, capped at `limit`. Ordered by kind then
   * name so the client can group markers deterministically.
   */
  async findInBbox(
    bbox: Bbox,
    kinds: string[] | undefined,
    limit: number,
  ): Promise<StoredPoiDto[]> {
    if (bbox.minLng >= bbox.maxLng || bbox.minLat >= bbox.maxLat) {
      throw new BadRequestException(
        'bbox min must be strictly less than max on both axes',
      );
    }
    const capped = Math.min(
      Math.max(1, Math.trunc(limit) || DEFAULT_LIMIT),
      MAX_LIMIT,
    );

    const qb = this.repo
      .createQueryBuilder('poi')
      // ST_Intersects is GiST-index-accelerated (it bbox-prefilters via the
      // spatial index), and for point geometry it's equivalent to a bbox test.
      .where(
        'ST_Intersects(poi.geom, ST_MakeEnvelope(:minLng, :minLat, :maxLng, :maxLat, 4326))',
        bbox,
      );
    if (kinds && kinds.length > 0) {
      qb.andWhere('poi.kind IN (:...kinds)', { kinds });
    }
    const rows = await qb
      .orderBy('poi.kind', 'ASC')
      .addOrderBy('poi.name', 'ASC')
      .limit(capped)
      .getMany();
    return rows.map(toStoredPoiDto);
  }

  /** Fetch a single stored POI by its uuid, or null when it doesn't exist. */
  async findById(id: string): Promise<StoredPoiDto | null> {
    const poi = await this.repo.findOne({ where: { id } });
    return poi ? toStoredPoiDto(poi) : null;
  }
}

/**
 * Map a persisted `Poi` row to the served DTO: reads lat/lng out of the
 * hydrated GeoJSON point, derives the OSM detail link, and serialises the
 * import timestamp. Exported for unit tests.
 */
export function toStoredPoiDto(poi: Poi): StoredPoiDto {
  const [lng, lat] = poi.geom.coordinates;
  if (lng === undefined || lat === undefined) {
    throw new Error('stored POI geom is missing lng/lat');
  }
  return {
    id: poi.id,
    source: poi.source,
    external_id: poi.external_id,
    name: poi.name,
    kind: poi.kind,
    lat,
    lng,
    website: poi.website,
    phone: poi.phone,
    opening_hours: poi.opening_hours,
    address_street: poi.address_street,
    address_city: poi.address_city,
    address_postcode: poi.address_postcode,
    address_country: poi.address_country,
    cuisine: poi.cuisine,
    brand: poi.brand,
    stars: poi.stars,
    osm_url: osmDetailUrl(poi.external_id),
    last_imported_at: poi.last_imported_at.toISOString(),
  };
}
