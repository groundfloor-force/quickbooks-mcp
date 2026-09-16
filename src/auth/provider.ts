/**
 * The MCP authorization server, implemented against the SDK's
 * OAuthServerProvider interface.
 *
 * Flow:
 *   MCP client -> /authorize -> (park request) -> Google sign-in
 *              -> /auth/google/callback -> verify email against ALLOWED_EMAILS
 *              -> redirect back to the client with our authorization code
 *              -> /token -> our own access token (JWT) + refresh token
 *
 * PKCE is mandatory: the SDK's authorize handler rejects any request without
 * code_challenge/code_challenge_method=S256, and its token handler verifies the
 * verifier against the challenge returned by challengeForAuthorizationCode.
 */

import type { Request, Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidGrantError,
  InvalidRequestError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

import { isEmailAllowed, type AuthConfig } from "./config.js";
import {
  GoogleSignInError,
  buildGoogleAuthorizationUrl,
  resolveGoogleIdentity,
} from "./google.js";
import {
  authorizationCodeStore,
  clientStore,
  pendingAuthorizationStore,
  refreshTokenStore,
} from "./store.js";
import { randomToken, signAccessToken, verifyAccessToken } from "./tokens.js";

/** Minimal HTML escaping for the few values echoed into error pages. */
const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const page = (title: string, heading: string, body: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f6f7f9;
         color: #1a1a1a; display: flex; align-items: center; justify-content: center;
         min-height: 100vh; margin: 0; padding: 24px; }
  main { background: #fff; border: 1px solid #e3e5e8; border-radius: 12px; padding: 32px;
         max-width: 480px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { line-height: 1.55; margin: 0 0 12px; color: #444; }
  code { background: #f0f1f3; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
</style></head>
<body><main><h1>${escapeHtml(heading)}</h1>${body}</main></body></html>`;

const notAuthorizedPage = (email: string): string =>
  page(
    "Not authorized",
    "Not authorized",
    `<p>The Google account <code>${escapeHtml(email)}</code> is not permitted to use this ` +
      `QuickBooks MCP server.</p><p>Access is limited to a fixed list of addresses. If you ` +
      `believe this is a mistake, ask the server administrator to add your address to ` +
      `<code>ALLOWED_EMAILS</code>.</p><p>You can close this window.</p>`
  );

const errorPage = (heading: string, detail: string): string =>
  page(heading, heading, `<p>${escapeHtml(detail)}</p><p>You can close this window and try again.</p>`);

export class GoogleBackedOAuthProvider implements OAuthServerProvider {
  constructor(private readonly config: AuthConfig) {}

  /**
   * Dynamic client registration, persisted by store.ts so a registered client
   * survives a redeploy. The SDK generates the client_id/secret and hands us the
   * finished record to store.
   */
  public readonly clientsStore: OAuthRegisteredClientsStore = {
    getClient: (clientId: string): OAuthClientInformationFull | undefined =>
      clientStore.get(clientId),
    registerClient: (
      client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">
    ): OAuthClientInformationFull => {
      // The registration handler runs with clientIdGeneration enabled (its
      // default), so it has already assigned client_id/client_id_issued_at even
      // though the declared parameter type omits them.
      const registered = client as OAuthClientInformationFull;
      if (!registered.client_id) {
        throw new ServerError("Client registration did not produce a client_id");
      }
      clientStore.save(registered);
      console.log(
        `[qbo-mcp][auth] Client registered: ${registered.client_id} ` +
          `(${registered.client_name ?? "unnamed"}), ${clientStore.size()} known`
      );
      return registered;
    },
  };

  /**
   * Parks the MCP client's authorization request and sends the user to Google.
   * The code/state pair is only minted once Google confirms an allowed identity.
   */
  public async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    // Our own state for the Google leg; also the key to the parked request.
    // Unguessable, so a third party cannot inject a callback.
    const googleState = randomToken();

    pendingAuthorizationStore.save(googleState, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      clientState: params.state,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes ?? [],
      resource: params.resource?.href,
    });

    console.log(`[qbo-mcp][auth] Authorization started for client ${client.client_id}`);
    res.redirect(302, buildGoogleAuthorizationUrl(this.config, googleState));
  }

  /** Supplies the stored PKCE challenge so the SDK can verify the verifier. */
  public async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const record = authorizationCodeStore.peek(authorizationCode);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError("Authorization code is invalid or has expired");
    }
    return record.codeChallenge;
  }

  public async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string
  ): Promise<OAuthTokens> {
    // Consumes the code: a replay finds nothing and is rejected.
    const record = authorizationCodeStore.take(authorizationCode);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError("Authorization code is invalid or has expired");
    }
    if (redirectUri !== undefined && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }

    return this.issueTokens({
      clientId: client.client_id,
      email: record.email,
      scopes: record.scopes,
      resource: record.resource,
    });
  }

  public async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[]
  ): Promise<OAuthTokens> {
    // Rotation: the presented token is consumed and a fresh one issued.
    const record = refreshTokenStore.take(refreshToken);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError("Refresh token is invalid, expired, or already used");
    }

    // A refresh may narrow scope but never widen it.
    const granted = scopes?.length
      ? scopes.filter((scope) => record.scopes.includes(scope))
      : record.scopes;

    // The allow-list is re-checked here: removing someone from ALLOWED_EMAILS
    // stops their refreshes at the next rotation instead of lasting 30 days.
    if (!isEmailAllowed(this.config, record.email)) {
      console.warn(
        `[qbo-mcp][auth] Refresh denied for ${record.email} — no longer in ALLOWED_EMAILS`
      );
      throw new InvalidGrantError("This account is no longer authorized");
    }

    return this.issueTokens({
      clientId: client.client_id,
      email: record.email,
      scopes: granted,
      resource: record.resource,
    });
  }

  public async verifyAccessToken(token: string): Promise<AuthInfo> {
    return verifyAccessToken(this.config, token);
  }

  /**
   * Revokes a refresh token. Access tokens are stateless JWTs and cannot be
   * revoked before they expire; they are short-lived (1 hour) for that reason.
   */
  public async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    refreshTokenStore.delete(request.token);
  }

  private async issueTokens(subject: {
    clientId: string;
    email: string;
    scopes: string[];
    resource?: string;
  }): Promise<OAuthTokens> {
    const accessToken = await signAccessToken(this.config, {
      email: subject.email,
      clientId: subject.clientId,
      scopes: subject.scopes,
    });

    const refreshToken = randomToken();
    refreshTokenStore.save(refreshToken, {
      clientId: subject.clientId,
      email: subject.email,
      scopes: subject.scopes,
      resource: subject.resource,
    });

    console.log(`[qbo-mcp][auth] Tokens issued for ${subject.email}`);

    return {
      access_token: accessToken.token,
      token_type: "Bearer",
      expires_in: accessToken.expiresIn,
      scope: subject.scopes.join(" "),
      refresh_token: refreshToken,
    };
  }

  /**
   * GET /auth/google/callback — where Google returns the user.
   *
   * Verifies the identity, enforces ALLOWED_EMAILS and email_verified, then
   * redirects back to the MCP client with an authorization code.
   */
  public handleGoogleCallback = async (req: Request, res: Response): Promise<void> => {
    const state = typeof req.query.state === "string" ? req.query.state : undefined;
    const code = typeof req.query.code === "string" ? req.query.code : undefined;
    const googleError = typeof req.query.error === "string" ? req.query.error : undefined;

    // The parked request is keyed by state; without it there is nowhere safe to
    // redirect, so the error has to be rendered here.
    const pending = state ? pendingAuthorizationStore.take(state) : undefined;
    if (!pending) {
      res
        .status(400)
        .type("html")
        .send(
          errorPage(
            "Sign-in expired",
            "This sign-in link is no longer valid. Authorization requests expire after 10 minutes, and are also cleared when the server restarts. Please start again from your MCP client."
          )
        );
      return;
    }

    const redirectToClient = (params: Record<string, string>): void => {
      const target = new URL(pending.redirectUri);
      for (const [key, value] of Object.entries(params)) {
        target.searchParams.set(key, value);
      }
      if (pending.clientState) {
        target.searchParams.set("state", pending.clientState);
      }
      res.redirect(302, target.href);
    };

    if (googleError || !code) {
      redirectToClient({
        error: "access_denied",
        error_description: googleError ?? "Google did not return an authorization code",
      });
      return;
    }

    let identity;
    try {
      identity = await resolveGoogleIdentity(this.config, code);
    } catch (error) {
      if (error instanceof GoogleSignInError) {
        // The message names the failed check and is log-safe by construction:
        // it never carries the Google code, the ID token, or a credential.
        console.warn(
          `[qbo-mcp][auth] Google sign-in failed for client ${pending.clientId}: ${error.message}`
        );
      } else {
        console.error("[qbo-mcp][auth] Google identity verification failed unexpectedly:", error);
      }
      res
        .status(502)
        .type("html")
        .send(errorPage("Sign-in failed", "Could not verify your Google sign-in. Please try again."));
      return;
    }

    // Both checks are required: an unverified address can be attacker-controlled.
    if (!identity.emailVerified) {
      console.warn(`[qbo-mcp][auth] DENIED ${identity.email} — email not verified by Google`);
      res.status(403).type("html").send(notAuthorizedPage(identity.email));
      return;
    }
    if (!isEmailAllowed(this.config, identity.email)) {
      console.warn(`[qbo-mcp][auth] DENIED ${identity.email} — not in ALLOWED_EMAILS`);
      res.status(403).type("html").send(notAuthorizedPage(identity.email));
      return;
    }

    const authorizationCode = randomToken();
    authorizationCodeStore.save(authorizationCode, {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      // Store the canonical lower-cased form so the audit log is consistent.
      email: identity.email.trim().toLowerCase(),
      scopes: pending.scopes,
      resource: pending.resource,
    });

    console.log(`[qbo-mcp][auth] ALLOWED ${identity.email} — authorization code issued`);
    redirectToClient({ code: authorizationCode });
  };
}

export const buildErrorPage = errorPage;
