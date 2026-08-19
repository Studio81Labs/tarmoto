# Tarmoto brand reference

This directory is reference material for the Tarmoto visual identity.
It is intentionally **static** — no Vite app, no build step, no
runtime dependency. Anyone (designer, dev, marketing) can read it on
GitHub or in any editor without setup.

The canonical source of truth for live values is
[`apps/marketing/app/globals.css`](../../../apps/marketing/app/globals.css)
under `:root { … }`. When that file changes, update this document.

## Logo

| File                                                   | Use                                                                                           |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| [`logo-mark.svg`](./logo-mark.svg)                     | Road-grey mark on transparent. Light backgrounds.                                             |
| [`logo-mark-on-accent.svg`](./logo-mark-on-accent.svg) | Mark on the coral-orange rounded square. Primary nav + favicon style.                         |
| [`logo-mark-inverse.svg`](./logo-mark-inverse.svg)     | Cream mark on transparent. Use on dark surfaces when the accent square is too loud.           |
| [`wordmark.svg`](./wordmark.svg)                       | Mark on accent + "Tarmoto" cream wordmark. Use horizontally for hero/footer-style placements. |

The wordmark SVG falls back to a generic sans-serif when Space Grotesk
isn't loaded. Re-export from Figma with the text outlined (or with a
subset font embedded) for production use.

## Colour palette

All hex values mirror `:root` in `apps/marketing/app/globals.css`.

### Brand accent — coral orange (warm, tactile)

| Token            | Hex       | Notes                                                                                     |
| ---------------- | --------- | ----------------------------------------------------------------------------------------- |
| `--accent`       | `#FF6A1A` | Primary brand orange. CTA buttons, the nav-logo square, the orange dot in the hero badge. |
| `--accent-top`   | `#FF7A26` | Top stop of CTA / accent-square gradients.                                                |
| `--accent-soft`  | `#FF9A62` | Soft glow + sunset-halo tints.                                                            |
| `--accent-deep`  | `#D94F08` | Deep shadow / glow-warm halos.                                                            |
| `--ink-warm`     | `#1A120D` | Button text on accent. Warmer than ink black — reads as anodised hardware, not plastic.   |
| `--surface-good` | `#E28A3B` | Heated-metal mid stop, used sparingly for glows.                                          |
| `--surface-best` | `#FFB347` | Heated-metal highlight, e.g. the "PLANNED" badge on the pricing card.                     |

### Surfaces — asphalt-warm dark

| Token          | Hex       | Notes                                                                |
| -------------- | --------- | -------------------------------------------------------------------- |
| `--bg`         | `#0B0D10` | Page background.                                                     |
| `--panel`      | `#12161B` | Card surfaces, footer background.                                    |
| `--panel-2`    | `#171C22` | Elevated panels (waitlist dialog, cookie banner, planner sidebar).   |
| `--panel-3`    | `#20262E` | Hover state + the deeper button background.                          |
| `--road`       | `#2A2E35` | Dark grey — used in the logo mark strokes and the map zoom controls. |
| `--road-light` | `#3A4048` | Hairline-darker than the body text scale.                            |

### Text scale — cream, never pure white

| Token     | Hex / value                 | Notes                                  |
| --------- | --------------------------- | -------------------------------------- |
| `--text`  | `#E8E5DE`                   | Primary text colour. Cream, off-white. |
| `--dim`   | `rgba(232, 229, 222, 0.62)` | Secondary text, body copy.             |
| `--mute`  | `rgba(232, 229, 222, 0.40)` | Tertiary text, stamps, captions.       |
| `--faint` | `rgba(232, 229, 222, 0.22)` | Decorative / disabled.                 |

### Hairlines

| Token      | Value                       |
| ---------- | --------------------------- |
| `--line`   | `rgba(232, 229, 222, 0.08)` |
| `--line-2` | `rgba(232, 229, 222, 0.16)` |

### Road-quality scale (q1–q5)

Calmer than primary colours so the map doesn't fight the brand.

| Token  | Hex       | Meaning                                   |
| ------ | --------- | ----------------------------------------- |
| `--q1` | `#B0473A` | Avoid — broken surface or flagged hazard. |
| `--q2` | `#C0784A` | Rough — patchy, slow-speed only.          |
| `--q3` | `#C9A656` | OK — commutable, fine in the dry.         |
| `--q4` | `#A8BE6A` | Great — smooth, well-swept asphalt.       |
| `--q5` | `#7AB785` | Hero — ribbon tarmac, worth the detour.   |

### Utility

| Token    | Hex       | Notes                                                                               |
| -------- | --------- | ----------------------------------------------------------------------------------- |
| `--sync` | `#4DB6AC` | Muted teal — sync, success, location states only. **Never** used as a brand accent. |

### Glows

| Token              | Value                                        | Notes                              |
| ------------------ | -------------------------------------------- | ---------------------------------- |
| `--glow-warm`      | `0 24px 60px -28px rgba(217, 79, 8, 0.45)`   | Pricing-card highlight + CTA halo. |
| `--glow-warm-soft` | `0 12px 40px -18px rgba(255, 154, 98, 0.30)` | Lighter sunset halo.               |

## Typography

Three Google Fonts. All three are loaded once via `next/font/google`
in [`apps/marketing/app/layout.tsx`](../../../apps/marketing/app/layout.tsx)
and exposed as CSS variables.

### Space Grotesk — primary UI

- CSS variable: `--font-space-grotesk` (also aliased to `--font`)
- Weights loaded: 400, 500, 600, 700
- Use for body copy, nav, buttons, labels, almost everything

### Fraunces — serif display

- CSS variable: `--font-fraunces` (also aliased to `--serif`)
- Loaded with the `opsz` optical-size axis (variable font)
- Use for section headlines, hero title, founder quote, dialog titles
- The italic `<em>` variant pairs with the orange accent for the
  hero's "real screen." / final CTA's "worth riding." moments

### JetBrains Mono — stamps, timestamps, technical labels

- CSS variable: `--font-jetbrains-mono` (also aliased to `--mono`)
- Weights loaded: 400, 500, 600, 700
- Use for section eyebrows (`§ 01`), timestamps, KPIs in the hero
  panel mock, currency / planner labels, anything that should read
  as machine output. Standard letter-spacing for stamps is `0.15em`,
  uppercase.

### Helper utility classes

- `.mono` — `font-family: var(--mono)`
- `.serif` — `font-family: var(--serif)`
- `.stamp` — small uppercase mono label with `0.15em` letter-spacing
- `.h-display` — Fraunces, `font-weight: 400`, `letter-spacing: -0.025em`

## Logo usage rules

- Keep at least one mark-height of clear space around the logo on
  every side. Don't crop, rotate, or recolour outside the swatches
  in this document.
- Prefer the on-accent variant for header/nav placements where the
  brand needs to read at a glance. Use the inverse cream variant on
  rich photographic backgrounds where the orange would fight other
  content.
- The wordmark belongs on dark surfaces only. There is no light-mode
  wordmark — the brand currently ships dark-only.

## Companion design spec

The companion app (`apps/companion/`) has its own canonical design
package — cream-on-ink rather than the marketing site's dark-asphalt
theme. The two share brand DNA (the accent orange, the type families,
the quality scale) but differ in surface treatment, atom sizing, and
component vocabulary because they're optimised for different rider
contexts.

See [`docs/design/companion-spec/`](../companion-spec/) for:

- `source/` — the frozen Claude Design handoff (atoms.jsx,
  colors_and_type.css, Web App v2.html, Web App v2 Design Map.html,
  SKILL.md, chat transcripts, ui_kits/web/)
- `README.md` — the migration plan, atom drift audit, six core rules,
  and the upstream→vendored path translation table

This brand reference covers the marketing site; the companion spec
covers the companion. Both stay aligned on the brand-level tokens
documented above.

## Updating

When `apps/marketing/app/globals.css` changes a token, update the
matching row in this document. There is no automation — the file is
small enough that a manual sync on touch is fine.
