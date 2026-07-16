import { UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { IngestInternalGuard } from "./internal.guard.js";

function ctx(headers: Record<string, string | string[]>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

function cfg(values: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

describe("IngestInternalGuard", () => {
  it("allows any request when no token is configured outside production", () => {
    const guard = new IngestInternalGuard(cfg({ NODE_ENV: "test" }));
    expect(guard.canActivate(ctx({}))).toBe(true);
  });

  it("fails closed in production when no token is configured", () => {
    const guard = new IngestInternalGuard(cfg({ NODE_ENV: "production" }));
    expect(() => guard.canActivate(ctx({}))).toThrow(UnauthorizedException);
  });

  it("accepts a matching x-internal-token", () => {
    const guard = new IngestInternalGuard(
      cfg({ TARMOTO_INTERNAL_API_TOKEN: "s3cret" }),
    );
    expect(guard.canActivate(ctx({ "x-internal-token": "s3cret" }))).toBe(true);
  });

  it("rejects a missing or mismatched token", () => {
    const guard = new IngestInternalGuard(
      cfg({ TARMOTO_INTERNAL_API_TOKEN: "s3cret" }),
    );
    expect(() => guard.canActivate(ctx({}))).toThrow(UnauthorizedException);
    expect(() =>
      guard.canActivate(ctx({ "x-internal-token": "wrong" })),
    ).toThrow(UnauthorizedException);
  });
});
