import type { Response } from 'express';
import {
  setAdminAuthCookies,
  clearAdminAuthCookies,
} from './admin-auth.cookies.js';
import {
  ADMIN_ACCESS_COOKIE,
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
});
