import type * as GeoJSON from 'geojson';

type LineLike = GeoJSON.LineString | null;

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
}

function track(name: string, route: GeoJSON.LineString): string {
  const points = route.coordinates
    .map(([lon, lat]) => `<trkpt lat="${lat}" lon="${lon}" />`)
    .join('');
  return `<trk><name>${escapeXml(name)}</name><trkseg>${points}</trkseg></trk>`;
}

export function rideToGpx(args: {
  name: string;
  startedAt: Date;
  route: LineLike;
}): string | null {
  if (!args.route || args.route.coordinates.length === 0) return null;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<gpx version="1.1" creator="Tarmoto" xmlns="http://www.topografix.com/GPX/1/1">` +
    `<metadata><name>${escapeXml(args.name)}</name>` +
    `<time>${args.startedAt.toISOString()}</time></metadata>` +
    track(args.name, args.route) +
    `</gpx>`
  );
}

export function tripDayToGpx(args: {
  tripTitle: string;
  dayNumber: number;
  route: LineLike;
}): string | null {
  if (!args.route || args.route.coordinates.length === 0) return null;
  const name = `${args.tripTitle} — Day ${args.dayNumber}`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<gpx version="1.1" creator="Tarmoto" xmlns="http://www.topografix.com/GPX/1/1">` +
    `<metadata><name>${escapeXml(name)}</name></metadata>` +
    track(name, args.route) +
    `</gpx>`
  );
}
