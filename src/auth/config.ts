/**
 * Environment-driven configuration for the OAuth layer.
 *
 * Everything here comes from process.env — no secret is ever read from or
 * written to a file. Validation runs once at startup and reports EVERY problem
 * at once, because discovering missing config one variable per redeploy is
 * miserable.
 */

/** Minimum HS256 key length. A short secret is a forgeable access token. */
const MIN_SESSION_SECRET_LENGTH = 32;

export interface AuthConfig {
  /** Public origin of this server, e.g. https://qbo-mcp.up.railway.app */
  publicUrl: URL;
  /** OAuth issuer — same as publicUrl; advertised in the metadata document. */
  issuerUrl: URL;
  /** Canonical URL of the protected MCP resource. */
  resourceUrl: URL;
  /** Where Google sends the user back. Must be registered in the Google console. */
  googleRedirectUri: string;
  googleClientId: string;
  googleClientSecret: string;
  /** Lower-cased allow-list. Membership is the ONLY authorization check. */
  allowedEmails: ReadonlySet<string>;
  /** HS256 signing key for our own access tokens. */
  sessionSecret: Uint8Array;
}

const REQUIRED_VARS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "ALLOWED_EMAILS",
  "PUBLIC_URL",
  "SESSION_SECRET",
] as const;

/** Trailing slashes make `new URL(path, base)` silently drop path segments. */
const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

export const parseAllowedEmails = (raw: string): Set<string> =>
  new Set(
    raw
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.length > 0)
  );

/**
 * Reads and validates configuration, throwing a single actionable error listing
 * every problem found.
 */
export const loadAuthConfig = (): AuthConfig => {
  const problems: string[] = [];

  for (const name of REQUIRED_VARS) {
    if (!process.env[name]?.trim()) {
      problems.push(`${name} is required but not set`);
    }
  }

  const rawPublicUrl = process.env.PUBLIC_URL?.trim();
  let publicUrl: URL | undefined;
  if (rawPublicUrl) {
    try {
      publicUrl = new URL(stripTrailingSlash(rawPublicUrl));
      if (publicUrl.search || publicUrl.hash) {
        problems.push("PUBLIC_URL must not contain a query string or fragment");
      }
      const isLoopback =
        publicUrl.hostname === "localhost" || publicUrl.hostname === "127.0.0.1";
      if (publicUrl.protocol !== "https:" && !isLoopback) {
        problems.push(
          `PUBLIC_URL must use https (got "${publicUrl.protocol}//"); only localhost may use http`
        );
      }
    } catch {
      problems.push(`PUBLIC_URL is not a valid URL: "${rawPublicUrl}"`);
    }
  }

  const allowedEmails = parseAllowedEmails(process.env.ALLOWED_EMAILS ?? "");
  if (process.env.ALLOWED_EMAILS?.trim() && allowedEmails.size === 0) {
    problems.push("ALLOWED_EMAILS is set but contains no usable addresses");
  }

  const sessionSecret = process.env.SESSION_SECRET ?? "";
  if (sessionSecret.trim() && sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    problems.push(
      `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters ` +
        `(got ${sessionSecret.length}); generate one with: openssl rand -hex 32`
    );
  }

  if (problems.length > 0 || !publicUrl) {
    throw new Error(
      "Authentication configuration is invalid:\n" +
        problems.map((p) => `  - ${p}`).join("\n") +
        "\n\nSet these as environment variables (never in a committed file). See .env.example."
    );
  }

  return {
    publicUrl,
    issuerUrl: publicUrl,
    resourceUrl: new URL("/mcp", publicUrl),
    googleRedirectUri: new URL("/auth/google/callback", publicUrl).href,
    googleClientId: process.env.GOOGLE_CLIENT_ID!.trim(),
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET!.trim(),
    allowedEmails,
    sessionSecret: new TextEncoder().encode(sessionSecret),
  };
};

/** True when the address is on the allow-list. Case-insensitive, exact match. */
export const isEmailAllowed = (config: AuthConfig, email: string): boolean =>
  config.allowedEmails.has(email.trim().toLowerCase());
