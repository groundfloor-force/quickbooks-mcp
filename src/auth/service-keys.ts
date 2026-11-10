/**
 * Service keys: long random bearer keys for NON-INTERACTIVE clients (e.g. the gd-qbo-worker), as an
 * alternative to the Google sign-in on /mcp.
 *
 *   SERVICE_KEYS=name:key[,name:key:readonly ...]
 *
 * - Unset or blank: the feature is OFF and /mcp's verifier is the Google-backed provider itself.
 * - A request whose bearer token equals a configured key runs as "service:<name>". That identity
 *   goes wherever a signed-in email goes today (audit line, session pinning, session log), because
 *   it travels in AuthInfo.extra.email. Any other token falls through to the Google verifier,
 *   untouched.
 * - Keys are compared in constant time. Only SHA-256 digests are kept in memory, and every entry
 *   is compared, with no early exit. A key is never logged, and never placed in AuthInfo (its
 *   `token` field is "service:<name>"), so it cannot travel past this file.
 * - Each key must be at least 32 characters from [A-Za-z0-9._~+/=-]. A malformed SERVICE_KEYS
 *   (short key, unknown scope, duplicate) refuses to start, with every problem listed and no key
 *   text in the message.
 * - `:readonly` makes the server itself refuse any tools/call whose tool is not search_*, get_* or
 *   read_* for that key: HTTP 403, JSON-RPC error READONLY_DENIED_CODE, and an audit line.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";

export const MIN_SERVICE_KEY_LENGTH = 32;
export const SERVICE_IDENTITY_PREFIX = "service:";
/** JSON-RPC implementation-defined server error: a read-only key called a tool outside its scope. */
export const READONLY_DENIED_CODE = -32004;

const READONLY_SCOPE = "readonly";
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KEY_PATTERN = /^[A-Za-z0-9._~+/=-]+$/; // no ':' ',' or whitespace: they are separators
const READ_ONLY_TOOL = /^(search|get|read)_[a-z0-9_]+$/;
const LOGGABLE_TOOL = /^[A-Za-z0-9_.-]{1,100}$/;
/**
 * The SDK's bearer middleware requires every AuthInfo to carry an expiry. A key itself does not
 * expire, so each verification is valid for this many seconds (one request).
 */
const SERVICE_AUTH_TTL_SECONDS = 60;

export interface ServiceKey {
  readonly name: string;
  readonly readonly: boolean;
  /** SHA-256 of the key: the key itself is not kept. */
  readonly digest: Buffer;
}

const sha256 = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/**
 * Parses SERVICE_KEYS. Returns [] when unset or blank (feature off). Throws ONE error listing
 * every problem; no message contains key text.
 */
export const parseServiceKeys = (raw: string | undefined): ServiceKey[] => {
  if (!raw?.trim()) return [];
  const entries = raw.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
  if (entries.length === 0) {
    throw new Error("SERVICE_KEYS is set but contains no entries (expected name:key[:readonly],...)");
  }

  const problems: string[] = [];
  const keys: ServiceKey[] = [];
  const firstEntryForName = new Map<string, number>();
  const firstEntryForKey = new Map<string, number>();

  entries.forEach((entry, index) => {
    const n = index + 1;
    const fields = entry.split(":");
    const [name, key = "", scope] = fields; // split() always yields at least one field
    const label = NAME_PATTERN.test(name) ? `entry ${n} (${name})` : `entry ${n}`;
    if (fields.length < 2 || fields.length > 3 || key === "") {
      problems.push(`${label}: expected name:key or name:key:readonly`);
      return;
    }
    let ok = true;
    if (!NAME_PATTERN.test(name)) {
      problems.push(`${label}: the name must be 1-64 characters of letters, digits, '.', '_' or '-'`);
      ok = false;
    }
    if (key.length < MIN_SERVICE_KEY_LENGTH) {
      problems.push(`${label}: the key must be at least ${MIN_SERVICE_KEY_LENGTH} characters (it has ${key.length})`);
      ok = false;
    } else if (!KEY_PATTERN.test(key)) {
      problems.push(`${label}: the key may only contain the characters A-Z a-z 0-9 . _ ~ + / = -`);
      ok = false;
    }
    if (scope !== undefined && scope !== READONLY_SCOPE) {
      problems.push(`${label}: unknown scope; the only scope is "${READONLY_SCOPE}"`);
      ok = false;
    }
    if (!ok) return;

    if (firstEntryForName.has(name)) {
      problems.push(`${label}: the name "${name}" is used more than once`);
      return;
    }
    const digest = sha256(key);
    const digestHex = digest.toString("hex");
    const earlier = firstEntryForKey.get(digestHex);
    if (earlier !== undefined) {
      problems.push(`entries ${earlier} and ${n} have the same key`);
      return;
    }
    firstEntryForName.set(name, n);
    firstEntryForKey.set(digestHex, n);
    keys.push({ name, readonly: scope === READONLY_SCOPE, digest });
  });

  if (problems.length > 0) {
    throw new Error(`SERVICE_KEYS is invalid:\n  - ${problems.join("\n  - ")}`);
  }
  return keys;
};

/** For the startup log: names and scopes only. */
export const describeServiceKeys = (keys: readonly ServiceKey[]): string =>
  keys.length === 0
    ? "off"
    : `${keys.length} (${keys.map((k) => (k.readonly ? `${k.name} [${READONLY_SCOPE}]` : k.name)).join(", ")})`;

/** Constant time: fixed-length digests, timingSafeEqual, and every entry compared (no early exit). */
const matchServiceKey = (keys: readonly ServiceKey[], presented: string): ServiceKey | undefined => {
  const digest = sha256(presented);
  let match: ServiceKey | undefined;
  for (const key of keys) {
    if (timingSafeEqual(digest, key.digest) && match === undefined) match = key;
  }
  return match;
};

/**
 * A verifier that accepts a configured service key as "service:<name>" and hands every other token
 * to `fallback` (the Google-backed provider), whose answer or error is returned unchanged.
 */
export const createServiceKeyVerifier = (
  keys: readonly ServiceKey[],
  fallback: OAuthTokenVerifier,
  now: () => number = Date.now
): OAuthTokenVerifier => ({
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const key = matchServiceKey(keys, token);
    if (!key) return fallback.verifyAccessToken(token);
    const identity = `${SERVICE_IDENTITY_PREFIX}${key.name}`;
    return {
      token: identity, // never the key itself
      clientId: identity,
      scopes: key.readonly ? [READONLY_SCOPE] : [],
      expiresAt: Math.floor(now() / 1000) + SERVICE_AUTH_TTL_SECONDS,
      extra: { email: identity, service: key.name, readonly: key.readonly },
    };
  },
});

/** The /mcp verifier: the Google-backed provider ITSELF when no keys are configured (feature off). */
export const buildMcpVerifier = (keys: readonly ServiceKey[], provider: OAuthTokenVerifier): OAuthTokenVerifier =>
  keys.length === 0 ? provider : createServiceKeyVerifier(keys, provider);

/**
 * Tools a read-only service key may not call in this JSON-RPC body (one message or a batch).
 * Empty for a full key, a Google sign-in, or a body with no out-of-scope tools/call. Names that
 * are not plain identifiers are reported as "(invalid)", so nothing odd reaches a log line.
 */
export const toolCallsDeniedByScope = (auth: AuthInfo | undefined, body: unknown): string[] => {
  if (auth?.extra?.readonly !== true) return [];
  const messages = Array.isArray(body) ? body : [body];
  const denied: string[] = [];
  for (const message of messages) {
    const record = message as { method?: unknown; params?: { name?: unknown } } | null;
    if (record?.method !== "tools/call") continue;
    const name = record.params?.name;
    if (typeof name === "string" && READ_ONLY_TOOL.test(name)) continue;
    denied.push(typeof name === "string" && LOGGABLE_TOOL.test(name) ? name : "(invalid)");
  }
  return denied;
};

/**
 * Express middleware for POST /mcp, after the bearer check and the JSON body parser: a read-only
 * service key calling an out-of-scope tool gets HTTP 403 with a JSON-RPC error, and an audit line.
 */
export const enforceServiceKeyScope = (req: Request, res: Response, next: NextFunction): void => {
  const denied = toolCallsDeniedByScope(req.auth, req.body);
  if (denied.length === 0) {
    next();
    return;
  }
  const who = String(req.auth?.extra?.email);
  console.warn(`[qbo-mcp][audit] user=${who} DENIED tool=${denied.join(",")} (read-only service key)`);
  res.status(403).json({
    jsonrpc: "2.0",
    error: {
      code: READONLY_DENIED_CODE,
      message: `Forbidden: this read-only service key may only call search_, get_ and read_ tools (refused: ${denied.join(", ")})`,
    },
    id: null,
  });
};
