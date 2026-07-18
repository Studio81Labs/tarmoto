# Road-quality → GraphHopper conflation (#779, ADR-0005)

Feeds Tarmoto's crowdsourced per-segment `road_segments.quality_score` into
GraphHopper so routing can **prefer good-surface roads** (`epic:road-quality`).
GraphHopper weights routes off **encoded values** on its graph edges and has no
"load my per-edge CSV" path, so — per [ADR-0005](../../../../../../docs/decisions/0005-road-quality-routing-via-smoothness.md)
— quality rides in on the **stock `smoothness` encoded value**: the conflation
job injects an OSM `smoothness` tag derived from our score, and the request-time
`custom_model` de-weights the poor tiers. No forked image, no custom parser.

```
road_segments.quality_score ──(this core)──► per-way smoothness assignments
                                              │
                                              ▼
                                inject smoothness tag into derived .osm
                                              │
                                              ▼
                        fire re-import webhook ──► receiver: cache-bust + restart
                                              │              (same-host or remote)
                                              ▼
                                   GraphHopper graph re-import
                                              │
                                              ▼
              RoutingOptions.preferQuality → custom_model over `smoothness`
```

## What lives here

- **`quality-smoothness.ts`** — the pure `quality_score → smoothness` mapping.
  `quality_score` is continuous in `[1, 5]`; it maps to the nearest ADR-0005
  tier (`1 → very_bad … 5 → excellent`). `NULL`/non-finite → no tag, so an
  unscored road stays `MISSING`/neutral and is **never penalised**. Single
  source of truth for the boundaries; unit-tested in one place.
- **`quality-conflation.service.ts`** — `QualityConflationService`:
  - `buildConflation()` joins our ~100 m segments back to their OSM way via
    `osm_way_id`, collapses each way to a **length-weighted mean** of its live,
    scored segments, maps that to a `smoothness` tier, and returns the per-way
    `WaySmoothnessAssignment[]`.
  - `runConflation()` runs `buildConflation()` then streams the configured input
    `.osm` extract to the output path, injecting the tags — the artifact the
    GraphHopper re-import consumes.
- **`smoothness-injection.ts`** — the streaming OSM-XML rewriter. Passes every
  element through (nodes, ways, relations, bounds) and writes
  `<tag k="smoothness" v="…"/>` onto each matched way, **replacing** any existing
  `smoothness` so re-running is idempotent. Semantically (not byte-) faithful;
  bounded memory (one way in flight).
- **`graphhopper-reimport.service.ts`** — `GraphHopperReimportService.trigger()`
  fires the configured re-import webhook after a successful conflation (see
  [Re-import orchestration hook](#re-import-orchestration-hook)). No-op when
  unconfigured; throws on a failed webhook so the job retries.
- **`*.config.ts`** — `TARMOTO_QUALITY_CONFLATION_ENABLED` (default off) +
  input/output `.osm` paths (no region config — conflation is whole-network,
  see below), and the `TARMOTO_GRAPHHOPPER_REIMPORT_WEBHOOK_*` webhook
  settings.
- Wired as the **`quality.conflation` BullMQ queue** (`jobs.constants.ts`),
  processed by `QualityConflationProcessor` (which runs the conflation then fires
  the re-import hook). It is **not** independently scheduled: the OSM import
  processor enqueues it as a **success-continuation**, so it only runs after a
  successful import and can never race a long-running or failed one (a fixed
  02:00 cron could). Dormant (the processor no-ops) unless enabled.

### Behaviour

- **Live only.** Tombstoned segments (`deactivated_at IS NOT NULL`, #835) are
  excluded, so a road removed from OSM stops contributing stale quality.
- **Scored only.** Ways whose segments are all `quality_score IS NULL` produce
  no assignment (neutral), matching the request-time no-op contract.
- **Owns the `smoothness` channel.** The injector strips **every** source
  `smoothness` tag (ADR-0005): a matched way gets our conflated value; an
  unscored way is left with none → `MISSING`/neutral. Otherwise a source
  `smoothness=bad` on a road we have no data for would be de-weighted by
  `preferQuality` — penalising it against the contract.
- **Atomic output.** The derived extract is written to a temp sibling and
  renamed on success, so a failed/partial run never truncates the last good
  extract GraphHopper imports.
- **Whole network.** The job always scores every live, scored way — the road
  import now spans multiple independently-refreshed regions (the folder model,
  Sub-project B), so no single import bbox describes the covered area anymore.
  The operator-provided input extract (`TARMOTO_QUALITY_CONFLATION_INPUT_FILE`)
  bounds which ways actually get tagged in the derived output.
- **Idempotent.** Reads current aggregates only; re-running yields the same
  artifact until the underlying scores change.

### Resolution caveat

OSM tags attach to whole ways, but quality is per ~100 m segment, so the per-way
length-weighted mean loses sub-way resolution (ADR-0005). Splitting ways at
segment boundaries for full fidelity is a future refinement once the per-way
loss is measured on a real region.

## Operator prep

Point the job at the extract to tag (normally the same one GraphHopper imports)
and a derived output path on a volume GraphHopper can read, and enable it:

```bash
TARMOTO_QUALITY_CONFLATION_ENABLED=true
TARMOTO_QUALITY_CONFLATION_INPUT_FILE=/data/czech.osm       # osmium-produced .osm XML
TARMOTO_QUALITY_CONFLATION_OUTPUT_FILE=/data/czech.quality.osm
# no region config — conflation always scores the whole live network
```

The job writes `…/czech.quality.osm` after each successful OSM import; point the
**GraphHopper import at that file** (`-i /data/czech.quality.osm`, or convert to
`.pbf` with `osmium cat`) so the fresh `smoothness` bakes into the graph.

## Re-import orchestration hook

GraphHopper has no re-import API and reuses its existing graph on restart, and it
may run in a sibling container or on a separate VPS — so the backend does not
restart it directly. After a successful conflation, `QualityConflationProcessor`
fires a **generic authenticated webhook** (`GraphHopperReimportService`); the
receiver owns the cache-bust + restart. GraphHopper's location is therefore a
config detail, not a code change:

```bash
# unset → no-op (the extract is still written; re-import manually)
TARMOTO_GRAPHHOPPER_REIMPORT_WEBHOOK_URL=https://…/reimport
TARMOTO_GRAPHHOPPER_REIMPORT_WEBHOOK_TOKEN=…        # optional → Authorization: Bearer …
TARMOTO_GRAPHHOPPER_REIMPORT_WEBHOOK_METHOD=POST    # or GET (e.g. Coolify /api/v1/deploy)
```

A configured webhook that returns non-2xx or can't connect **throws**, so the job
fails visibly and BullMQ retries (the file write is idempotent) rather than
leaving routing silently stale. The query string is redacted in logs/errors so a
token/UUID never leaks.

**Receiver contract** — whatever the URL points at must, on each call:

1. make the derived extract GraphHopper's input (shared volume same-host, or
   sync/copy to the remote host), then
2. delete GraphHopper's **graph directory** and restart it (its start
   re-imports). The path depends on launch flags: `graphhopper.sh` forces the
   graph location to its `GRAPH` default `/data/default-gh` unless `-o` is passed,
   so the **deployed** image (no `-o`) uses `/data/default-gh` while **local
   compose** (`-o /data/graph-cache`) uses `/data/graph-cache`. Clearing the wrong
   one is a silent no-op that leaves the stale graph serving.

Concretely:

- **Same host, sibling container (default).** Point the URL at your orchestrator's
  redeploy hook for the GraphHopper service (this repo deploys via the Coolify
  API — a Coolify deploy webhook fits). The deployed image's baked `start.sh`
  ENTRYPOINT clears `/data/default-gh` on each start, so a plain redeploy
  re-imports — **but only if that ENTRYPOINT actually runs** (see the runbook's
  step 4 caveat); otherwise run a tiny sidecar that does `rm -rf /data/default-gh`
  - `docker restart tarmoto-graphhopper`. (Local compose clears its own
    `/data/graph-cache` via the compose `-o`.)
- **Separate VPS.** The same webhook on the other host (its own Coolify/sidecar);
  the only extra step is getting the derived file there (object-store sync or
  `scp` in the receiver) before the restart.

## Still needs running infra — the proof

The one thing left that can't be produced in-repo: show a `preferQuality` route
demonstrably avoiding a low-quality way vs the baseline on the Czech extract
(ADR-0005's Phase-1 acceptance) once the above is wired against a live graph.

Until the graph carries the tag, `GraphHopperProvider.preferQuality` stays a
no-op behind `TARMOTO_GRAPHHOPPER_QUALITY_ENABLED` (default off) — the
request-time layer is already shipped and safe ahead of the data, like `toll`.
