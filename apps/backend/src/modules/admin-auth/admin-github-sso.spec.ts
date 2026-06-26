import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { exchangeGithubCode } from './admin-github-sso.js';

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
  it('(a) happy path: returns subject and primary verified email', async () => {
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
    expect(result).toEqual({ subject: '12345', email: 'primary@example.com' });
  });

  it('falls back to any verified email when there is no primary+verified address', async () => {
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
      email: 'verified-nonprimary@example.com',
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
