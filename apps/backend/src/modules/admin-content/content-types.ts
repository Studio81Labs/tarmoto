import type * as GeoJSON from 'geojson';
import { HazardReport } from '../../entities/hazard-report.entity.js';
import { RoadReview } from '../../entities/road-review.entity.js';
import { TripMessage } from '../../entities/trip-message.entity.js';
import { sanitizeHazardPhotoUrl } from '../hazards/dto/hazard-photo.dto.js';
import { sanitizeReviewPhotos } from '../reviews/dto/review.dto.js';

export enum ContentType {
  Hazard = 'hazard',
  Review = 'review',
  TripMessage = 'trip_message',
}

export interface ContentTypeConfig {
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
    // Sanitize stored URLs the same way the public hazard mappers do —
    // legacy/direct-DB rows can hold values that fail the current URL
    // policy, and the admin screen renders these as <img>/links.
    toPhotoUrls: (row) => {
      const url = sanitizeHazardPhotoUrl(row.photo_url);
      return url ? [url] : [];
    },
    toLocation: (row) => pointToLatLng(row.location),
  },
  [ContentType.Review]: {
    entity: RoadReview,
    auditTargetType: 'road_review',
    textColumn: 'comment',
    // sanitizeReviewPhotos drops policy-failing URLs and caps the list
    // at MAX_REVIEW_PHOTOS — same gate the public review mappers use.
    toPhotoUrls: (row) => sanitizeReviewPhotos(row.photos),
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
