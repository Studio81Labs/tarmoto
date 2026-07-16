import { Controller, Get } from "@nestjs/common";

@Controller()
export class HealthController {
  // Cheap liveness probe for the container healthcheck (no DB/Redis hop).
  @Get("healthz")
  getHealth(): { status: "ok" } {
    return { status: "ok" };
  }
}
