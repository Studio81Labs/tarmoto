# Design System Documentation

_Started 2026-05-17 11:36 UTC_

---

## User

for the "Web app v2" we need a design map for components, rules for colors etc. Everything the developer can use to design correct styles

## Assistant

_[tool: list_files]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: update_todos]_

I'll build a developer-facing design map for Web App v2 — a single reference document with all the tokens, components, patterns, and rules pulled straight from the app.

Let me set up todos and start building.

_[tool: write_file]_

_[tool: update_todos]_

_[tool: done]_

_[tool: fork_verifier_agent]_

A developer-facing design map for Web App v2 is up — long-scroll reference doc structured as 21 sections under five groups (Foundations, Atoms, Components, Maps, Patterns) with a sticky ink-rail nav.

What's inside:

- **Color** — surfaces, foreground alphas, lines, the full Q1–Q5 quality scale across all three palettes (traffic / muted / mono), plus the accent-budget rules
- **Type** — three families with role assignments, a full specimen table (display → stamp), and the three pairing patterns the app actually uses
- **Spacing, radii, shadow** — token tables with visual scale bars
- **Atoms** — Stamp, Mono, Heading, Pill, Dot, QualityBars, Card with a JSX usage cheat-sheet
- **Components** — Pill variants, form controls (toggle/segment/slider/radio/number-grid/swatch), Card flavors, Metric tile (with anatomy callouts), Road preview card (default + active + density), Nav rail, Data table, Tweaks panel
- **Map vocabulary** — six glyphs with SVG samples + z-order strip, plus the three map modes side by side
- **Layouts** — the four shells (3-col planner, 2-col explorer, single column, sidebar) with the surface contract table
- **Density + Do/Don't** — the short list of governing rules

All values pulled directly from `Web App v2.html` and `colors_and_type.css` so it stays in lockstep with what's shipping.

## User

perfect, one missing overlays on maps

## User

some map info, points definitions etc

## Assistant

_[tool: read_file]_

Good call — current section 17 is shallow. Let me expand map vocabulary with point states, label rules, clustering, and the underlying coordinate system.

_[tool: grep]_

_[tool: read_file]_

_[tool: str_replace_edit]_

_[tool: grep]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Remove the marker now:

_[tool: str_replace_edit]_

_[tool: done]_

Expanded section **17 · Map vocabulary** with the missing detail:

- **Point catalogue** — table of all 5 primitives (town, peak/pass, waypoint, hazard, collab cursor) with geometry, label rule, z-band, and cluster behaviour
- **Point states** — waypoint (default / hover / selected / dragging), hazard (unconfirmed / confirmed-with-halo / resolved / stale), cluster glyphs (hazard cluster / waypoint cluster / selected cluster), and the tooltip card
- **Label placement** — anchor diagram with the +14 / +4 offset rule, edge clamping, anti-collision priority, font assignments
- **Lines & areas table** — every linework primitive (topo contour, river, fun zone, road base, quality ribbon, drawn region, other rider trace) with stroke/fill specs and z-bands
- **Canvas & coordinates** — 1200×820 viewBox + projection contract + density-limit table for clustering thresholds
- **Rules** — do/don't (scale vs importance, cream rings on-road, cluster early; no 6th type, no zoom scaling, no emoji)

## User

Save as standalone HTML: Web App v2 Design Map.html

## Assistant

_[tool: copy_files]_

_[tool: str_replace_edit]_

_[tool: grep]_

_[tool: grep]_

_[tool: str_replace_edit]_

_[tool: super_inline_html]_

_[tool: show_html]_

_[tool: show_html]_

_[tool: get_webview_logs]_

_[tool: present_fs_item_for_download]_

Standalone bundle ready — 699 KB, fonts inlined, works fully offline.
