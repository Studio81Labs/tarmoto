import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { XMLParser } from 'fast-xml-parser';
import { Ride } from '../../entities/ride.entity.js';
import { haversineMeters } from '@tarmoto/shared';

interface GpxTrackPoint {
  '@_lat': string;
  '@_lon': string;
  ele?: number;
  time?: string;
}

interface GpxTrack {
  trkseg:
    | { trkpt: GpxTrackPoint | GpxTrackPoint[] }
    | Array<{ trkpt: GpxTrackPoint | GpxTrackPoint[] }>;
}

interface GpxRoot {
  gpx: {
    trk: GpxTrack | GpxTrack[];
    rte?:
      | { rtept?: GpxTrackPoint | GpxTrackPoint[] }
      | Array<{ rtept?: GpxTrackPoint | GpxTrackPoint[] }>;
  };
}

@Injectable()
export class GpxService {
  private readonly parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
  });

  constructor(
    @InjectRepository(Ride)
    private readonly rideRepo: Repository<Ride>,
  ) {}

  async importGpx(userId: string, fileBuffer: Buffer): Promise<Ride> {
    const xml = fileBuffer.toString('utf-8');
    const points = this.parseGpxPoints(xml);

    if (points.length < 2) {
      throw new BadRequestException(
        'GPX file must contain at least 2 track points',
      );
    }

    // Calculate route stats
    let totalDistance = 0;
    for (let i = 1; i < points.length; i++) {
      totalDistance += haversineMeters(
        points[i - 1].lat,
        points[i - 1].lng,
        points[i].lat,
        points[i].lng,
      );
    }

    const startTime = points[0].time ?? new Date();
    const endTime = points[points.length - 1].time ?? new Date();

    // Build GeoJSON LineString
    const coordinates = points.map((p) => [p.lng, p.lat]);

    const ride = this.rideRepo.create({
      user_id: userId,
      ride_type: 'tracked',
      status: 'completed',
      started_at: startTime,
      ended_at: endTime,
      distance_km: Math.round((totalDistance / 1000) * 100) / 100,
      route_geom: {
        type: 'LineString',
        coordinates,
      },
    });

    return this.rideRepo.save(ride);
  }

  /**
   * Parse GPX XML and extract track points.
   * Supports both <trk><trkseg><trkpt> and <rte><rtept> formats.
   */
  parseGpxPoints(
    xml: string,
  ): Array<{ lat: number; lng: number; ele?: number; time?: Date }> {
    let parsed: GpxRoot;
    try {
      parsed = this.parser.parse(xml) as GpxRoot;
    } catch {
      throw new BadRequestException('Invalid GPX XML');
    }

    if (!parsed.gpx) {
      throw new BadRequestException('Missing <gpx> root element');
    }

    // Try tracks first (<trk><trkseg><trkpt>)
    if (parsed.gpx.trk) {
      const tracks = Array.isArray(parsed.gpx.trk)
        ? parsed.gpx.trk
        : [parsed.gpx.trk];

      const points: Array<{
        lat: number;
        lng: number;
        ele?: number;
        time?: Date;
      }> = [];

      for (const track of tracks) {
        const segments = Array.isArray(track.trkseg)
          ? track.trkseg
          : [track.trkseg];
        for (const seg of segments) {
          if (!seg?.trkpt) continue;
          const trkpts = Array.isArray(seg.trkpt) ? seg.trkpt : [seg.trkpt];
          for (const pt of trkpts) {
            points.push(this.parsePoint(pt));
          }
        }
      }

      if (points.length > 0) return points;
    }

    // Fall back to routes (<rte><rtept>)
    if (parsed.gpx.rte) {
      const routes = Array.isArray(parsed.gpx.rte)
        ? parsed.gpx.rte
        : [parsed.gpx.rte];

      const points: Array<{
        lat: number;
        lng: number;
        ele?: number;
        time?: Date;
      }> = [];

      for (const route of routes) {
        if (!route?.rtept) continue;
        const rtepts = Array.isArray(route.rtept) ? route.rtept : [route.rtept];
        for (const pt of rtepts) {
          points.push(this.parsePoint(pt));
        }
      }

      if (points.length > 0) return points;
    }

    throw new BadRequestException('GPX file contains no track or route data');
  }

  private parsePoint(pt: GpxTrackPoint): {
    lat: number;
    lng: number;
    ele?: number;
    time?: Date;
  } {
    return {
      lat: parseFloat(pt['@_lat']),
      lng: parseFloat(pt['@_lon']),
      ele: pt.ele != null ? Number(pt.ele) : undefined,
      time: pt.time ? new Date(pt.time) : undefined,
    };
  }
}
