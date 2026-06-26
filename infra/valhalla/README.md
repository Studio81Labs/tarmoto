# Self-hosted Valhalla (route planner routing engine)

The route planner routes against a local Valhalla (OSS) instead of a public
demo. Chosen for per-request dynamic costing (motorcycle / curvy later, no
rebuild). Czech-Republic extract by default.

## Build + run (first start builds tiles — slow, one-time)

The service is gated behind the `routing` compose profile, so a plain
`docker compose up -d` / `pnpm db:up` does NOT start it (a DB boot won't
trigger the heavy first-run tile build). Start it explicitly:

    docker compose -f infra/docker/docker-compose.yml --profile routing up valhalla
    # first run downloads the extract + builds tiles into infra/valhalla/custom_files
    # (git-ignored); subsequent runs reuse them.

For a larger region, change `tile_urls` in the compose service (e.g.
`https://download.geofabrik.de/europe/dach-latest.osm.pbf`) and delete
`infra/valhalla/custom_files` to force a rebuild.

## Point the backend at it

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
