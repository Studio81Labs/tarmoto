# Utility Scripts

One-off and analysis scripts for Tarmoto development. These are standalone Python tools, not part of the app codebase.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install pandas matplotlib numpy requests
```

## Scripts

### `analyze_ride.py`

Analyzes CSV exports from the Tarmoto PoC sensor app. Generates summary statistics and branded PNG charts (RMS distribution, quality breakdown, road type separation, speed vs vibration).

```bash
python analyze_ride.py segments_file.csv [raw_file.csv]
python analyze_ride.py --dir ./rides/     # batch analyze all CSVs
```

Output goes to `./analysis/`.

### `create_issues.py`

Creates GitHub Issues, labels, and milestones from the PRD user stories. **Already run** — 37 issues live on GetTarmoto/tarmoto. Running again will create duplicates.

```bash
export GITHUB_TOKEN=ghp_...
python create_issues.py --dry-run    # preview only
python create_issues.py              # create on GitHub
```

### `osm_curviness.py`

Fetches road data from OpenStreetMap via Overpass API and calculates curviness scores for each road segment. Generates a CSV and an interactive Leaflet HTML map.

```bash
python osm_curviness.py                                  # default: Moravskoslezsky region
python osm_curviness.py --bbox 18.0,49.4,18.8,49.8      # custom bounding box
python osm_curviness.py --name "Beskydy"                 # custom region name
```

Output goes to `./curviness/`.
