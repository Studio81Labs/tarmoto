# Tarmoto Design System

> Know the road before you ride it.

Tarmoto is a road-quality map for motorcyclists, built from the sensors in your phone. This design system documents the visual language used across three products:

- **Mobile app** — the rider-facing product (iOS + Android). Ride Mode, Trip Planner, Hazard Reports, Post-ride Summary, etc.
- **Web companion** — a desktop planner/explorer for mapping loops, reviewing ride history, managing account.
- **Marketing site** — the public landing + waitlist/launch site.

All three share one palette, one type system, and one core vocabulary (quality bars, stamps, cream+ink asphalt tones).

---

## Sources

This system was extracted from designs in this project:

- `atoms.jsx` — shared React atoms (Stamp, Pill, QualityBars, RouteMini)
- `App Tour.html` — 8 mobile screens on a canvas
- `Ride Mode.html` — hi-fi ride-mode interactive prototype
- `Web App v2.html` — cream/warm web companion
- `Marketing Site.html` + `Marketing Site Prelaunch.html` — public site, both post-launch and pre-launch variants

---

## Content fundamentals

**Voice.** Cartographer meets rider. Technical where it needs to be, warm where it can be. First-person plural for the team ("we ride every feature"), second-person for the rider ("your next road").

**Tone.** Honest, a little wry. Writes the way a senior rider talks — assumes competence, never condescends. Avoids hype words ("revolutionary", "seamless"). Avoids exclamation marks.

**Casing.**

- Sentence case for UI (`Start ride`, `Trip planner`)
- ALL-CAPS for mono stamps (`SURFACE`, `NOW RIDING`, `BETA · LAUNCHING SUMMER 2026`)
- Serif italic for the emotional beats in headlines (`We're building it with you.`, `Not read.`)

**Pronouns.** You (the rider) for product copy. We (the team) for brand copy. Never "users".

**Numbers and units.** Always with units, always monospace (`22 km`, `+1,536 m`, `2,757 m`, `9:41`). Metric by default. Compact: `186k`, `2.8M`.

**Emoji.** None in product UI. Very sparingly in marketing (one lock 🔒 in prelaunch hero copy). Prefer Unicode arrows (→, ⟵, ↓) and geometric marks (§, ★, ●, ✓).

**Example copy patterns:**

- Marketing: "A map of every road worth riding. _We're building it with you._"
- Product state: "Now riding · Day 1"
- Empty/value prop: "Built to be glanced at. _Not read._"
- Stats stamp: "1,284 ZONES WORLDWIDE"

---

## Visual foundations

### Palette

- **Cream** `#F5EFE6` — primary background. Warm, paper-like.
- **Ink** `#0E0E10` — primary text and inverted surfaces.
- **Accent** `#FF6A1A` — orange. Used for focus, highlight, one accent per view. Never for more than ~5% of pixels.
- **Tarmac** `#2B2C30` — dark panel for ride-mode HUD.
- **Paper** `#EDE6DA` / `#E5DBCB` — warm neutrals, card backgrounds.

### Quality scale (domain-specific)

A five-stop warm-to-green ramp for road quality. Always rendered as `QualityBars`:

- Q1 `#E05A3C` Avoid · Q2 `#F0A03C` Rough · Q3 `#E8D66A` OK · Q4 `#C7D36A` Great · Q5 `#6FD38A` Hero

### Type

Three families, all free on Google Fonts:

- **Space Grotesk** — UI / body / headings. Weights 400/500/600/700/800.
- **JetBrains Mono** — stamps, labels, numbers, coordinates. Weights 400/500/600/700.
- **Fraunces** — serif italic for emotional marketing beats only (headlines, pull quotes). Not used in product UI.

Type rules:

- Stamps are ALL-CAPS, 10–11px, JetBrains Mono, letter-spacing 1.2–1.5
- Body is Space Grotesk 14–16px
- Numbers are always mono (ride stats, km counts, timestamps)
- Fraunces italic is the only italic — never italicize Space Grotesk

### Spacing & rhythm

4-pt grid. Card padding 20–32. Section gaps 24–28. Marketing sections 120 top/bottom. Phone screens 16–18 horizontal inside the device.

### Radii

- 6–8 — pills, small chips
- 10–12 — buttons, inputs
- 14–18 — cards
- 20–38 — device frames, hero panels
- 999 — capsules, badges

### Elevation

Almost no drop shadow. Paper-on-paper; rely on 1px borders (`rgba(14,14,16,0.10)`) and background tone shifts. Only the phone mock and a couple of hover states carry real shadow.

### Borders

`1px solid rgba(14,14,16,0.10)` for light surfaces. `1px solid rgba(245,239,230,0.12)` on dark. No thick / colored borders.

### Imagery

Hand-drawn SVG maps (topo lines + quality-colored road ribbons). No photography in product UI. Marketing may use real rider photos but currently uses illustrated placeholders only.

### Motion

Sparing. Hazard pings pulse (1.6s). Waitlist success slides in. No page transitions, no parallax. Easing: `ease-out` by default.

### States

- Hover: slight background tone shift (paper → paper-2), never color change
- Press: no shrink, no shadow — just inverse tone
- Focus: 2px accent outline on interactive inputs

---

## Iconography

No icon font. All icons are hand-rolled SVG or Unicode chars matching the technical/geometric vibe:

- Arrows: → ⟵ ↓
- Geometric: § ★ ● ✓ ▶
- Triangle mark for the logo (simple mountain glyph)

For places needing more, recommend **Lucide** (stroke 1.5–2, rounded) — matches the type's geometric sans feel.

---

## Index

```
colors_and_type.css    — CSS variables for tokens and semantic styles
atoms.jsx              — Shared React atoms (Stamp, Pill, QualityBars, RouteMini)
preview/               — Individual cards that populate the Design System tab
ui_kits/mobile/        — Mobile UI kit (iOS device frame, ride HUD, screens)
ui_kits/web/           — Web companion UI kit
ui_kits/marketing/     — Marketing landing UI kit
SKILL.md               — Portable skill file for agent use
```

---

## Usage with agents

Drop this folder into a Claude/Claude Code project and invoke the `tarmoto-design` skill (see `SKILL.md`) when prototyping. The agent will read this README, pick tokens from `colors_and_type.css`, and assemble screens using components from the UI kits.

Substitutions flagged:

- Space Grotesk, JetBrains Mono, Fraunces — all available on Google Fonts, no licensing action needed.
- No custom fonts.
- No logo SVG currently — the triangle mountain glyph is inlined in every product file. Ask design for a lockup when one exists.
