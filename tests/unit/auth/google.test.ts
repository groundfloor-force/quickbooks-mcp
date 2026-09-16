/**
 * Behavioral tests for the Google identity leg (src/auth/google.ts).
 *
 * Only Google's two endpoints — the token endpoint and the JWKS — are faked, at
 * the fetch level. ID tokens are real RS256 JWTs signed with a key generated
 * here and published through the fake JWKS, so signature, issuer, audience and
 * expiry are all checked by jose itself, and every failure below is the error
 * jose really throws.
 */
import { jest, describe, it, expect, beforeAll } from '@jest/globals';
import { SignJWT, exportJWK, generateKeyPair, type JWTPayload } from 'jose';
import type { AuthConfig } from '../../../src/auth/config';
import {
  GoogleSignInError,
  buildGoogleAuthorizationUrl,
  resolveGoogleIdentity,
} from '../../../src/auth/google';

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
const KEY_ID = 'test-google-signing-key';
const GOOGLE_CODE = '4/0AVMBsJtest-google-authorization-code';

const config: AuthConfig = {
  publicUrl: new URL('https://qbo.example.com'),
  issuerUrl: new URL('https://qbo.example.com'),
  resourceUrl: new URL('https://qbo.example.com/mcp'),
  googleRedirectUri: 'https://qbo.example.com/auth/google/callback',
  googleClientId: 'our-client.apps.googleusercontent.com',
  googleClientSecret: 'GOCSPX-our-google-client-secret',
  allowedEmails: new Set(['person@example.com']),
  sessionSecret: new TextEncoder().encode('s'.repeat(32)),
};

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let googleKey: SigningKey;
let impostorKey: SigningKey;
let googleJwks: { keys: object[] };

beforeAll(async () => {
  const google = await generateKeyPair('RS256');
  googleKey = google.privateKey;
  googleJwks = { keys: [{ ...(await exportJWK(google.publicKey)), kid: KEY_ID, alg: 'RS256', use: 'sig' }] };
  impostorKey = (await generateKeyPair('RS256')).privateKey;
});

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** A Google-shaped ID token. Claims set to undefined are omitted. */
const signIdToken = (claims: JWTPayload = {}, key: SigningKey = googleKey): Promise<string> =>
  new SignJWT({
    iss: 'https://accounts.google.com',
    azp: config.googleClientId,
    aud: config.googleClientId,
    sub: '109876543210987654321',
    email: 'Person@Example.com',
    email_verified: true,
    at_hash: 'HK6E_P6Dh8Y93mRNtsDB1Q',
    iat: nowSeconds(),
    exp: nowSeconds() + 3600,
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID, typ: 'JWT' })
    .sign(key);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Google's token endpoint success body, complete. */
const tokenSuccess = (idToken: string): Response =>
  json({
    access_token: 'ya29.test-google-access-token',
    expires_in: 3599,
    scope: 'openid https://www.googleapis.com/auth/userinfo.email',
    token_type: 'Bearer',
    id_token: idToken,
  });

/** Routes fetch to the fake Google: the token endpoint answers with `token`. */
const fakeGoogle = (token: () => Response | Promise<Response>) =>
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url === GOOGLE_TOKEN_ENDPOINT) return token();
    if (url === GOOGLE_JWKS_URI) return json(googleJwks);
    throw new Error(`unexpected fetch to ${url}`);
  });

describe('buildGoogleAuthorizationUrl', () => {
  it('sends the user to Google with our client, callback, state and the openid email scope', () => {
    const url = new URL(buildGoogleAuthorizationUrl(config, 'state-abc123'));

    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'our-client.apps.googleusercontent.com',
      redirect_uri: 'https://qbo.example.com/auth/google/callback',
      response_type: 'code',
      scope: 'openid email',
      state: 'state-abc123',
      prompt: 'select_account',
    });
  });
});

describe('resolveGoogleIdentity', () => {
  it('exchanges the code as a form post and returns the email from a valid ID token', async () => {
    const idToken = await signIdToken();
    const fetchSpy = fakeGoogle(() => tokenSuccess(idToken));

    await expect(resolveGoogleIdentity(config, GOOGLE_CODE)).resolves.toEqual({
      email: 'Person@Example.com',
      emailVerified: true,
    });

    const tokenCall = fetchSpy.mock.calls.find(([input]) => String(input) === GOOGLE_TOKEN_ENDPOINT);
    const init = tokenCall?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
      code: GOOGLE_CODE,
      client_id: 'our-client.apps.googleusercontent.com',
      client_secret: 'GOCSPX-our-google-client-secret',
      redirect_uri: 'https://qbo.example.com/auth/google/callback',
      grant_type: 'authorization_code',
    });
  });

  it.each([
    { name: 'boolean true', emailVerified: true, want: true },
    { name: 'legacy string "true"', emailVerified: 'true', want: true },
    { name: 'false', emailVerified: false, want: false },
    { name: 'absent', emailVerified: undefined, want: false },
  ])('reads email_verified $name as $want', async ({ emailVerified, want }) => {
    const idToken = await signIdToken({ email_verified: emailVerified });
    fakeGoogle(() => tokenSuccess(idToken));

    const identity = await resolveGoogleIdentity(config, GOOGLE_CODE);

    expect(identity.emailVerified).toBe(want);
  });

  describe('rejects with a specific reason that is safe to log', () => {
    const expectSafeRejection = async (reason: RegExp, secrets: string[]): Promise<void> => {
      const failure = await resolveGoogleIdentity(config, GOOGLE_CODE).then(
        () => undefined,
        (error: unknown) => error
      );

      expect(failure).toBeInstanceOf(GoogleSignInError);
      const message = (failure as Error).message;
      expect(message).toMatch(reason);
      for (const secret of [GOOGLE_CODE, config.googleClientSecret, ...secrets]) {
        expect(message).not.toContain(secret);
      }
    };

    it.each([
      {
        name: 'Google rejects the authorization code',
        token: () => json({ error: 'invalid_grant', error_description: 'Malformed auth code.' }, 400),
        reason: /HTTP 400.*invalid_grant.*Malformed auth code\./,
      },
      {
        name: 'Google does not recognise our client',
        token: () => json({ error: 'invalid_client' }, 401),
        reason: /HTTP 401.*invalid_client/,
      },
      {
        name: 'the token endpoint fails with an empty JSON error',
        token: () => json({}, 500),
        reason: /HTTP 500/,
      },
      {
        name: 'the token endpoint fails with a non-JSON body',
        token: () => new Response('<html>Bad Gateway</html>', { status: 502 }),
        reason: /HTTP 502/,
      },
      {
        name: 'the token endpoint is unreachable',
        token: () => Promise.reject(new TypeError('fetch failed')),
        reason: /token endpoint.*fetch failed/,
      },
      {
        name: 'the token response carries no id_token',
        token: () => json({ access_token: 'ya29.test-google-access-token', expires_in: 3599, token_type: 'Bearer' }),
        reason: /id_token/,
      },
    ])('when $name', async ({ token, reason }) => {
      fakeGoogle(token);

      await expectSafeRejection(reason, ['ya29.test-google-access-token']);
    });

    it('when the token response is not JSON, without quoting the body', async () => {
      // V8's JSON.parse error quotes the text it choked on — `Unexpected token
      // 'y', "ya29.a0b1" is not valid JSON` — and a token response body is
      // exactly what must never reach the log.
      fakeGoogle(() => new Response('ya29.a0b1', { status: 200 }));

      await expectSafeRejection(/id_token/, ['ya29.a0b1']);
    });

    it.each([
      { name: 'is for a different Google client', claims: { aud: 'someone-else.apps.googleusercontent.com' }, reason: /"aud"/ },
      { name: 'was not issued by Google', claims: { iss: 'https://accounts.example.com' }, reason: /"iss"/ },
      { name: 'has expired', claims: { iat: nowSeconds() - 7200, exp: nowSeconds() - 3600 }, reason: /"exp"/ },
      { name: 'has no email claim', claims: { email: undefined }, reason: /email claim/ },
    ])('when the ID token $name', async ({ claims, reason }) => {
      const idToken = await signIdToken(claims);
      fakeGoogle(() => tokenSuccess(idToken));

      await expectSafeRejection(reason, [idToken]);
    });

    it('when the ID token is not signed by Google', async () => {
      const idToken = await signIdToken({}, impostorKey);
      fakeGoogle(() => tokenSuccess(idToken));

      await expectSafeRejection(/signature/, [idToken]);
    });

    it('when the id_token is not a JWT at all', async () => {
      fakeGoogle(() => tokenSuccess('not-a-jwt'));

      await expectSafeRejection(/Compact JWS/, []);
    });
  });
});
