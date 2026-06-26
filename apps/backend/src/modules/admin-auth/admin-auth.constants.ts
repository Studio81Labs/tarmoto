export const ADMIN_ACCESS_COOKIE = 'tarmoto_admin_access';
export const ADMIN_REFRESH_COOKIE = 'tarmoto_admin_refresh';
export const ADMIN_SSO_STATE_COOKIE = 'tarmoto_admin_sso_state';

export const ADMIN_ACCESS_TOKEN_SCOPE = 'admin_access';

// 9 minutes access, 30 days refresh.
export const ADMIN_ACCESS_TOKEN_SECONDS = 9 * 60;
export const ADMIN_REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;

// Must match app.setGlobalPrefix(...) in main.ts. Used to normalize admin
// route paths in the InternalGuard and audit interceptor.
export const API_GLOBAL_PREFIX = '/api/v1';

// Grace window for benign concurrent token rotations: two browser tabs sharing
// the same refresh cookie may both POST it nearly simultaneously. If the losing
// tab arrives here within this window and the token was cleanly rotated
// (replaced_by_token_id is set), we treat it as benign and do NOT revoke the
// session family. The winning tab's new token is already in the shared cookie jar.
export const REFRESH_REUSE_LEEWAY_MS = 10_000;
