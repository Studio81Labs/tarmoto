#!/bin/sh
# GraphHopper start wrapper (baked in as the image ENTRYPOINT — see Dockerfile).
#
# Clears the graph cache before launching so each (re)deploy re-imports the
# freshly conflated extract: GraphHopper reuses an existing graph-cache
# otherwise, and the quality conflation just rewrote the input extract. This is
# what makes a plain Coolify "redeploy" act as the road-quality re-import.
#
# The extract + graph-cache live on the shared /data volume (the backend writes
# the conflated extract there); config.yml is baked into the image.
#
# CZ-only for now. For cz/sk/at, point -i at an osmium-merged extract and rebuild
# (or make the path an env var) — see docs/process/runbook.md.
set -eu

rm -rf /data/graph-cache

exec /graphhopper/graphhopper.sh \
  -i /data/routing/cz.quality.osm \
  -c /graphhopper/config.yml \
  -o /data/graph-cache \
  --host 0.0.0.0
