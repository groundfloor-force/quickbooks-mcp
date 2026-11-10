/**
 * Behavioral tests for service keys (src/auth/service-keys.ts): SERVICE_KEYS parsing, the bearer
 * verifier that sits in front of the Google-backed one, and the read-only scope.
 *
 * The HTTP tests run a real express app through the SDK's real requireBearerAuth, wired exactly as
 * /mcp is wired in http.ts (bearer -> JSON body -> scope check -> handler). Only the Google verifier
 * is a fake: it accepts one known token and rejects everything else the way the real one does.
 */
import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import {
  MIN_SERVICE_KEY_LENGTH,
  READONLY_DENIED_CODE,
  buildMcpVerifier,
  createServiceKeyVerifier,
  describeServiceKeys,
  enforceServiceKeyScope,
  parseServiceKeys,
  toolCallsDeniedByScope,
} from '../../../src/auth/service-keys';

const WORKER_KEY = 'wK9fT2xQ7mP4vL8nR3sB6yH1cJ5dG0aE_-Xu2zV7oI9pN4q'; // 48
const OPS_KEY = 'Op5Lr8Ks2Jd6Hg0Fq4Wm7Zn1Xb3Vc9Ty-_Ae2Ui'; // 40
const GOOGLE_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.google-signed-in-person';

/** Stand-in for GoogleBackedOAuthProvider: one valid token, everything else is InvalidTokenError. */
const googleVerifier = (): OAuthTokenVerifier & { seen: string[] } => {
  const seen: string[] = [];
  return {
    seen,
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      seen.push(token);
      if (token !== GOOGLE_TOKEN) throw new InvalidTokenError('Access token is invalid');
      return { token, clientId: 'claude-ai', scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 3600, extra: { email: 'person@example.com' } };
    },
  };
};

const toolCall = (name: unknown, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });

// ------------------------------------------------------------------ parsing

describe('parseServiceKeys', () => {
  it('unset or blank means the feature is OFF (no keys)', () => {
    expect(parseServiceKeys(undefined)).toEqual([]);
    expect(parseServiceKeys('')).toEqual([]);
    expect(parseServiceKeys('   ')).toEqual([]);
  });

  it('parses name:key and name:key:readonly, keeping only a digest of each key', () => {
    const keys = parseServiceKeys(` gd-qbo-worker:${WORKER_KEY} , ops.ro:${OPS_KEY}:readonly `);
    expect(keys.map((k) => [k.name, k.readonly])).toEqual([['gd-qbo-worker', false], ['ops.ro', true]]);
    for (const k of keys) expect(k.digest).toHaveLength(32);
    const dump = JSON.stringify(keys) + keys.map((k) => k.digest.toString('utf8')).join('');
    expect(dump).not.toContain(WORKER_KEY);
    expect(dump).not.toContain(OPS_KEY);
  });

  it(`refuses a key shorter than ${MIN_SERVICE_KEY_LENGTH} characters, naming the entry but never the key`, () => {
    const short = 'x'.repeat(MIN_SERVICE_KEY_LENGTH - 1);
    expect(() => parseServiceKeys(`gd-qbo-worker:${short}`)).toThrow(/gd-qbo-worker.*at least 32 characters/);
    try { parseServiceKeys(`gd-qbo-worker:${short}`); } catch (error) { expect((error as Error).message).not.toContain(short); }
    expect(parseServiceKeys(`gd-qbo-worker:${'x'.repeat(MIN_SERVICE_KEY_LENGTH)}`)).toHaveLength(1);
  });

  it.each([
    ['a name with no key', 'gd-qbo-worker', /entry 1.*name:key/],
    ['an empty key', 'gd-qbo-worker:', /entry 1.*name:key/],
    ['an empty name', `:${WORKER_KEY}`, /entry 1.*name/],
    ['a name with a space', `gd qbo:${WORKER_KEY}`, /entry 1.*name/],
    ['an unknown scope (a typo must not grant full access)', `gd-qbo-worker:${WORKER_KEY}:read-only`, /entry 1.*scope.*readonly/],
    ['too many fields', `gd-qbo-worker:${WORKER_KEY}:readonly:extra`, /entry 1.*name:key/],
    ['a key with a character that is not allowed', `gd-qbo-worker:${WORKER_KEY.slice(0, 40)} ${WORKER_KEY.slice(40)}`, /entry 1.*characters/],
  ])('refuses %s', (_label, raw, why) => {
    let message = '';
    try { parseServiceKeys(raw); } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(why);
    expect(message).toMatch(/^SERVICE_KEYS/);
    expect(message).not.toContain(WORKER_KEY.slice(0, 24));
  });

  it('refuses duplicate names and duplicate keys', () => {
    expect(() => parseServiceKeys(`a:${WORKER_KEY},a:${OPS_KEY}`)).toThrow(/name "a" is used more than once/);
    expect(() => parseServiceKeys(`a:${WORKER_KEY},b:${WORKER_KEY}`)).toThrow(/entries 1 and 2 have the same key/);
  });

  it('refuses a SERVICE_KEYS that is set but holds no entries', () => {
    expect(() => parseServiceKeys(' , ,')).toThrow(/set but contains no entries/);
  });

  it('lists every problem at once, so one deploy log shows them all', () => {
    let message = '';
    try { parseServiceKeys(`a:short,b:${OPS_KEY}:admin`); } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/entry 1 \(a\).*at least 32/s);
    expect(message).toMatch(/entry 2 \(b\).*scope/s);
  });
});

describe('describeServiceKeys (startup log line)', () => {
  it('shows names and scopes only', () => {
    expect(describeServiceKeys([])).toBe('off');
    const line = describeServiceKeys(parseServiceKeys(`gd-qbo-worker:${WORKER_KEY}:readonly,ops:${OPS_KEY}`));
    expect(line).toBe('2 (gd-qbo-worker [readonly], ops)');
    expect(line).not.toContain(WORKER_KEY);
  });
});

// ------------------------------------------------------------------ the verifier

describe('createServiceKeyVerifier', () => {
  const keys = parseServiceKeys(`gd-qbo-worker:${WORKER_KEY}:readonly,ops:${OPS_KEY}`);

  it('accepts a matching key as service:<name>, without asking Google and without carrying the key on', async () => {
    const google = googleVerifier();
    const now = 1_800_000_000_000;
    const info = await createServiceKeyVerifier(keys, google, () => now).verifyAccessToken(WORKER_KEY);
    expect(info).toEqual({
      token: 'service:gd-qbo-worker',
      clientId: 'service:gd-qbo-worker',
      scopes: ['readonly'],
      expiresAt: now / 1000 + 60,
      extra: { email: 'service:gd-qbo-worker', service: 'gd-qbo-worker', readonly: true },
    });
    expect(JSON.stringify(info)).not.toContain(WORKER_KEY);
    expect(google.seen).toEqual([]);
    const ops = await createServiceKeyVerifier(keys, google).verifyAccessToken(OPS_KEY);
    expect(ops.extra).toEqual({ email: 'service:ops', service: 'ops', readonly: false });
    expect(ops.scopes).toEqual([]);
  });

  it.each([
    ['one character off', `${WORKER_KEY.slice(0, -1)}X`],
    ['a prefix of the key', WORKER_KEY.slice(0, 40)],
    ['the key with extra characters', `${WORKER_KEY}Z`],
    ['an empty token', ''],
  ])('does not accept %s: it falls through to Google, which rejects it', async (_label, token) => {
    const google = googleVerifier();
    await expect(createServiceKeyVerifier(keys, google).verifyAccessToken(token)).rejects.toBeInstanceOf(InvalidTokenError);
    expect(google.seen).toEqual([token]);
  });

  it('hands every non-key token to the Google verifier and returns its answer unchanged', async () => {
    const google = googleVerifier();
    const info = await createServiceKeyVerifier(keys, google).verifyAccessToken(GOOGLE_TOKEN);
    expect(info.extra).toEqual({ email: 'person@example.com' });
    expect(google.seen).toEqual([GOOGLE_TOKEN]);
  });

  it('buildMcpVerifier: with no keys it is the Google verifier ITSELF (feature off, nothing changes)', () => {
    const google = googleVerifier();
    expect(buildMcpVerifier([], google)).toBe(google);
    expect(buildMcpVerifier(keys, google)).not.toBe(google);
  });
});

// ------------------------------------------------------------------ the read-only scope

describe('toolCallsDeniedByScope', () => {
  const readonly: AuthInfo = { token: 't', clientId: 'service:w', scopes: ['readonly'], extra: { email: 'service:w', service: 'w', readonly: true } };
  const full: AuthInfo = { ...readonly, scopes: [], extra: { email: 'service:ops', service: 'ops', readonly: false } };
  const google: AuthInfo = { token: 't', clientId: 'c', scopes: [], extra: { email: 'person@example.com' } };

  it('a read-only key may call search_/get_/read_ tools and any non-tool method', () => {
    expect(toolCallsDeniedByScope(readonly, toolCall('search_customers'))).toEqual([]);
    expect(toolCallsDeniedByScope(readonly, toolCall('get_company_info'))).toEqual([]);
    expect(toolCallsDeniedByScope(readonly, toolCall('read_invoice'))).toEqual([]);
    expect(toolCallsDeniedByScope(readonly, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).toEqual([]);
    expect(toolCallsDeniedByScope(readonly, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).toEqual([]);
    expect(toolCallsDeniedByScope(readonly, null)).toEqual([]);
  });

  it('a read-only key may NOT call anything else (batches included; odd names are not echoed raw)', () => {
    expect(toolCallsDeniedByScope(readonly, toolCall('create_invoice'))).toEqual(['create_invoice']);
    expect(toolCallsDeniedByScope(readonly, toolCall('get-bill'))).toEqual(['get-bill']);
    expect(toolCallsDeniedByScope(readonly, [toolCall('search_items', 1), toolCall('delete_bill', 2), toolCall('update_customer', 3)]))
      .toEqual(['delete_bill', 'update_customer']);
    expect(toolCallsDeniedByScope(readonly, toolCall(42))).toEqual(['(invalid)']);
    expect(toolCallsDeniedByScope(readonly, toolCall('create_invoice\n[qbo-mcp][audit] user=forged'))).toEqual(['(invalid)']);
  });

  it('never applies to a full key or to a Google sign-in', () => {
    expect(toolCallsDeniedByScope(full, toolCall('create_invoice'))).toEqual([]);
    expect(toolCallsDeniedByScope(google, toolCall('create_invoice'))).toEqual([]);
    expect(toolCallsDeniedByScope(undefined, toolCall('create_invoice'))).toEqual([]);
  });
});

// ------------------------------------------------------------------ over HTTP, as /mcp is wired

describe('over HTTP through the SDK bearer middleware (as /mcp wires it)', () => {
  const servers: Server[] = [];
  /** bearer -> JSON body -> scope check -> handler that echoes who it is talking to. */
  const start = async (serviceKeysEnv: string | undefined): Promise<string> => {
    const app = express();
    const verifier = buildMcpVerifier(parseServiceKeys(serviceKeysEnv), googleVerifier());
    app.post('/mcp', requireBearerAuth({ verifier }), express.json(), enforceServiceKeyScope, (req: Request, res: Response) => {
      res.json({ who: req.auth?.extra?.email });
    });
    const server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  };
  const post = (url: string, token: string, body: unknown) => fetch(url, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  // One log for the whole block. Spies go in beforeEach: jest.config's restoreMocks removes them after each test.
  const logged: string[] = [];
  beforeEach(() => {
    for (const level of ['log', 'info', 'warn', 'error'] as const) {
      jest.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    }
  });
  afterAll(async () => { await Promise.all(servers.map((s) => new Promise((r) => s.close(r)))); });

  it('a service key is accepted and the request runs as service:<name>', async () => {
    const url = await start(`gd-qbo-worker:${WORKER_KEY}`);
    const res = await post(url, WORKER_KEY, toolCall('create_invoice'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ who: 'service:gd-qbo-worker' });
  });

  it('a wrong key is rejected with 401 and a WWW-Authenticate header', async () => {
    const url = await start(`gd-qbo-worker:${WORKER_KEY}`);
    const res = await post(url, `${WORKER_KEY.slice(0, -1)}X`, toolCall('search_customers'));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer error="invalid_token"/);
  });

  it('with SERVICE_KEYS unset the feature is off: the same key is just an invalid token', async () => {
    const url = await start(undefined);
    expect((await post(url, WORKER_KEY, toolCall('search_customers'))).status).toBe(401);
  });

  it('a read-only key: create_invoice is refused with 403 (JSON-RPC -32004); search_customers goes through', async () => {
    const url = await start(`gd-qbo-worker:${WORKER_KEY}:readonly`);
    const denied = await post(url, WORKER_KEY, toolCall('create_invoice'));
    expect(denied.status).toBe(403);
    const body = (await denied.json()) as { jsonrpc: string; id: unknown; error: { code: number; message: string } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(READONLY_DENIED_CODE);
    expect(body.error.message).toMatch(/read-only.*create_invoice/);
    const allowed = await post(url, WORKER_KEY, toolCall('search_customers'));
    expect(allowed.status).toBe(200);
    expect(logged.some((l) => /\[qbo-mcp\]\[audit\] user=service:gd-qbo-worker DENIED tool=create_invoice/.test(l))).toBe(true);
  });

  it('the Google sign-in still passes (and a read-only key elsewhere does not limit it)', async () => {
    const url = await start(`gd-qbo-worker:${WORKER_KEY}:readonly`);
    const res = await post(url, GOOGLE_TOKEN, toolCall('create_invoice'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ who: 'person@example.com' });
  });

  it('no key ever reaches a log line', () => {
    expect(logged.length).toBeGreaterThan(0); // positive control: the audit line above was captured
    expect(logged.join('\n')).not.toContain(WORKER_KEY);
  });
});
