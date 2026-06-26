import type { Request, Response } from 'express';
import {
  ADMIN_ACCESS_COOKIE,
  ADMIN_ACCESS_TOKEN_SECONDS,
  ADMIN_REFRESH_COOKIE,
  ADMIN_REFRESH_TOKEN_SECONDS,
  ADMIN_SSO_STATE_COOKIE,
} from './admin-auth.constants.js';

interface CookieOptions {
  httpOnly?: boolean;
  maxAgeSeconds?: number;
  path?: string;
  sameSite?: 'Lax' | 'Strict' | 'None';
  secure?: boolean;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (rawKey === name) {
      try {
        return decodeURIComponent(rawValue.join('='));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function setAdminAuthCookies(
  response: Response,
  accessToken: string,
  refreshToken: string,
  secure: boolean,
): void {
  appendCookie(response, ADMIN_ACCESS_COOKIE, accessToken, {
    httpOnly: true,
    maxAgeSeconds: ADMIN_ACCESS_TOKEN_SECONDS,
    path: '/',
    sameSite: 'Lax',
    secure,
  });
  appendCookie(response, ADMIN_REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    maxAgeSeconds: ADMIN_REFRESH_TOKEN_SECONDS,
    path: '/',
    sameSite: 'Lax',
    secure,
  });
}

export function clearAdminAuthCookies(
  response: Response,
  secure: boolean,
): void {
  for (const name of [ADMIN_ACCESS_COOKIE, ADMIN_REFRESH_COOKIE]) {
    appendCookie(response, name, '', {
      httpOnly: true,
      maxAgeSeconds: 0,
      path: '/',
      sameSite: 'Lax',
      secure,
    });
  }
}

const ADMIN_SSO_COOKIE_PATH = '/admin/auth/sso';

export function setAdminSsoStateCookie(
  response: Response,
  state: string,
  secure: boolean,
): void {
  appendCookie(response, ADMIN_SSO_STATE_COOKIE, state, {
    httpOnly: true,
    maxAgeSeconds: 10 * 60,
    path: ADMIN_SSO_COOKIE_PATH,
    sameSite: 'Lax',
    secure,
  });
}

export function clearAdminSsoStateCookie(
  response: Response,
  secure: boolean,
): void {
  appendCookie(response, ADMIN_SSO_STATE_COOKIE, '', {
    httpOnly: true,
    maxAgeSeconds: 0,
    path: ADMIN_SSO_COOKIE_PATH,
    sameSite: 'Lax',
    secure,
  });
}

function appendCookie(
  response: Response,
  name: string,
  value: string,
  options: CookieOptions,
): void {
  const pieces = [`${name}=${encodeURIComponent(value)}`];
  pieces.push(`Path=${options.path ?? '/'}`);
  if (options.maxAgeSeconds !== undefined) {
    pieces.push(`Max-Age=${options.maxAgeSeconds}`);
  }
  if (options.httpOnly) pieces.push('HttpOnly');
  pieces.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  if (options.secure) pieces.push('Secure');

  const current = response.getHeader('Set-Cookie');
  const cookie = pieces.join('; ');
  if (Array.isArray(current)) {
    response.setHeader('Set-Cookie', [...current, cookie]);
  } else if (typeof current === 'string') {
    response.setHeader('Set-Cookie', [current, cookie]);
  } else {
    response.setHeader('Set-Cookie', cookie);
  }
}
