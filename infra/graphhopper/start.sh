#!/bin/sh
# GraphHopper start wrapper (baked in as the image ENTRYPOINT — see Dockerfile).
#
# Clears the graph cache before launching so each (re)deploy re-imports the
# freshly conflated extract: GraphHopper reuses an existing graph otherwise, and
# the quality conflation just rewrote the input extract. This is what makes a
# plain Coolify "redeploy" act as the road-quality re-import (when the ENTRYPOINT
# is honoured).
#
# We deliberately DON'T pass `-o`: the image's `graphhopper.sh` always forces the
# graph location to its `GRAPH` default `/data/default-gh` unless `-o` is given,
# and Coolify may run that stock entrypoint (no `-o`) instead of this wrapper. By
# also omitting `-o` here, BOTH paths put the graph in `/data/default-gh`, so this
# `rm` and the runbook's manual clears always target the real graph dir.
#
# The extract + graph live on the shared /data volume (the backend writes the
# conflated extract to /data/routing); config.yml is baked into the image.
#
# CZ-only for now. For cz/sk/at, point -i at an osmium-merged extract and rebuild
# (or make the path an env var) — see docs/process/runbook.md.
set -eu

rm -rf /data/default-gh

exec /graphhopper/graphhopper.sh \
  -i /data/routing/cz.quality.osm \
  -c /graphhopper/config.yml \
  --host 0.0.0.0
