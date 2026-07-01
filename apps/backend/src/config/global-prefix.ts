import { RequestMethod } from '@nestjs/common';
import type { RouteInfo } from '@nestjs/common/interfaces';
import type { OpenAPIObject } from '@nestjs/swagger';

export const API_GLOBAL_PREFIX = 'api/v1';

// Admin console routes are mounted prefix-less (`/admin/...`), mirroring the
// tabletap/nexcue admin topology: the GitHub OAuth callback and the SSO state
// cookie live on clean `/admin/auth/sso/...` paths and the admin worker proxies
// `/admin/*` to the backend verbatim. The versioned `/api/v1` prefix is for
// consumers we cannot force to upgrade (the mobile app); the admin console
// deploys together with the backend, so versioning its routes buys nothing.
export const GLOBAL_PREFIX_EXCLUDES: RouteInfo[] = [
  { path: 'admin', method: RequestMethod.ALL },
  { path: 'admin/{*splat}', method: RequestMethod.ALL },
];

export function setupGlobalPrefix(app: {
  setGlobalPrefix(prefix: string, options?: { exclude?: RouteInfo[] }): void;
}): void {
  app.setGlobalPrefix(API_GLOBAL_PREFIX, {
    exclude: GLOBAL_PREFIX_EXCLUDES,
  });
}

// SwaggerModule prepends the global prefix to every path and does not honor
// `setGlobalPrefix` excludes, so the generated document must be rewritten to
// match the runtime mounts: `/api/v1/admin/...` paths move back to
// `/admin/...`.
export function stripAdminPathsGlobalPrefix(
  document: OpenAPIObject,
): OpenAPIObject {
  const prefixedAdmin = `/${API_GLOBAL_PREFIX}/admin/`;
  const paths: OpenAPIObject['paths'] = {};
  for (const [path, definition] of Object.entries(document.paths)) {
    const rewritten = path.startsWith(prefixedAdmin)
      ? path.slice(`/${API_GLOBAL_PREFIX}`.length)
      : path;
    paths[rewritten] = definition;
  }
  return { ...document, paths };
}
