import type * as GeoJSON from 'geojson';
import { HazardReport } from '../../entities/hazard-report.entity.js';
import { RoadReview } from '../../entities/road-review.entity.js';
import { TripMessage } from '../../entities/trip-message.entity.js';

export enum ContentType {
  Hazard = 'hazard',
  Review = 'review',
  TripMessage = 'trip_message',
}

export interface ContentTypeConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  entity: new () => any;
  /** audit log target_type written by setAdminAuditTarget */
  auditTargetType: string;
  /** column the free-text search runs against (registry-sourced, never user input) */
  textColumn: 'note' | 'comment' | 'body';
  toPhotoUrls(row: Record<string, unknown>): string[];
  toLocation(row: Record<string, unknown>): { lat: number; lng: number } | null;
}

function pointToLatLng(value: unknown): { lat: number; lng: number } | null {
  const geom = value as GeoJSON.Point | null | undefined;
  if (!geom || geom.type !== 'Point' || !Array.isArray(geom.coordinates)) {
    return null;
  }
  const [lng, lat] = geom.coordinates;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  return { lat, lng };
}

export const CONTENT_TYPES: Record<ContentType, ContentTypeConfig> = {
  [ContentType.Hazard]: {
    entity: HazardReport,
    auditTargetType: 'hazard_report',
    textColumn: 'note',
    toPhotoUrls: (row) =>
      typeof row.photo_url === 'string' && row.photo_url ? [row.photo_url] : [],
    toLocation: (row) => pointToLatLng(row.location),
  },
  [ContentType.Review]: {
    entity: RoadReview,
    auditTargetType: 'road_review',
    textColumn: 'comment',
    toPhotoUrls: (row) =>
      Array.isArray(row.photos) ? (row.photos as string[]) : [],
    toLocation: () => null,
  },
  [ContentType.TripMessage]: {
    entity: TripMessage,
    auditTargetType: 'trip_message',
    textColumn: 'body',
    toPhotoUrls: () => [],
    toLocation: () => null,
  },
};
