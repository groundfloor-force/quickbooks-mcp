/**
 * In-memory state for the authorization server.
 *
 * DELIBERATELY EPHEMERAL. This server has no database, so registered clients,
 * pending authorizations, authorization codes and refresh tokens all live in
 * process memory and are LOST on restart, redeploy, or container replacement.
 *
 * Practical consequences:
 *  - Refresh tokens stop working after a redeploy. The user simply signs in
 *    with Google again; nothing is corrupted and no data is lost.
 *  - Dynamically registered clients disappear too, so a client may need to
 *    re-run dynamic registration before it can re-authorize.
 *  - Running more than one replica will not work: an authorization started on
 *    one instance cannot be completed on another. Keep this at one replica.
 *
 * Issued access tokens are stateless JWTs, so they remain valid until they
 * expire (1 hour) even across a restart, and cannot be revoked early.
 */

import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

export const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const PENDING_AUTHORIZATION_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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

const clients = new Map<string, OAuthClientInformationFull>();
const pendingAuthorizations = new Map<string, PendingAuthorization>();
const authorizationCodes = new Map<string, AuthorizationCode>();
const refreshTokens = new Map<string, RefreshTokenRecord>();

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

export const clientStore = {
  get: (clientId: string): OAuthClientInformationFull | undefined => clients.get(clientId),
  save: (client: OAuthClientInformationFull): void => {
    clients.set(client.client_id, client);
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
    refreshTokens.set(token, { ...value, expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS });
  },
  /** Rotation: the presented token is consumed and replaced on every use. */
  take: (token: string): RefreshTokenRecord | undefined => takeIfFresh(refreshTokens, token, true),
  delete: (token: string): boolean => refreshTokens.delete(token),
  size: (): number => refreshTokens.size,
};

/** Drops expired entries so an idle server does not accumulate dead state. */
export const sweepExpired = (): void => {
  for (const map of [pendingAuthorizations, authorizationCodes, refreshTokens]) {
    for (const [key, entry] of map) {
      if (isExpired(entry)) map.delete(key);
    }
  }
};

/** Starts the periodic sweep. Unref'd so it never holds the process open. */
export const startExpirySweep = (intervalMs = 60_000): NodeJS.Timeout => {
  const timer = setInterval(sweepExpired, intervalMs);
  timer.unref();
  return timer;
};
