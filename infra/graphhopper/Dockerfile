# Tarmoto's GraphHopper image for the deployed (Coolify) environment.
#
# Stock israelhikingmap/graphhopper plus (a) our routing config.yml — which
# carries the `smoothness` encoded value quality-aware routing rides on
# (#779, ADR-0005) — and (b) a start wrapper that clears the graph cache on
# each (re)deploy so a freshly conflated extract is actually re-imported.
#
# Why a custom image: Coolify image apps expose only "Custom Docker Options" —
# no entrypoint/command field — and the stock entrypoint bakes
# `-c config-example.yml` with no `-i`/`-o`, so the stock image can't be pointed
# at our extract. This makes it work two ways, robust to whether Coolify honours
# the ENTRYPOINT below:
#   1. config.yml carries `datareader.file` (a deploy default) and is copied OVER
#      the stock `config-example.yml`, so even the stock entrypoint
#      (`graphhopper.sh -c config-example.yml`) imports our extract. The graph
#      lands in `/data/default-gh` — graphhopper.sh forces that (its `GRAPH`
#      default) whenever no `-o` is passed, so we don't set graph.location.
#   2. start.sh is set as ENTRYPOINT — when honoured it additionally clears
#      `/data/default-gh` each start so a redeploy re-imports the fresh extract.
#
# Build context is THIS directory (infra/graphhopper), which also holds
# config.yml + start.sh. Local dev still uses the plain image + `command:` in
# infra/docker/docker-compose.yml (Compose can set entrypoint/command; Coolify
# can't) — see this folder's README.
FROM israelhikingmap/graphhopper:10.2

# Bake our config at non-/data paths (the runtime /data mount can't hide them):
# BOTH the path start.sh reads (config.yml) AND the stock `config-example.yml`
# the image's own entrypoint reads — so whichever entrypoint runs, GraphHopper
# gets our config (the smoothness encoded value + the datareader.file default).
COPY config.yml /graphhopper/config.yml
COPY config.yml /graphhopper/config-example.yml
COPY start.sh /graphhopper/tarmoto-start.sh
RUN chmod +x /graphhopper/tarmoto-start.sh

# Local-dev routing container only (never deployed by CI); it runs as root so
# the entrypoint can write graph tiles into the bind-mounted /data volume.
# nosemgrep: dockerfile.security.missing-user-entrypoint.missing-user-entrypoint
ENTRYPOINT ["/graphhopper/tarmoto-start.sh"]
