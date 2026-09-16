/**
 * State for the authorization server.
 *
 * Registered clients and refresh tokens are PERSISTED to a JSON file (see
 * resolveAuthStorePath and loadAuthStore), so a restart or redeploy no longer
 * disconnects every MCP client — provided the file sits on storage that
 * outlives the container, such as a mounted volume.
 *
 * Pending authorizations (10 minutes) and authorization codes (5 minutes) stay
 * in memory only. A restart interrupts a sign-in that is in progress, and the
 * user simply starts it again.
 *
 * Refresh tokens are held — in memory and on disk — only as SHA-256 digests, so
 * the file cannot be used to mint access tokens. Client secrets are kept as
 * issued, because the SDK compares them directly; the file is written 0600.
 *
 * Running more than one replica still will not work: an authorization started
 * on one instance cannot be completed on another, and two processes would
 * overwrite each other's file. Keep this at one replica.
 *
 * Issued access tokens are stateless JWTs, so they remain valid until they
 * expire (1 hour) even across a restart, and cannot be revoked early.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

export const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const PENDING_AUTHORIZATION_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const AUTH_STORE_FILENAME = "auth-store.json";
const FALLBACK_AUTH_STORE_PATH = "/tmp/auth-store.json";
const STORE_FORMAT_VERSION = 1;

/** An /authorize request parked while the user signs in with Google. */
export interface PendingAuthorization {
  clientId: string;
  /** Where the MCP client wants the authorization code delivered. */
  redirectUri: string;
  /** The MCP client's own `state`, echoed back verbatim. */
  clientState?: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

/** An issued authorization code, redeemable exactly once. */
export interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  email: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

export interface RefreshTokenRecord {
  clientId: string;
  email: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

/** The on-disk format. Refresh tokens are keyed by digest, never by value. */
interface StoreFile {
  version: typeof STORE_FORMAT_VERSION;
  clients: Record<string, OAuthClientInformationFull>;
  refreshTokens: Record<string, RefreshTokenRecord>;
}

const clients = new Map<string, OAuthClientInformationFull>();
const pendingAuthorizations = new Map<string, PendingAuthorization>();
const authorizationCodes = new Map<string, AuthorizationCode>();
/** Keyed by the SHA-256 digest of the token. */
const refreshTokens = new Map<string, RefreshTokenRecord>();

/** Where clients and refresh tokens are written. Unset until loadAuthStore runs. */
let storePath: string | undefined;

const digest = (token: string): string => createHash("sha256").update(token).digest("hex");

const isExpired = (entry: { expiresAt: number }): boolean => entry.expiresAt <= Date.now();

/** Reads an entry, treating an expired one as absent and evicting it. */
const takeIfFresh = <T extends { expiresAt: number }>(
  map: Map<string, T>,
  key: string,
  consume: boolean
): T | undefined => {
  const entry = map.get(key);
  if (!entry) return undefined;
  if (isExpired(entry)) {
    map.delete(key);
    return undefined;
  }
  if (consume) map.delete(key);
  return entry;
};

/** Removes expired entries, reporting whether anything was removed. */
const evictExpired = (map: Map<string, { expiresAt: number }>): boolean => {
  let removed = false;
  for (const [key, entry] of map) {
    if (isExpired(entry)) {
      map.delete(key);
      removed = true;
    }
  }
  return removed;
};

/**
 * Writes clients and refresh tokens atomically — a temp file in the same
 * directory, renamed over the store — so a crash mid-write can never leave a
 * truncated file. A failure is logged, not thrown: the server keeps working
 * from memory, exactly as it did before persistence existed.
 */
const persist = (): void => {
  if (!storePath) return;

  const contents: StoreFile = {
    version: STORE_FORMAT_VERSION,
    clients: Object.fromEntries(clients),
    refreshTokens: Object.fromEntries(refreshTokens),
  };
  const tempPath = `${storePath}.tmp.${process.pid}`;

  try {
    fs.writeFileSync(tempPath, JSON.stringify(contents, null, 2), { mode: 0o600 });
    fs.renameSync(tempPath, storePath);
  } catch (error) {
    console.error(
      `[qbo-mcp][auth] Could not write the auth store to ${storePath}: ` +
        `${(error as Error).message}. The change is held in memory only and will be ` +
        "lost on restart."
    );
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best effort — the write failure above is the problem worth reporting.
    }
  }
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Reads the store file. A missing file is an empty store. A file this code did
 * not write is moved aside — never deleted — and the store starts empty, since
 * losing it only means clients reconnect, which beats refusing to boot. Any
 * other read failure (a directory, a permission problem) is a misconfiguration
 * and throws.
 */
const readStoreFile = (filePath: string): StoreFile | undefined => {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !isObject(parsed) ||
      parsed.version !== STORE_FORMAT_VERSION ||
      !isObject(parsed.clients) ||
      !isObject(parsed.refreshTokens)
    ) {
      throw new Error(`not a version ${STORE_FORMAT_VERSION} auth store`);
    }
    return parsed as unknown as StoreFile;
  } catch (error) {
    const setAsidePath = `${filePath}.corrupt-${Date.now()}`;
    fs.renameSync(filePath, setAsidePath);
    console.warn(
      `[qbo-mcp][auth] WARNING: ${filePath} could not be loaded ` +
        `(${(error as Error).message}). Moved it to ${setAsidePath} and started with an ` +
        "empty auth store — connected clients will need to reconnect."
    );
    return undefined;
  }
};

/**
 * Where the auth store lives: AUTH_STORE_PATH; else auth-store.json beside the
 * QuickBooks token store (on Railway, the same mounted volume); else /tmp,
 * which does not survive a redeploy — hence the warning.
 *
 * Pass the environment as the operator set it, BEFORE anything fills in a
 * default QUICKBOOKS_TOKEN_STORE_PATH, or the fallback can never be detected.
 */
export const resolveAuthStorePath = (
  env: NodeJS.ProcessEnv
): { path: string; warning?: string } => {
  const explicitPath = env.AUTH_STORE_PATH?.trim();
  if (explicitPath) return { path: explicitPath };

  const tokenStorePath = env.QUICKBOOKS_TOKEN_STORE_PATH?.trim();
  if (tokenStorePath) {
    return { path: path.join(path.dirname(tokenStorePath), AUTH_STORE_FILENAME) };
  }

  return {
    path: FALLBACK_AUTH_STORE_PATH,
    warning:
      "Neither AUTH_STORE_PATH nor QUICKBOOKS_TOKEN_STORE_PATH is set, so the auth store " +
      `is ${FALLBACK_AUTH_STORE_PATH} (ephemeral). Registered clients and refresh tokens ` +
      "will NOT survive a redeploy, and every connected client will have to reconnect. " +
      "Set AUTH_STORE_PATH to a file on a mounted volume.",
  };
};

/**
 * Points the store at `filePath` and replaces the in-memory clients and refresh
 * tokens with the file's contents, skipping refresh tokens that have expired.
 * Call once at startup, before serving requests.
 */
export const loadAuthStore = (filePath: string): { clients: number; refreshTokens: number } => {
  storePath = filePath;
  clients.clear();
  refreshTokens.clear();

  const stored = readStoreFile(filePath);
  if (stored) {
    for (const [clientId, client] of Object.entries(stored.clients)) {
      clients.set(clientId, client);
    }
    for (const [key, record] of Object.entries(stored.refreshTokens)) {
      if (!isExpired(record)) refreshTokens.set(key, record);
    }
  }

  console.log(
    `[qbo-mcp][auth] Auth store: ${filePath} — loaded ${clients.size} client(s), ` +
      `${refreshTokens.size} refresh token(s)`
  );
  return { clients: clients.size, refreshTokens: refreshTokens.size };
};

export const clientStore = {
  get: (clientId: string): OAuthClientInformationFull | undefined => clients.get(clientId),
  save: (client: OAuthClientInformationFull): void => {
    clients.set(client.client_id, client);
    persist();
  },
  size: (): number => clients.size,
};

export const pendingAuthorizationStore = {
  save: (key: string, value: Omit<PendingAuthorization, "expiresAt">): void => {
    pendingAuthorizations.set(key, {
      ...value,
      expiresAt: Date.now() + PENDING_AUTHORIZATION_TTL_MS,
    });
  },
  /** Single use: a pending authorization is consumed by the Google callback. */
  take: (key: string): PendingAuthorization | undefined =>
    takeIfFresh(pendingAuthorizations, key, true),
};

export const authorizationCodeStore = {
  save: (code: string, value: Omit<AuthorizationCode, "expiresAt">): void => {
    authorizationCodes.set(code, { ...value, expiresAt: Date.now() + AUTHORIZATION_CODE_TTL_MS });
  },
  /** Non-consuming read, used for the PKCE challenge lookup before redemption. */
  peek: (code: string): AuthorizationCode | undefined =>
    takeIfFresh(authorizationCodes, code, false),
  /** Redeems the code, guaranteeing it cannot be replayed. */
  take: (code: string): AuthorizationCode | undefined =>
    takeIfFresh(authorizationCodes, code, true),
};

export const refreshTokenStore = {
  save: (token: string, value: Omit<RefreshTokenRecord, "expiresAt">): void => {
    refreshTokens.set(digest(token), { ...value, expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS });
    persist();
  },
  /** Rotation: the presented token is consumed and replaced on every use. */
  take: (token: string): RefreshTokenRecord | undefined => {
    const key = digest(token);
    if (!refreshTokens.has(key)) return undefined;
    // Removed whether fresh or expired, so the removal is always written —
    // otherwise a redeemed token would come back to life after a restart.
    const record = takeIfFresh(refreshTokens, key, true);
    persist();
    return record;
  },
  delete: (token: string): boolean => {
    const removed = refreshTokens.delete(digest(token));
    if (removed) persist();
    return removed;
  },
  size: (): number => refreshTokens.size,
};

/** Drops expired entries so an idle server does not accumulate dead state. */
export const sweepExpired = (): void => {
  evictExpired(pendingAuthorizations);
  evictExpired(authorizationCodes);
  if (evictExpired(refreshTokens)) persist();
};

/** Starts the periodic sweep. Unref'd so it never holds the process open. */
export const startExpirySweep = (intervalMs = 60_000): NodeJS.Timeout => {
  const timer = setInterval(sweepExpired, intervalMs);
  timer.unref();
  return timer;
};
