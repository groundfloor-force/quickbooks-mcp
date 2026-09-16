/**
 * Google as the identity provider — standard OAuth 2.0 / OpenID Connect web
 * flow, scope "openid email".
 *
 * Google only establishes WHO the user is. Whether that person may use this
 * server is decided solely by the ALLOWED_EMAILS list (see config.ts); no
 * domain rule is applied.
 */

import { webcrypto } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { AuthConfig } from "./config.js";

// jose reads the bare `crypto` global at call time. Node 20+ defines it, and
// package.json/.nvmrc pin that — this is the belt-and-braces for a runtime that
// slips through anyway (Node < 20 threw "ReferenceError: crypto is not defined"
// during Google ID token verification). Safe on modern Node: ??= leaves the
// built-in global untouched.
globalThis.crypto ??= webcrypto as Crypto;

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";
// Google is inconsistent about the scheme in the `iss` claim; both are valid.
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

/** Cached across calls — jose refreshes the key set on its own schedule. */
const googleJwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URI));

/**
 * A Google sign-in that could not be completed or verified. The message names
 * the specific check that failed and is safe to log: it never contains the
 * authorization code, the ID token, or any credential.
 */
export class GoogleSignInError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "GoogleSignInError";
  }
}

export interface GoogleIdentity {
  email: string;
  emailVerified: boolean;
}

/** Builds the URL the user's browser is sent to in order to sign in. */
export const buildGoogleAuthorizationUrl = (config: AuthConfig, state: string): string => {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set("client_id", config.googleClientId);
  url.searchParams.set("redirect_uri", config.googleRedirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email");
  url.searchParams.set("state", state);
  // Let the user pick which Google account to use rather than silently
  // reusing whichever one the browser happens to be signed in as.
  url.searchParams.set("prompt", "select_account");
  return url.href;
};

/** Exchanges the Google authorization code for an ID token. */
const exchangeCodeForIdToken = async (
  config: AuthConfig,
  code: string
): Promise<string> => {
  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        redirect_uri: config.googleRedirectUri,
        grant_type: "authorization_code",
      }),
    });
  } catch (error) {
    throw new GoogleSignInError(
      `Could not reach Google's token endpoint: ${(error as Error).message}`
    );
  }

  if (!response.ok) {
    // Google's error body is {error, error_description} — e.g. invalid_grant
    // (the code was already used or has expired) or invalid_client (wrong
    // GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET). Only those two fields are kept.
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      error_description?: string;
    };
    const detail = [body.error, body.error_description].filter(Boolean).join(" — ");
    throw new GoogleSignInError(
      `Google token exchange failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`
    );
  }

  // Parsed defensively: a JSON.parse error quotes the body, which holds tokens.
  const payload = (await response.json().catch(() => ({}))) as { id_token?: string };
  if (!payload.id_token) {
    throw new GoogleSignInError("Google's token response did not include an id_token");
  }
  return payload.id_token;
};

/**
 * Completes the Google leg: exchanges the code and verifies the resulting ID
 * token's signature, issuer and audience against Google's published keys.
 */
export const resolveGoogleIdentity = async (
  config: AuthConfig,
  code: string
): Promise<GoogleIdentity> => {
  const idToken = await exchangeCodeForIdToken(config, code);

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, googleJwks, {
      issuer: GOOGLE_ISSUERS,
      audience: config.googleClientId,
    }));
  } catch (error) {
    // jose's messages name the failed check — `unexpected "aud" claim value`,
    // `signature verification failed` — and never include the token or its
    // claim values.
    throw new GoogleSignInError(
      `Google ID token failed verification: ${(error as Error).message}`
    );
  }

  const email = typeof payload.email === "string" ? payload.email : undefined;
  if (!email) {
    throw new GoogleSignInError("Google ID token did not contain an email claim");
  }

  // Google sends email_verified as a boolean, but older payloads use "true".
  const rawVerified = payload.email_verified;
  const emailVerified = rawVerified === true || rawVerified === "true";

  return { email, emailVerified };
};
