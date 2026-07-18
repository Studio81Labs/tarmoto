# Tarmoto's GraphHopper image for the deployed (Coolify) environment.
#
# Stock israelhikingmap/graphhopper plus (a) our routing config.yml — which
# carries the `smoothness` encoded value quality-aware routing rides on
# (#779, ADR-0005) — and (b) a start wrapper that clears the graph cache on
# each (re)deploy so a freshly conflated extract is actually re-imported.
#
# Why a custom image: Coolify's image apps expose only "Custom Docker Options",
# not an entrypoint/command field, so the stock image (whose entrypoint bakes
# `-c config-example.yml` and no `-i`) can't be pointed at our extract or made to
# clear the cache. Baking both here avoids all of that — Coolify just runs it.
#
# Build context is THIS directory (infra/graphhopper), which also holds
# config.yml and start.sh. Local dev still uses the plain image + `command:` in
# infra/docker/docker-compose.yml (Compose can set entrypoint/command; Coolify
# can't) — see this folder's README.
FROM israelhikingmap/graphhopper:10.2

# Baked at a non-/data path so the runtime /data volume mount can't hide it.
COPY config.yml /graphhopper/config.yml
COPY start.sh /graphhopper/tarmoto-start.sh
RUN chmod +x /graphhopper/tarmoto-start.sh

ENTRYPOINT ["/graphhopper/tarmoto-start.sh"]
