export interface AdminAccessTokenPayload {
  sub: string; // admin_user id
  sid: string; // admin_session id
  scope: string; // ADMIN_ACCESS_TOKEN_SCOPE
}
