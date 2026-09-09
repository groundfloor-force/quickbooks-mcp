/**
 * Access-token issuing and verification.
 *
 * Access tokens are self-contained HS256 JWTs signed with SESSION_SECRET and
 * valid for one hour. They carry the signed-in Google email, which is what the
 * audit log records. Being stateless, they survive a restart — and cannot be
 * revoked before they expire (see revokeToken in provider.ts).
 *
 * Refresh tokens are opaque random strings held in memory; see store.ts.
 */

import { randomBytes, webcrypto } from "node:crypto";
import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { AuthConfig } from "./config.js";

// jose reads the bare `crypto` global at call time; see the matching note in
// google.ts. ??= leaves Node 20+'s built-in global untouched.
globalThis.crypto ??= webcrypto as Crypto;

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
const JWT_ALGORITHM = "HS256";

export interface IssuedAccessToken {
  token: string;
  /** Seconds until expiry, for the OAuth `expires_in` response field. */
  expiresIn: number;
}

export interface AccessTokenSubject {
  email: string;
  clientId: string;
  scopes: string[];
}

/** Cryptographically random opaque token (refresh tokens, codes, state). */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("hex");

export const signAccessToken = async (
  config: AuthConfig,
  subject: AccessTokenSubject
): Promise<IssuedAccessToken> => {
  const token = await new SignJWT({
    email: subject.email,
    scope: subject.scopes.join(" "),
    client_id: subject.clientId,
  })
    .setProtectedHeader({ alg: JWT_ALGORITHM, typ: "JWT" })
    .setSubject(subject.email)
    .setIssuer(config.issuerUrl.href)
    // Bind the token to this MCP resource so it cannot be replayed elsewhere.
    .setAudience(config.resourceUrl.href)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .setJti(randomToken(16))
    .sign(config.sessionSecret);

  return { token, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
};

/**
 * Verifies an access token, returning the SDK's AuthInfo shape.
 *
 * Throws InvalidTokenError on any failure so the bearer middleware answers 401
 * with a WWW-Authenticate header rather than a 500.
 */
export const verifyAccessToken = async (
  config: AuthConfig,
  token: string
): Promise<AuthInfo> => {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, config.sessionSecret, {
      algorithms: [JWT_ALGORITHM],
      issuer: config.issuerUrl.href,
      audience: config.resourceUrl.href,
    }));
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) {
      throw new InvalidTokenError("Access token has expired");
    }
    throw new InvalidTokenError("Access token is invalid");
  }

  const email = typeof payload.email === "string" ? payload.email : undefined;
  if (!email) {
    throw new InvalidTokenError("Access token is missing the email claim");
  }
  if (typeof payload.exp !== "number") {
    throw new InvalidTokenError("Access token is missing an expiry");
  }

  const scope = typeof payload.scope === "string" ? payload.scope : "";
  const clientId = typeof payload.client_id === "string" ? payload.client_id : "";

  return {
    token,
    clientId,
    scopes: scope ? scope.split(" ") : [],
    expiresAt: payload.exp,
    resource: config.resourceUrl,
    // Read by the audit log on every tools/call.
    extra: { email },
  };
};

/** Pulls the signed-in email out of an AuthInfo, for logging. */
export const emailFromAuthInfo = (auth: AuthInfo | undefined): string => {
  const email = auth?.extra?.email;
  return typeof email === "string" ? email : "unknown";
};
