import type { Response } from 'express';
import {
  setAdminAuthCookies,
  clearAdminAuthCookies,
  setAdminClientCookie,
  clearAdminClientCookie,
} from './admin-auth.cookies.js';
import {
  ADMIN_ACCESS_COOKIE,
  ADMIN_CLIENT_COOKIE,
  ADMIN_REFRESH_COOKIE,
} from './admin-auth.constants.js';

function fakeResponse(): { res: Response; cookies: string[] } {
  let store: string | string[] | undefined;
  const res = {
    getHeader: () => store,
    setHeader: (_name: string, value: string | string[]) => {
      store = value;
    },
  } as unknown as Response;
  return {
    res,
    get cookies() {
      return Array.isArray(store) ? store : store ? [store] : [];
    },
  };
}

describe('admin auth cookies', () => {
  it('sets HttpOnly Lax access + refresh cookies', () => {
    const ctx = fakeResponse();
    setAdminAuthCookies(ctx.res, 'access-token', 'refresh-token', true);
    const joined = ctx.cookies.join('\n');
    expect(joined).toContain(`${ADMIN_ACCESS_COOKIE}=access-token`);
    expect(joined).toContain(`${ADMIN_REFRESH_COOKIE}=refresh-token`);
    expect(joined).toContain('HttpOnly');
    expect(joined).toContain('SameSite=Lax');
    expect(joined).toContain('Secure');
  });

  it('clears cookies with Max-Age=0', () => {
    const ctx = fakeResponse();
    clearAdminAuthCookies(ctx.res, true);
    expect(ctx.cookies.join('\n')).toContain('Max-Age=0');
  });

  it('setAdminClientCookie sets an HttpOnly, Lax, Secure client nonce cookie', () => {
    const ctx = fakeResponse();
    setAdminClientCookie(ctx.res, 'test-nonce-hex', true);
    const joined = ctx.cookies.join('\n');
    expect(joined).toContain(`${ADMIN_CLIENT_COOKIE}=test-nonce-hex`);
    expect(joined).toContain('HttpOnly');
    expect(joined).toContain('SameSite=Lax');
    expect(joined).toContain('Secure');
    // Must have a positive Max-Age (not 0) — the cookie should outlive a page reload.
    expect(joined).not.toContain('Max-Age=0');
  });

  it('clearAdminClientCookie sets Max-Age=0 to expire the client nonce cookie', () => {
    const ctx = fakeResponse();
    clearAdminClientCookie(ctx.res, false);
    const joined = ctx.cookies.join('\n');
    expect(joined).toContain(ADMIN_CLIENT_COOKIE);
    expect(joined).toContain('Max-Age=0');
    expect(joined).toContain('HttpOnly');
    expect(joined).toContain('SameSite=Lax');
    // Not secure when secure=false.
    expect(joined).not.toContain('Secure');
  });

  it('setAdminClientCookie does not set Secure when secure=false', () => {
    const ctx = fakeResponse();
    setAdminClientCookie(ctx.res, 'nonce', false);
    const joined = ctx.cookies.join('\n');
    expect(joined).not.toContain('Secure');
  });
});
