import { NextResponse } from "next/server";

// Dependency-free liveness for the container HEALTHCHECK and the deploy
// smoke test: the companion must report healthy even when the backend is
// down (its public map pages degrade, they don't die). Anything heavier
// belongs in the backend's own health surface.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ ok: true });
}
