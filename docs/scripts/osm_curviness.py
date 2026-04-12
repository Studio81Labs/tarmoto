#!/usr/bin/env python3
"""
Tarmoto — OSM Curviness Calculator

Pulls road data from OpenStreetMap for a given region and calculates
curviness scores for each road segment. Outputs a CSV and generates
a curviness heatmap.

Usage:
  python osm_curviness.py                     # Default: Beskydy/Ostrava region
  python osm_curviness.py --bbox 18.0,49.4,18.8,49.8  # Custom bounding box
  python osm_curviness.py --name "Beskydy"    # Custom region name

Output:
  ./curviness/roads_curviness.csv    — All roads with scores
  ./curviness/curviness_map.html     — Interactive map
  ./curviness/stats.txt              — Summary statistics
"""

import os
import sys
import json
import math
import argparse
import csv
from collections import defaultdict

try:
    import requests
except ImportError:
    os.system("pip install requests --break-system-packages -q")
    import requests

# ── Default region: Moravskoslezský / Beskydy / Jeseníky ──
DEFAULT_BBOX = {
    'south': 49.35,
    'west': 17.8,
    'north': 49.85,
    'east': 18.85,
    'name': 'Moravskoslezský region'
}

OVERPASS_APIS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]


def fetch_roads(bbox, road_types=None):
    """Fetch road data from OpenStreetMap via Overpass API."""
    if road_types is None:
        road_types = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary',
                      'unclassified', 'residential', 'motorway_link', 'trunk_link',
                      'primary_link', 'secondary_link', 'tertiary_link']

    highway_filter = '|'.join(road_types)

    query = f"""
    [out:json][timeout:120];
    (
      way["highway"~"^({highway_filter})$"]
        ({bbox['south']},{bbox['west']},{bbox['north']},{bbox['east']});
    );
    out body;
    >;
    out skel qt;
    """

    print(f"  Fetching roads from OSM for {bbox['name']}...")
    print(f"  Bbox: {bbox['south']},{bbox['west']} → {bbox['north']},{bbox['east']}")

    r = None
    for api_url in OVERPASS_APIS:
        try:
            print(f"  Trying {api_url.split('//')[1].split('/')[0]}...")
            r = requests.post(api_url, data={'data': query}, timeout=180)
            if r.status_code == 200:
                break
            print(f"    Got {r.status_code}, trying next...")
        except Exception as e:
            print(f"    Failed: {e}, trying next...")

    if r is None or r.status_code != 200:
        print("  ERROR: All Overpass API endpoints failed.")
        sys.exit(1)

    r.raise_for_status()
    data = r.json()

    # Separate nodes and ways
    nodes = {}
    ways = []
    for el in data['elements']:
        if el['type'] == 'node':
            nodes[el['id']] = (el['lat'], el['lon'])
        elif el['type'] == 'way':
            ways.append(el)

    print(f"  Fetched {len(ways)} roads, {len(nodes)} nodes")
    return ways, nodes


def haversine(lat1, lon1, lat2, lon2):
    """Distance between two points in meters."""
    R = 6371000
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))


def bearing(lat1, lon1, lat2, lon2):
    """Bearing from point 1 to point 2 in degrees."""
    dlon = math.radians(lon2 - lon1)
    lat1, lat2 = math.radians(lat1), math.radians(lat2)
    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return math.degrees(math.atan2(x, y)) % 360


def calculate_curviness(way, nodes):
    """
    Calculate curviness score for a road segment.

    Method: Sum of absolute bearing changes per km of road.
    Higher = more curves. Straight road ≈ 0, tight switchbacks > 1000.

    Returns dict with curviness metrics.
    """
    coords = []
    for nid in way.get('nodes', []):
        if nid in nodes:
            coords.append(nodes[nid])

    if len(coords) < 3:
        return None

    # Calculate total length and bearing changes
    total_length = 0
    total_bearing_change = 0
    sharp_curves = 0  # curves > 45°
    tight_curves = 0  # curves > 90°
    max_curve = 0

    for i in range(len(coords) - 1):
        segment_len = haversine(coords[i][0], coords[i][1],
                                coords[i+1][0], coords[i+1][1])
        total_length += segment_len

        if i > 0:
            b1 = bearing(coords[i-1][0], coords[i-1][1],
                        coords[i][0], coords[i][1])
            b2 = bearing(coords[i][0], coords[i][1],
                        coords[i+1][0], coords[i+1][1])

            # Shortest angle between bearings
            delta = abs(b2 - b1)
            if delta > 180:
                delta = 360 - delta

            # Only count if segment is long enough (avoid GPS noise)
            if segment_len > 5:
                total_bearing_change += delta
                if delta > 45:
                    sharp_curves += 1
                if delta > 90:
                    tight_curves += 1
                max_curve = max(max_curve, delta)

    if total_length < 50:  # Skip very short segments
        return None

    length_km = total_length / 1000

    # Curviness = total bearing change per km
    curviness_per_km = total_bearing_change / max(length_km, 0.01)

    # Score 0-5
    if curviness_per_km < 50:
        score = 1.0  # Very straight
    elif curviness_per_km < 150:
        score = 2.0  # Slightly curvy
    elif curviness_per_km < 400:
        score = 3.0  # Moderately curvy
    elif curviness_per_km < 800:
        score = 4.0  # Very curvy
    else:
        score = 5.0  # Extremely curvy (switchbacks)

    # Interpolate within ranges for finer granularity
    ranges = [(0, 50, 0, 1), (50, 150, 1, 2), (150, 400, 2, 3),
              (400, 800, 3, 4), (800, 2000, 4, 5)]
    for low, high, score_low, score_high in ranges:
        if curviness_per_km <= high:
            ratio = (curviness_per_km - low) / (high - low)
            score = score_low + ratio * (score_high - score_low)
            break

    score = round(min(5.0, max(0.0, score)), 2)

    # Center point for mapping
    mid = coords[len(coords) // 2]

    return {
        'length_m': round(total_length),
        'length_km': round(length_km, 2),
        'curviness_per_km': round(curviness_per_km, 1),
        'curviness_score': score,
        'sharp_curves': sharp_curves,
        'tight_curves': tight_curves,
        'max_curve_deg': round(max_curve, 1),
        'total_bearing_change': round(total_bearing_change, 1),
        'center_lat': mid[0],
        'center_lon': mid[1],
        'start_lat': coords[0][0],
        'start_lon': coords[0][1],
        'end_lat': coords[-1][0],
        'end_lon': coords[-1][1],
        'node_count': len(coords),
        'coords': coords,
    }


def process_roads(ways, nodes):
    """Process all roads and calculate curviness."""
    roads = []

    for way in ways:
        result = calculate_curviness(way, nodes)
        if result is None:
            continue

        tags = way.get('tags', {})
        result.update({
            'osm_id': way['id'],
            'name': tags.get('name', ''),
            'ref': tags.get('ref', ''),
            'highway': tags.get('highway', ''),
            'surface': tags.get('surface', ''),
            'maxspeed': tags.get('maxspeed', ''),
        })
        roads.append(result)

    # Sort by curviness score descending
    roads.sort(key=lambda r: r['curviness_score'], reverse=True)
    return roads


def save_csv(roads, outdir):
    """Save roads to CSV."""
    filepath = os.path.join(outdir, 'roads_curviness.csv')
    fields = ['osm_id', 'name', 'ref', 'highway', 'surface', 'maxspeed',
              'length_m', 'curviness_score', 'curviness_per_km',
              'sharp_curves', 'tight_curves', 'max_curve_deg',
              'center_lat', 'center_lon']

    with open(filepath, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(roads)

    print(f"  📄 Saved: {filepath} ({len(roads)} roads)")
    return filepath


def save_stats(roads, bbox, outdir):
    """Save summary statistics."""
    filepath = os.path.join(outdir, 'stats.txt')

    total_km = sum(r['length_km'] for r in roads)
    by_score = defaultdict(list)
    for r in roads:
        if r['curviness_score'] >= 4.0:
            by_score['very_curvy'].append(r)
        elif r['curviness_score'] >= 3.0:
            by_score['moderately_curvy'].append(r)
        elif r['curviness_score'] >= 2.0:
            by_score['slightly_curvy'].append(r)
        else:
            by_score['straight'].append(r)

    with open(filepath, 'w') as f:
        f.write("=" * 50 + "\n")
        f.write(f"  TARMOTO — Curviness Analysis\n")
        f.write(f"  Region: {bbox['name']}\n")
        f.write("=" * 50 + "\n\n")
        f.write(f"  Total roads analyzed: {len(roads)}\n")
        f.write(f"  Total road length:    {total_km:.0f} km\n\n")
        f.write(f"  Distribution:\n")
        for cat, label in [('very_curvy', 'Very curvy (4.0-5.0)'),
                           ('moderately_curvy', 'Moderately curvy (3.0-4.0)'),
                           ('slightly_curvy', 'Slightly curvy (2.0-3.0)'),
                           ('straight', 'Straight (0-2.0)')]:
            rds = by_score[cat]
            km = sum(r['length_km'] for r in rds)
            f.write(f"    {label:30s}  {len(rds):5d} roads  {km:8.1f} km\n")

        f.write(f"\n  Top 20 curviest roads:\n")
        for i, r in enumerate(roads[:20], 1):
            name = r['name'] or r['ref'] or f"OSM {r['osm_id']}"
            f.write(f"    {i:2d}. {name:30s}  score:{r['curviness_score']:.1f}  "
                    f"{r['length_km']:.1f}km  {r['sharp_curves']} sharp curves\n")

    print(f"  📄 Saved: {filepath}")
    return filepath


def generate_map(roads, bbox, outdir):
    """Generate an interactive HTML map with curviness overlay."""
    filepath = os.path.join(outdir, 'curviness_map.html')

    # Prepare road data for the map (top 2000 most interesting)
    interesting = [r for r in roads if r['curviness_score'] >= 1.5][:2000]

    roads_json = []
    for r in interesting:
        roads_json.append({
            'coords': [[c[0], c[1]] for c in r['coords']],
            'score': r['curviness_score'],
            'name': r['name'] or r['ref'] or '',
            'length': r['length_km'],
            'curves': r['sharp_curves'],
            'surface': r['surface'],
            'highway': r['highway'],
        })

    center_lat = (bbox['south'] + bbox['north']) / 2
    center_lon = (bbox['west'] + bbox['east']) / 2

    html = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tarmoto — Curviness Map — {bbox['name']}</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
body{{font-family:system-ui,sans-serif;background:#070A10;color:#E8ECF2}}
#map{{width:100%;height:calc(100vh - 60px)}}
.header{{background:#0C1018;padding:12px 20px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,.06)}}
.header h1{{font-size:16px;font-weight:800;color:#0ED3CF;letter-spacing:-.02em}}
.header span{{font-size:12px;color:#4A5568}}
.legend{{position:absolute;bottom:30px;right:10px;background:rgba(12,16,24,.92);backdrop-filter:blur(10px);border-radius:12px;padding:12px 16px;z-index:1000;border:1px solid rgba(255,255,255,.08)}}
.legend h3{{font-size:10px;color:#8B95A8;letter-spacing:.08em;margin-bottom:8px}}
.legend-row{{display:flex;align-items:center;gap:8px;margin-bottom:4px}}
.legend-line{{width:24px;height:3px;border-radius:2px}}
.legend-text{{font-size:11px;color:#8B95A8}}
.info-panel{{position:absolute;top:70px;left:10px;background:rgba(12,16,24,.92);backdrop-filter:blur(10px);border-radius:12px;padding:14px 16px;z-index:1000;border:1px solid rgba(255,255,255,.08);max-width:280px;display:none}}
.info-panel h3{{font-size:14px;font-weight:700;margin-bottom:6px;color:#E8ECF2}}
.info-panel p{{font-size:11px;color:#8B95A8;margin-bottom:3px}}
.info-panel .score{{font-size:24px;font-weight:900;margin:8px 0}}
.stats-bar{{position:absolute;top:70px;right:10px;background:rgba(12,16,24,.92);backdrop-filter:blur(10px);border-radius:12px;padding:12px 16px;z-index:1000;border:1px solid rgba(255,255,255,.08)}}
.stats-bar p{{font-size:11px;color:#8B95A8;margin-bottom:2px}}
.stats-bar .num{{color:#0ED3CF;font-weight:700}}
</style>
</head>
<body>
<div class="header">
<h1>TARMOTO — Curviness Map</h1>
<span>{bbox['name']} · {len(interesting)} roads analyzed</span>
</div>
<div id="map"></div>

<div class="legend">
<h3>CURVINESS</h3>
<div class="legend-row"><div class="legend-line" style="background:#EF4444"></div><span class="legend-text">Extremely curvy (4.5+)</span></div>
<div class="legend-row"><div class="legend-line" style="background:#F97316"></div><span class="legend-text">Very curvy (3.5-4.5)</span></div>
<div class="legend-row"><div class="legend-line" style="background:#EAB308"></div><span class="legend-text">Moderately curvy (2.5-3.5)</span></div>
<div class="legend-row"><div class="legend-line" style="background:#22C55E"></div><span class="legend-text">Slightly curvy (1.5-2.5)</span></div>
</div>

<div class="info-panel" id="info">
<h3 id="info-name">Road name</h3>
<div class="score" id="info-score" style="color:#0ED3CF">0.0</div>
<p>Curviness score</p>
<p id="info-length"></p>
<p id="info-curves"></p>
<p id="info-surface"></p>
<p id="info-type"></p>
</div>

<div class="stats-bar">
<p>Roads shown: <span class="num">{len(interesting)}</span></p>
<p>Very curvy (4+): <span class="num">{len([r for r in interesting if r['score']>=4])}</span></p>
<p>With surface tag: <span class="num">{len([r for r in interesting if r['surface']])}</span></p>
</div>

<script>
var roads = {json.dumps(roads_json)};

var map = L.map('map', {{
  center: [{center_lat}, {center_lon}],
  zoom: 10,
  zoomControl: true
}});

L.tileLayer('https://{{s}}.basemaps.cartocdn.com/dark_all/{{z}}/{{x}}/{{y}}@2x.png', {{
  attribution: '&copy; OSM &copy; CARTO',
  maxZoom: 18
}}).addTo(map);

function scoreColor(s) {{
  if (s >= 4.5) return '#EF4444';
  if (s >= 3.5) return '#F97316';
  if (s >= 2.5) return '#EAB308';
  return '#22C55E';
}}

roads.forEach(function(road) {{
  var latlngs = road.coords.map(function(c) {{ return [c[0], c[1]]; }});
  var color = scoreColor(road.score);
  var weight = Math.max(2, Math.min(5, road.score));

  var line = L.polyline(latlngs, {{
    color: color,
    weight: weight,
    opacity: 0.7,
    smoothFactor: 1
  }}).addTo(map);

  line.on('click', function() {{
    document.getElementById('info').style.display = 'block';
    document.getElementById('info-name').textContent = road.name || 'Unnamed road';
    document.getElementById('info-score').textContent = road.score.toFixed(1);
    document.getElementById('info-score').style.color = color;
    document.getElementById('info-length').textContent = 'Length: ' + road.length.toFixed(1) + ' km';
    document.getElementById('info-curves').textContent = 'Sharp curves: ' + road.curves;
    document.getElementById('info-surface').textContent = 'Surface: ' + (road.surface || 'unknown');
    document.getElementById('info-type').textContent = 'Road type: ' + road.highway;
  }});

  line.on('mouseover', function() {{ line.setStyle({{ weight: weight + 2, opacity: 1 }}); }});
  line.on('mouseout', function() {{ line.setStyle({{ weight: weight, opacity: 0.7 }}); }});
}});

map.on('click', function() {{
  document.getElementById('info').style.display = 'none';
}});
</script>
</body>
</html>"""

    with open(filepath, 'w') as f:
        f.write(html)

    print(f"  🗺️  Saved: {filepath}")
    return filepath


def main():
    parser = argparse.ArgumentParser(description='Tarmoto OSM Curviness Calculator')
    parser.add_argument('--bbox', help='Bounding box: west,south,east,north (e.g. 18.0,49.4,18.8,49.8)')
    parser.add_argument('--name', default=None, help='Region name')
    parser.add_argument('--out', default='./curviness', help='Output directory')
    args = parser.parse_args()

    bbox = DEFAULT_BBOX.copy()
    if args.bbox:
        parts = [float(x) for x in args.bbox.split(',')]
        bbox = {'west': parts[0], 'south': parts[1], 'east': parts[2], 'north': parts[3],
                'name': args.name or 'Custom region'}
    elif args.name:
        bbox['name'] = args.name

    outdir = args.out
    os.makedirs(outdir, exist_ok=True)

    print(f"\n{'='*50}")
    print(f"  TARMOTO — OSM Curviness Calculator")
    print(f"{'='*50}")

    ways, nodes = fetch_roads(bbox)
    roads = process_roads(ways, nodes)

    print(f"\n  Processed {len(roads)} valid road segments")
    print(f"  Top curviness score: {roads[0]['curviness_score']:.1f}" if roads else "  No roads found")

    save_csv(roads, outdir)
    save_stats(roads, bbox, outdir)
    generate_map(roads, bbox, outdir)

    print(f"\n  ✅ Complete! Open curviness_map.html in your browser.\n")


if __name__ == '__main__':
    main()
