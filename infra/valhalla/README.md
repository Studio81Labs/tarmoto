# Self-hosted Valhalla (route planner routing engine)

The route planner routes against a local Valhalla (OSS) instead of a public
demo. Chosen for per-request dynamic costing (motorcycle / curvy later, no
rebuild). Default coverage is the CZ → AT → SI → HR (+HU) corridor so
central-Europe test routes (e.g. Prague → Split) work out of the box.

## Build + run (first start builds tiles — slow, one-time)

The service is gated behind the `routing` compose profile, so a plain
`docker compose up -d` / `pnpm db:up` does NOT start it (a DB boot won't
trigger the heavy first-run tile build). Start it explicitly:

    docker compose -f infra/docker/docker-compose.yml --profile routing up valhalla
    # first run downloads the extract + builds tiles into infra/valhalla/custom_files
    # (git-ignored); subsequent runs reuse them.

For a different region, change `tile_urls` in the compose service (it takes
a space-separated list of Geofabrik extracts) and delete
`infra/valhalla/custom_files` to force a rebuild. Routing outside the built
extracts fails or snaps to the nearest covered road — coverage is exactly
the union of the listed extracts. Full `europe-latest.osm.pbf` works in
principle but means a ~30 GB download, a 6h+ tile build, and >32 GB RAM —
prefer listing the countries you actually ride.

## Point the backend at it

Setting `TARMOTO_VALHALLA_BASE_URL` is what opts the backend into Valhalla. When
it is unset, the shared routing provider (commute, trip generation, and the
planner `/routing/route`) falls back to OSRM (public demo by default), so those
features keep working in the default `pnpm db:up` setup without a local Valhalla.
Set this only once the Valhalla service above is running:

    # apps/backend/.env
    TARMOTO_VALHALLA_BASE_URL=http://localhost:8002

## Verify

    curl -s http://localhost:8002/route \
      -H 'Content-Type: application/json' \
      --data '{"locations":[{"lat":50.08,"lon":14.42},{"lat":50.10,"lon":14.50}],"costing":"auto","directions_options":{"units":"kilometers"}}'
    # -> {"trip":{"legs":[{"shape":"...","summary":{...}}],"summary":{...},"status":0}}

## Coolify (production)

Run the same image as a service with a persistent volume mounted at
`/custom_files` and the same `tile_urls` env. First boot builds tiles into the
volume; set `TARMOTO_VALHALLA_BASE_URL` on the backend to the service URL.
