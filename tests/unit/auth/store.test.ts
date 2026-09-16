/**
 * Behavioral tests for the OAuth state store (src/auth/store.ts).
 *
 * Persistence runs against the real filesystem in a per-test temp directory.
 * A restart is simulated with loadAuthStore(), which discards the in-memory
 * clients and refresh tokens and rebuilds them from the file — so a record that
 * is still present afterwards can only have come from disk. The persistence
 * tests pair that with a control load from an empty path, proving the reload
 * really forgets anything that was not written.
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  authorizationCodeStore,
  clientStore,
  loadAuthStore,
  pendingAuthorizationStore,
  refreshTokenStore,
  resolveAuthStorePath,
  startExpirySweep,
  sweepExpired,
} from '../../../src/auth/store';

const T0 = 1_788_000_000_000;
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/** The shape the SDK's registration handler hands to registerClient. */
const registeredClient = (clientId: string): OAuthClientInformationFull => ({
  client_id: clientId,
  client_secret: `secret-for-${clientId}`,
  client_id_issued_at: 1_788_000_000,
  client_secret_expires_at: 1_790_592_000,
  redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
  token_endpoint_auth_method: 'client_secret_post',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  client_name: 'Claude',
  scope: 'claudeai',
});

const refreshRecord = (clientId: string) => ({
  clientId,
  email: 'person@example.com',
  scopes: ['claudeai'],
  resource: 'https://qbo.example.com/mcp',
});

let sandbox: string;
let storeFile: string;
let now: number;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qbo-auth-store-test-'));
  storeFile = path.join(sandbox, 'auth-store.json');
  now = T0;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  loadAuthStore(storeFile);
});

afterEach(() => {
  jest.useRealTimers();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('resolveAuthStorePath', () => {
  const tokenStoreSibling =
    process.platform === 'win32' ? '\\data\\auth-store.json' : '/data/auth-store.json';

  it.each([
    {
      name: 'AUTH_STORE_PATH wins over the token store directory',
      env: { AUTH_STORE_PATH: '/volume/auth/state.json', QUICKBOOKS_TOKEN_STORE_PATH: '/data/qbo-token.env' },
      want: '/volume/auth/state.json',
    },
    {
      name: 'a blank AUTH_STORE_PATH falls through to the token store directory',
      env: { AUTH_STORE_PATH: '   ', QUICKBOOKS_TOKEN_STORE_PATH: '/data/qbo-token-v2.env' },
      want: tokenStoreSibling,
    },
    {
      name: 'the token store directory is used when AUTH_STORE_PATH is unset',
      env: { QUICKBOOKS_TOKEN_STORE_PATH: '/data/qbo-token-v2.env' },
      want: tokenStoreSibling,
    },
  ])('$name', ({ env, want }) => {
    expect(resolveAuthStorePath(env)).toEqual({ path: want });
  });

  it('falls back to /tmp/auth-store.json with a warning when neither variable is set', () => {
    const resolved = resolveAuthStorePath({ QUICKBOOKS_TOKEN_STORE_PATH: '' });

    expect(resolved.path).toBe('/tmp/auth-store.json');
    expect(resolved.warning).toMatch(/AUTH_STORE_PATH/);
  });
});

describe('persistence across a reload', () => {
  it('still knows a registered client after reloading from the same file', () => {
    const client = registeredClient('client-survives');
    clientStore.save(client);

    loadAuthStore(storeFile);
    expect(clientStore.get('client-survives')).toEqual(client);

    // Control: a reload from an empty location forgets it, so the hit above
    // can only have come from the file.
    loadAuthStore(path.join(sandbox, 'elsewhere.json'));
    expect(clientStore.get('client-survives')).toBeUndefined();
  });

  it('redeems a refresh token after a reload that was issued before it', () => {
    refreshTokenStore.save('rt-issued-before-restart', refreshRecord('client-a'));

    // Control first: a reload from an empty location forgets the token.
    loadAuthStore(path.join(sandbox, 'elsewhere.json'));
    expect(refreshTokenStore.take('rt-issued-before-restart')).toBeUndefined();

    loadAuthStore(storeFile);

    expect(refreshTokenStore.take('rt-issued-before-restart')).toEqual({
      ...refreshRecord('client-a'),
      expiresAt: T0 + 30 * DAY,
    });
  });

  it('does not resurrect a refresh token that was redeemed before a reload', () => {
    refreshTokenStore.save('rt-single-use', refreshRecord('client-a'));
    expect(refreshTokenStore.take('rt-single-use')).toBeDefined();

    loadAuthStore(storeFile);

    expect(refreshTokenStore.take('rt-single-use')).toBeUndefined();
  });

  it('keeps a revoked refresh token revoked after a reload', () => {
    refreshTokenStore.save('rt-revoked', refreshRecord('client-a'));
    expect(refreshTokenStore.delete('rt-revoked')).toBe(true);
    expect(refreshTokenStore.delete('rt-revoked')).toBe(false);

    loadAuthStore(storeFile);

    expect(refreshTokenStore.take('rt-revoked')).toBeUndefined();
  });

  it('never writes a refresh token to disk in the clear', () => {
    const token = 'rt-plaintext-9f8e7d6c5b4a39281706f5e4d3c2b1a0';
    refreshTokenStore.save(token, refreshRecord('client-a'));

    const raw = fs.readFileSync(storeFile, 'utf8');
    expect(raw).toContain('person@example.com'); // the record itself was written
    expect(raw).not.toContain(token);

    loadAuthStore(storeFile);
    expect(refreshTokenStore.take(token)?.clientId).toBe('client-a');
  });

  it('writes a temp file in the same directory and renames it over the store', () => {
    const renameSpy = jest.spyOn(fs, 'renameSync');

    clientStore.save(registeredClient('client-atomic'));

    expect(renameSpy).toHaveBeenCalledTimes(1);
    const [from, to] = renameSpy.mock.calls[0] as [string, string];
    expect(to).toBe(storeFile);
    expect(from).not.toBe(storeFile);
    expect(path.dirname(from)).toBe(sandbox);
    expect(fs.readdirSync(sandbox)).toEqual(['auth-store.json']);
  });
});

describe('loading', () => {
  it('reports and logs the path and how many clients and live refresh tokens it loaded', () => {
    clientStore.save(registeredClient('client-1'));
    clientStore.save(registeredClient('client-2'));
    refreshTokenStore.save('rt-old', refreshRecord('client-1'));
    now = T0 + 2 * DAY;
    refreshTokenStore.save('rt-new', refreshRecord('client-2'));
    // rt-old is past its 30 days; rt-new still has two days left.
    now = T0 + 30 * DAY;
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    log.mockClear(); // drop the beforeEach load's line

    const loaded = loadAuthStore(storeFile);

    expect(loaded).toEqual({ clients: 2, refreshTokens: 1 });
    expect(clientStore.size()).toBe(2);
    expect(refreshTokenStore.size()).toBe(1);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0][0]);
    expect(line).toContain(storeFile);
    expect(line).toMatch(/\b2 client/);
    expect(line).toMatch(/\b1 refresh token/);
  });

  it('starts empty when the file does not exist yet', () => {
    clientStore.save(registeredClient('client-in-memory'));

    expect(loadAuthStore(path.join(sandbox, 'not-created-yet.json'))).toEqual({
      clients: 0,
      refreshTokens: 0,
    });
  });

  it.each([
    { name: 'truncated JSON', contents: '{"version":1,"clients":' },
    { name: 'JSON null', contents: 'null' },
    { name: 'a JSON string', contents: '"auth"' },
    { name: 'a JSON array', contents: '[]' },
    { name: 'an unknown version', contents: '{"version":2,"clients":{},"refreshTokens":{}}' },
    { name: 'clients that is not an object', contents: '{"version":1,"clients":[],"refreshTokens":{}}' },
    { name: 'missing refreshTokens', contents: '{"version":1,"clients":{}}' },
  ])('sets aside an unreadable store ($name), starts empty, and writes a fresh one', ({ contents }) => {
    fs.writeFileSync(storeFile, contents);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(loadAuthStore(storeFile)).toEqual({ clients: 0, refreshTokens: 0 });

    expect(warn).toHaveBeenCalledTimes(1);
    const setAside = fs.readdirSync(sandbox).filter((name) => name.startsWith('auth-store.json.corrupt-'));
    expect(setAside).toHaveLength(1);
    expect(fs.readFileSync(path.join(sandbox, setAside[0]), 'utf8')).toBe(contents);

    clientStore.save(registeredClient('client-after-recovery'));
    loadAuthStore(storeFile);
    expect(clientStore.get('client-after-recovery')?.client_id).toBe('client-after-recovery');
  });

  it('fails loudly when the store path cannot be read at all', () => {
    const directory = path.join(sandbox, 'a-directory');
    fs.mkdirSync(directory);

    expect(() => loadAuthStore(directory)).toThrow();
  });
});

describe('write failures', () => {
  it('logs a failed write and keeps serving from memory', () => {
    const unwritable = path.join(sandbox, 'missing-dir', 'auth-store.json');
    loadAuthStore(unwritable);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    clientStore.save(registeredClient('client-memory-only'));

    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain(unwritable);
    expect(clientStore.get('client-memory-only')?.client_id).toBe('client-memory-only');
  });

  it('removes the temp file when the rename fails', () => {
    fs.mkdirSync(storeFile); // a directory where the store file should go
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    clientStore.save(registeredClient('client-rename-fails'));

    expect(error).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(sandbox)).toEqual(['auth-store.json']);
  });
});

describe('expiry', () => {
  it('honours the 30-day refresh token lifetime to the millisecond', () => {
    refreshTokenStore.save('rt-boundary-fresh', refreshRecord('client-a'));
    refreshTokenStore.save('rt-boundary-expired', refreshRecord('client-a'));

    now = T0 + 30 * DAY - 1;
    expect(refreshTokenStore.take('rt-boundary-fresh')).toBeDefined();
    now = T0 + 30 * DAY;
    expect(refreshTokenStore.take('rt-boundary-expired')).toBeUndefined();
  });

  it('removes swept refresh tokens from disk, not just from memory', () => {
    refreshTokenStore.save('rt-swept', refreshRecord('client-a'));
    // Control: at T0 a reload does bring the token back from the file.
    expect(loadAuthStore(storeFile)).toEqual({ clients: 0, refreshTokens: 1 });
    now = T0 + 30 * DAY;

    sweepExpired();

    // Winding the clock back makes the token fresh again — so only a sweep
    // that rewrote the file can keep it from loading.
    now = T0;
    expect(loadAuthStore(storeFile)).toEqual({ clients: 0, refreshTokens: 0 });
  });

  it('lets an authorization code be peeked repeatedly but redeemed once, within 5 minutes', () => {
    const code = { clientId: 'client-a', redirectUri: 'https://claude.ai/cb', codeChallenge: 'challenge', email: 'person@example.com', scopes: ['claudeai'] };
    authorizationCodeStore.save('code-single-use', code);
    authorizationCodeStore.save('code-expires', code);

    now = T0 + 5 * MINUTE - 1;
    expect(authorizationCodeStore.peek('code-single-use')?.codeChallenge).toBe('challenge');
    expect(authorizationCodeStore.peek('code-single-use')?.codeChallenge).toBe('challenge');
    expect(authorizationCodeStore.take('code-single-use')?.email).toBe('person@example.com');
    expect(authorizationCodeStore.take('code-single-use')).toBeUndefined();

    now = T0 + 5 * MINUTE;
    expect(authorizationCodeStore.peek('code-expires')).toBeUndefined();
  });

  it('consumes a pending authorization once, within 10 minutes', () => {
    const pending = { clientId: 'client-a', redirectUri: 'https://claude.ai/cb', codeChallenge: 'challenge', scopes: [] };
    pendingAuthorizationStore.save('state-single-use', pending);
    pendingAuthorizationStore.save('state-expires', pending);

    now = T0 + 10 * MINUTE - 1;
    expect(pendingAuthorizationStore.take('state-single-use')?.clientId).toBe('client-a');
    expect(pendingAuthorizationStore.take('state-single-use')).toBeUndefined();

    now = T0 + 10 * MINUTE;
    expect(pendingAuthorizationStore.take('state-expires')).toBeUndefined();
  });

  it('sweeps expired authorization codes and pending authorizations out of memory', () => {
    const code = { clientId: 'client-a', redirectUri: 'https://claude.ai/cb', codeChallenge: 'challenge', email: 'person@example.com', scopes: [] };
    authorizationCodeStore.save('code-swept', code);
    pendingAuthorizationStore.save('state-swept', { clientId: 'client-a', redirectUri: 'https://claude.ai/cb', codeChallenge: 'challenge', scopes: [] });
    now = T0 + 10 * MINUTE;
    authorizationCodeStore.save('code-still-live', code);

    sweepExpired();

    now = T0;
    expect(authorizationCodeStore.peek('code-swept')).toBeUndefined();
    expect(pendingAuthorizationStore.take('state-swept')).toBeUndefined();
    // A live code is left alone.
    expect(authorizationCodeStore.peek('code-still-live')).toBeDefined();
  });

  it('runs the sweep every minute on an unref-ed timer', () => {
    jest.useFakeTimers({ doNotFake: ['Date'] });
    const code = { clientId: 'client-a', redirectUri: 'https://claude.ai/cb', codeChallenge: 'challenge', email: 'person@example.com', scopes: [] };
    authorizationCodeStore.save('code-interval-swept', code);
    authorizationCodeStore.save('code-interval-control', code);

    const timer = startExpirySweep();
    try {
      expect(timer.hasRef()).toBe(false);

      now = T0 + 5 * MINUTE;
      jest.advanceTimersByTime(59_999);
      now = T0;
      // Control: before the interval elapses nothing has been swept.
      expect(authorizationCodeStore.peek('code-interval-control')).toBeDefined();

      now = T0 + 5 * MINUTE;
      jest.advanceTimersByTime(1);
      now = T0;
      expect(authorizationCodeStore.peek('code-interval-swept')).toBeUndefined();
    } finally {
      clearInterval(timer);
    }
  });
});
