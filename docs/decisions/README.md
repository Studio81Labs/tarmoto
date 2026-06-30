# Architecture Decision Records (ADRs)

This folder holds Architecture Decision Records. An ADR captures a non-obvious architectural choice so future readers understand **why** the codebase looks the way it does — not just **what** it does.

## When to write an ADR

Write one when:

- You make a choice that is **non-obvious** or could reasonably have gone another way.
- The choice will **constrain future work** in a way that's not visible from reading the code.
- You pick a technology, pattern, or tradeoff that someone onboarding would otherwise have to re-derive.

Don't write one for:

- Trivial or reversible decisions.
- Details that are already obvious from the code or the product spec.
- Things that are better captured as docs under `../reference/` or `../process/`.

## Naming

`NNNN-short-slug.md` with a zero-padded sequence number. Example: `0001-typeorm-over-prisma.md`.

## Template

```markdown
# NNNN — <short, declarative title>

**Status:** Proposed | Accepted | Superseded by ADR-NNNN
**Date:** YYYY-MM-DD

## Context

What forces are at play? What problem are we solving? Keep this tight — a few paragraphs.

## Decision

What did we decide? One or two paragraphs.

## Consequences

What does this choice enable? What does it cost? What becomes harder?

## Alternatives considered

Briefly: what else did we look at, and why not?
```

## Existing decisions

- [0001 — TypeORM over Prisma for the backend](./0001-typeorm-over-prisma.md)
- [0002 — Nominatim as the geocoding provider](./0002-geocoding-provider.md)
- [0003 — Subscription pricing is EUR-denominated and EUR-displayed](./0003-subscription-pricing-currency.md)
- [0004 — GraphHopper as the routing engine for road-filter & quality-weighted routing](./0004-routing-engine-graphhopper.md)

## Candidates worth writing up

Implicit decisions in the current codebase that would benefit from an ADR:

- **Metric-only backend** — clients convert for display to avoid unit drift in persisted data.
- **Zustand for state on both mobile and companion** — consistency across surfaces.
- **Next.js App Router for companion** — adopted April 2026 after migrating from a Vite + React dashboard.
- **On-device TF Lite classification** — privacy and offline behavior over server-side inference.

Pick the one that would've surprised you most on day 1; write that ADR first.
