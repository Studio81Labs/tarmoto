import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildGithubAuthorizeUrl,
  exchangeGithubCode,
} from './admin-github-sso.js';

const config = {
  get: (key: string) => {
    if (key === 'TARMOTO_ADMIN_GITHUB_CLIENT_ID') return 'test-client-id';
    if (key === 'TARMOTO_ADMIN_GITHUB_CLIENT_SECRET')
      return 'test-client-secret';
    return undefined;
  },
} as unknown as ConfigService;

function makeTokenResponse(accessToken: string | undefined): Response {
  return {
    ok: true,
    json: () => Promise.resolve({ access_token: accessToken }),
  } as Response;
}

function makeUserResponse(id: number, email: string | null): Response {
  return {
    ok: true,
    json: () => Promise.resolve({ id, email }),
  } as Response;
}

function makeEmailsResponse(
  emails: Array<{ email: string; primary: boolean; verified: boolean }>,
): Response {
  return {
    ok: true,
    json: () => Promise.resolve(emails),
  } as Response;
}

const savedFetch = global.fetch;

afterEach(() => {
  global.fetch = savedFetch;
});

describe('exchangeGithubCode', () => {
  it('(a) happy path: returns subject and all verified emails, primary first', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(makeTokenResponse('gh-token-abc'))
      .mockResolvedValueOnce(makeUserResponse(12345, null))
      .mockResolvedValueOnce(
        makeEmailsResponse([
          { email: 'secondary@example.com', primary: false, verified: true },
          { email: 'primary@example.com', primary: true, verified: true },
        ]),
      );

    const result = await exchangeGithubCode('valid-code', config);
    expect(result).toEqual({
      subject: '12345',
      emails: ['primary@example.com', 'secondary@example.com'],
    });
  });

  it('returns all verified emails when there is no primary+verified address', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(makeTokenResponse('gh-token-xyz'))
      .mockResolvedValueOnce(makeUserResponse(99, 'public@example.com'))
      .mockResolvedValueOnce(
        makeEmailsResponse([
          {
            email: 'verified-nonprimary@example.com',
            primary: false,
            verified: true,
          },
        ]),
      );

    const result = await exchangeGithubCode('code', config);
    expect(result).toEqual({
      subject: '99',
      emails: ['verified-nonprimary@example.com'],
    });
  });

  it('(b) throws when /user/emails returns only unverified entries (does not fall back to user.email)', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(makeTokenResponse('gh-token-unverified'))
      .mockResolvedValueOnce(
        makeUserResponse(77, 'public-unverified@example.com'),
      )
      .mockResolvedValueOnce(
        makeEmailsResponse([
          {
            email: 'public-unverified@example.com',
            primary: true,
            verified: false,
          },
          {
            email: 'also-unverified@example.com',
            primary: false,
            verified: false,
          },
        ]),
      );

    await expect(exchangeGithubCode('code', config)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('throws when /user/emails returns an empty list', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(makeTokenResponse('gh-token-empty'))
      .mockResolvedValueOnce(makeUserResponse(55, 'someone@example.com'))
      .mockResolvedValueOnce(makeEmailsResponse([]));

    await expect(exchangeGithubCode('code', config)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('buildGithubAuthorizeUrl', () => {
  const baseConfig = {
    get: (key: string) => {
      if (key === 'TARMOTO_ADMIN_GITHUB_CLIENT_ID') return 'test-client-id';
      if (key === 'TARMOTO_ADMIN_GITHUB_CLIENT_SECRET')
        return 'test-client-secret';
      return undefined;
    },
  } as unknown as ConfigService;

  it('omits redirect_uri when TARMOTO_ADMIN_SSO_REDIRECT_URI is not set', () => {
    const url = buildGithubAuthorizeUrl('test-state', baseConfig);
    expect(url).toContain('client_id=test-client-id');
    expect(url).toContain('state=test-state');
    expect(url).not.toContain('redirect_uri');
  });

  it('includes redirect_uri when TARMOTO_ADMIN_SSO_REDIRECT_URI is set', () => {
    const redirectUri = 'http://localhost:3003/admin/auth/sso/github/callback';
    const configWithRedirect = {
      get: (key: string) => {
        if (key === 'TARMOTO_ADMIN_GITHUB_CLIENT_ID') return 'test-client-id';
        if (key === 'TARMOTO_ADMIN_GITHUB_CLIENT_SECRET')
          return 'test-client-secret';
        if (key === 'TARMOTO_ADMIN_SSO_REDIRECT_URI') return redirectUri;
        return undefined;
      },
    } as unknown as ConfigService;
    const url = buildGithubAuthorizeUrl('test-state', configWithRedirect);
    expect(url).toContain('redirect_uri=');
    expect(url).toContain(encodeURIComponent(redirectUri));
  });

  it('throws UnauthorizedException when client id or secret is missing', () => {
    const emptyConfig = {
      get: () => undefined,
    } as unknown as ConfigService;
    expect(() => buildGithubAuthorizeUrl('test-state', emptyConfig)).toThrow(
      UnauthorizedException,
    );
  });
});
