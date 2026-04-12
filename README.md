# Tarmoto

> **Know the road before you ride it.**

The motorcycle app that tells you how good the actual road surface is — not just how curvy it looks on a map. Crowdsourced road quality intelligence, real-time hazard alerts, and a multi-day trip planner that replaces hours of Street View scouting.

## Status

**Phase: Concept validation**

- [x] Product Requirements Document
- [x] Wireframes (8 core screens)
- [x] System architecture
- [x] Database schema
- [x] PoC sensor app (accelerometer + GPS)
- [x] Landing page + waitlist
- [x] Brand identity
- [ ] Accelerometer data validation (real rides)
- [ ] ML model specification
- [ ] API design (OpenAPI)
- [ ] MVP development

## Docs

| Document | Description |
|----------|-------------|
| [Tarmoto_PRD_v1.docx](docs/Tarmoto_PRD_v1.docx) | Product Requirements — vision, epics, 30 user stories, roadmap |
| [schema.sql](docs/schema.sql) | PostgreSQL + PostGIS database schema (15 tables) |
| [wireframes.jsx](docs/wireframes.jsx) | Interactive wireframes — 8 core screens |
| [database_erd.html](docs/database_erd.html) | Entity relationship diagram |

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Client: React Native (iOS + Android + CarPlay/AA)  │
│  On-device: TensorFlow Lite (road classification)   │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  API Gateway: REST + WebSocket · JWT · Rate limiting │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  Services: Route Engine │ Trip Planner │ Safety │    │
│            Community │ Commute                       │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  Processing: Road Quality ML │ Tile Server │ Events  │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  Storage: PostgreSQL/PostGIS │ Redis │ S3 │ Timescale│
└─────────────────────────────────────────────────────┘
```

## Key differentiators

1. **Crowdsourced road surface quality** — accelerometer-based, every rider is a sensor
2. **Smart multi-day trip planner** — Fun Zone discovery, no more Street View scouting
3. **Real-time hazard alerts** — Waze-style, motorcycle-specific
4. **Commuter mode** — daily rider features, not just weekend touring
5. **Road preview cards** — surface quality, curves, hazards, reviews per segment

## Tech stack

- **Mobile**: React Native + Expo
- **Maps**: MapLibre GL + custom vector tiles
- **Backend**: NestJS or FastAPI
- **Database**: PostgreSQL + PostGIS
- **ML**: TensorFlow Lite (on-device) + Python (server)
- **Real-time**: WebSockets + Redis Pub/Sub
- **Cloud**: AWS (ECS, RDS, S3, CloudFront)

## Related repos

- [GetTarmoto/web](https://github.com/GetTarmoto/web) — Landing page, PoC sensor, brand assets

## License

Proprietary — All rights reserved.
