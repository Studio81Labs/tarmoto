import { timingSafeEqual } from "node:crypto";
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";

// The header the backend admin proxy injects to prove a request came from
// inside the trusted infra (server-to-server). apps/ingest's /internal/* is
// never internet-exposed — only the backend calls it.
const INTERNAL_TOKEN_HEADER = "x-internal-token";

// Length-guarded constant-time compare — timingSafeEqual throws on a length
// mismatch, and the provided token is attacker-controlled.
function tokensEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Token-only mirror of the backend's InternalGuard (`assertInternalToken`
 * half): gates apps/ingest's `/internal/poi/*` controller with the shared
 * `x-internal-token`. No JWT/role check — that stays the admin edge's job;
 * this is a pure server-to-server gate. Fails closed in production when the
 * token is unset; open in dev/test so the local `pnpm dev` reaches the API
 * without a secret. /healthz is NOT guarded (this is controller-scoped).
 */
@Injectable()
export class IngestInternalGuard implements CanActivate {
  private readonly logger = new Logger(IngestInternalGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const expected = this.config
      .get<string>("TARMOTO_INTERNAL_API_TOKEN")
      ?.trim();

    if (!expected) {
      if (this.config.get<string>("NODE_ENV") === "production") {
        this.logger.warn("internal token not configured — denying");
        throw new UnauthorizedException("Ingest internal API not configured");
      }
      return true;
    }

    const header = request.headers[INTERNAL_TOKEN_HEADER];
    const provided = (Array.isArray(header) ? header[0] : header)?.trim();
    if (!provided || !tokensEqual(provided, expected)) {
      throw new UnauthorizedException("Invalid internal token");
    }
    return true;
  }
}
