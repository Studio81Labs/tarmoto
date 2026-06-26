export const ADMIN_ACCESS_COOKIE = 'tarmoto_admin_access';
export const ADMIN_REFRESH_COOKIE = 'tarmoto_admin_refresh';
export const ADMIN_SSO_STATE_COOKIE = 'tarmoto_admin_sso_state';
export const ADMIN_CLIENT_COOKIE = 'tarmoto_admin_client';

export const ADMIN_ACCESS_TOKEN_SCOPE = 'admin_access';

// 9 minutes access, 30 days refresh.
export const ADMIN_ACCESS_TOKEN_SECONDS = 9 * 60;
export const ADMIN_REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;

// The client nonce cookie shares the same lifetime as the refresh token so
// both expire together. It is a stable, non-rotated httpOnly cookie that ties
// a browser jar to its session — used to distinguish a benign sibling-tab
// replay from a genuine token-theft replay on the refresh endpoint.
export const ADMIN_CLIENT_COOKIE_SECONDS = ADMIN_REFRESH_TOKEN_SECONDS;

// Must match app.setGlobalPrefix(...) in main.ts. Used to normalize admin
// route paths in the InternalGuard and audit interceptor.
export const API_GLOBAL_PREFIX = '/api/v1';
