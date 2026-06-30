# Self-hosted GraphHopper (route planner routing engine)

GraphHopper is Tarmoto's **strategic** routing engine ([ADR-0004](../../docs/decisions/0004-routing-engine-graphhopper.md)): road filters and the future "prefer our own road-quality" weighting are expressed as request-time `custom_model` JSON, so they're tuned without rebuilding the engine. Self-hosting also sidesteps the public OSRM demo's inability to honour any `exclude=` flag.

This directory holds the GraphHopper service config; the container is defined in [`../docker/docker-compose.yml`](../docker/docker-compose.yml).

## Build + run (first start imports the graph — slow, one-time)

The service is gated behind the `routing` compose profile, so a plain `docker compose up -d` / `pnpm db:up` does NOT start it (a DB boot won't trigger the heavy first-run import). Unlike the Valhalla image, **GraphHopper does not auto-download the OSM extract** — fetch it first:

```bash
# 1. Download the Czech extract into this directory (git-ignored)
curl -L -o infra/graphhopper/czech-republic-latest.osm.pbf \
  https://download.geofabrik.de/europe/czech-republic-latest.osm.pbf

# 2. Start GraphHopper (first run imports into infra/graphhopper/graph-cache)
docker compose -f infra/docker/docker-compose.yml --profile routing up graphhopper
```

For a larger region, download a different Geofabrik extract over `czech-republic-latest.osm.pbf` (or change `datareader.file` in `config.yml`) and delete `infra/graphhopper/graph-cache` to force a re-import.

## Encoded values: why `toll` + `road_class` matter

The backend maps `RoutingOptions` to a GraphHopper `custom_model`, which references **encoded values** that must exist on the imported graph:

| Avoidance        | Custom-model rule              | Needs encoded value                                   |
| ---------------- | ------------------------------ | ----------------------------------------------------- |
| `avoid_highways` | `road_class == MOTORWAY`       | `road_class` (default import)                         |
| `avoid_tolls`    | `toll == ALL \|\| toll == HGV` | **`toll`** (NOT in the upstream `config-example.yml`) |

`config.yml` here deliberately adds `toll` (and `surface`, for the future road-quality work) to `graph.encoded_values`. Referencing an encoded value the graph doesn't have makes GraphHopper **reject the whole request**, so the backend gates `avoid_tolls` behind whether `toll` is available — see the toll flag below.

## Point the backend at it

Setting `TARMOTO_GRAPHHOPPER_BASE_URL` is what opts the backend into GraphHopper. When it (and `TARMOTO_GRAPHHOPPER_API_KEY`) are unset, the shared routing provider falls back to Valhalla, then OSRM — so commute, trip generation, and the planner `/routing/route` keep working in the default `pnpm db:up` setup. Set this only once the service above is running:

```bash
# apps/backend/.env
TARMOTO_GRAPHHOPPER_BASE_URL=http://localhost:8989
# This self-hosted config provisions the `toll` encoded value, so enable
# avoid_tolls (default for a self-hosted graph is OFF, since the upstream
# example config lacks `toll`):
TARMOTO_GRAPHHOPPER_TOLL_ENABLED=true
```

To use the hosted GraphHopper Directions API instead (zero infra), set `TARMOTO_GRAPHHOPPER_API_KEY` alone — the base URL defaults to `https://graphhopper.com/api/1` and `toll` is enabled automatically.

## Caveats

- **The image is pinned** to `israelhikingmap/graphhopper:10.0` in the compose service (its `latest` is a nightly from GraphHopper master). `config.yml` targets that version's schema — when bumping the tag, diff `config.yml` against the `config-example.yml` shipped with the new image and re-test, since the config / custom-model schema changes between GraphHopper majors.
- The first import needs a few GB of RAM/disk for a country extract. Smaller extracts (e.g. a single region) import faster for local dev.
