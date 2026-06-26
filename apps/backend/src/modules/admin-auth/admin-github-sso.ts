import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';

export function buildGithubAuthorizeUrl(
  state: string,
  config: ConfigService,
): string {
  const clientId = config.get<string>('TARMOTO_ADMIN_GITHUB_CLIENT_ID');
  const clientSecret = config.get<string>('TARMOTO_ADMIN_GITHUB_CLIENT_SECRET');
  if (!clientId || !clientSecret)
    throw new UnauthorizedException('GitHub SSO not configured');
  const params = new URLSearchParams({
    client_id: clientId,
    scope: 'read:user user:email',
    state,
    allow_signup: 'false',
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export async function exchangeGithubCode(
  code: string,
  config: ConfigService,
): Promise<{ subject: string; email: string }> {
  const clientId = config.get<string>('TARMOTO_ADMIN_GITHUB_CLIENT_ID');
  const clientSecret = config.get<string>('TARMOTO_ADMIN_GITHUB_CLIENT_SECRET');
  if (!clientId || !clientSecret) {
    throw new UnauthorizedException('GitHub SSO not configured');
  }

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  });
  if (!tokenRes.ok)
    throw new UnauthorizedException('GitHub API request failed');
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) {
    throw new UnauthorizedException('GitHub token exchange failed');
  }

  const headers = {
    Authorization: `Bearer ${tokenJson.access_token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'tarmoto-admin',
  };
  const userRes = await fetch('https://api.github.com/user', { headers });
  if (!userRes.ok) throw new UnauthorizedException('GitHub API request failed');
  const user = (await userRes.json()) as { id?: number; email?: string };
  const emailsRes = await fetch('https://api.github.com/user/emails', {
    headers,
  });
  if (!emailsRes.ok)
    throw new UnauthorizedException('GitHub API request failed');
  const emails = (await emailsRes.json()) as Array<{
    email: string;
    primary: boolean;
    verified: boolean;
  }>;
  const primary =
    emails.find((e) => e.primary && e.verified)?.email ??
    emails.find((e) => e.verified)?.email;
  if (!user.id) {
    throw new UnauthorizedException('GitHub profile missing id/email');
  }
  if (!primary) {
    throw new UnauthorizedException('GitHub account has no verified email');
  }
  return { subject: String(user.id), email: primary };
}
