#!/usr/bin/env node

/**
 * Remote (Streamable HTTP) entry point, protected by OAuth.
 *
 * Serves the same QuickBooks MCP server as the stdio entry point (src/index.ts)
 * over HTTP so it can be added to Claude.ai as a custom connector. Tool
 * definitions are NOT duplicated here — both entry points register the
 * identical list via ./register-all-tools.js.
 *
 * This process is both the MCP resource server AND its OAuth authorization
 * server. Google is only the identity provider: it establishes who the user is,
 * and ALLOWED_EMAILS decides whether that person may in.
 *
 * Routes:
 *   GET  /health                                   -> 200 "ok"  (public)
 *   GET  /.well-known/oauth-authorization-server   -> AS metadata (public)
 *   GET  /.well-known/oauth-protected-resource/mcp -> RS metadata (public)
 *   /authorize /token /register /revoke            -> OAuth endpoints, PKCE required
 *   GET  /auth/google/callback                     -> Google redirects here
 *   POST|GET|DELETE /mcp                           -> MCP, Bearer token required
 *
 * The Bearer token on /mcp is either an access token from the Google sign-in above, or a
 * SERVICE_KEYS key for a non-interactive client (./auth/service-keys.ts). With SERVICE_KEYS unset,
 * only the Google sign-in exists and nothing below differs.
 */

import express, { type Request, type Response } from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { QuickbooksMCPServer } from "./server/qbo-mcp-server.js";
import { loadAuthConfig, type AuthConfig } from "./auth/config.js";
import { GoogleBackedOAuthProvider } from "./auth/provider.js";
import { loadAuthStore, resolveAuthStorePath, startExpirySweep } from "./auth/store.js";
import { emailFromAuthInfo } from "./auth/tokens.js";
import {
  buildMcpVerifier,
  describeServiceKeys,
  enforceServiceKeyScope,
  parseServiceKeys,
  type ServiceKey,
} from "./auth/service-keys.js";
import { formatError } from "./helpers/format-error.js";
import { makeShutdown } from "./helpers/shutdown.js";

const MCP_PATH = "/mcp";
const HEALTH_PATH = "/health";
const PRIVACY_PATH = "/privacy";
const TERMS_PATH = "/terms";

/** Date shown on the policy pages. Fixed at the release these pages shipped. */
const POLICY_EFFECTIVE_DATE = "9 September 2026";

/**
 * Minimal self-contained document. No external assets: these pages are served
 * to OAuth consent reviewers and must render with no network access beyond the
 * page itself.
 */
const policyPage = (title: string, sections: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #1a1a1a;
         background: #fff; margin: 0 auto; padding: 40px 24px; max-width: 720px;
         line-height: 1.6; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 28px 0 8px; }
  p, li { color: #333; }
  ul { padding-left: 20px; }
  .meta { color: #666; font-size: 14px; margin: 0 0 24px; }
  footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #e3e5e8;
           color: #666; font-size: 14px; }
</style></head>
<body>
<h1>${title}</h1>
<p class="meta">Effective date: ${POLICY_EFFECTIVE_DATE}</p>
${sections}
<footer>Contact: <a href="mailto:steven@getcore.ca">steven@getcore.ca</a></footer>
</body></html>`;

const PRIVACY_HTML = policyPage(
  "CORE QuickBooks MCP — Privacy Policy",
  `<p>This service is an internal tool operated by CORE Property Services / Ground Floor
Property Management for its own employees. It is not offered to the general public.</p>

<h2>What we receive when you sign in</h2>
<p>Sign-in uses Google. We receive only your name and email address, and we use them
solely to confirm that you are an authorized employee.</p>

<h2>QuickBooks data</h2>
<p>QuickBooks data is accessed on your behalf and returned to the AI assistant you are
using. We do not store QuickBooks data on this server beyond in-memory session state,
which is discarded when the session ends or the server restarts.</p>

<h2>Logging</h2>
<p>Access is logged for audit purposes. Each log entry records the user's email address,
the name of the tool invoked, and a timestamp.</p>

<h2>Sharing</h2>
<p>No data is sold or shared with third parties.</p>`
);

const TERMS_HTML = policyPage(
  "CORE QuickBooks MCP — Terms of Service",
  `<h2>Who may use this service</h2>
<p>Use is restricted to authorized employees on the allow-list maintained by CORE
Property Services / Ground Floor Property Management.</p>

<h2>Your responsibilities</h2>
<ul>
  <li>You must not share your sign-in credentials.</li>
  <li>You must not share your access to this service with anyone else.</li>
</ul>

<h2>Revocation</h2>
<p>Access may be revoked at any time, without notice, at the operator's discretion.</p>

<h2>No warranty</h2>
<p>This service is provided as-is for internal use, without warranty of any kind.</p>`
);

// Railway injects PORT; fall back to 3000 for local runs.
const PORT = Number.parseInt(process.env.PORT ?? "", 10) || 3000;
// Bind all interfaces — a container-local bind would be unreachable from the edge.
const HOST = "0.0.0.0";

// Cap request bodies so a malformed or hostile client cannot exhaust memory.
const MAX_BODY_BYTES =
  Number.parseInt(process.env.MCP_MAX_BODY_BYTES ?? "", 10) || 10 * 1024 * 1024;

/** A live MCP session, pinned to the user who opened it. */
interface Session {
  transport: StreamableHTTPServerTransport;
  email: string;
}

const sessions = new Map<string, Session>();

/** Fallback token store when the environment does not name one. Ephemeral. */
const DEFAULT_TOKEN_STORE_PATH = "/tmp/qbo-token.env";

/**
 * Resolves where rotated QuickBooks refresh tokens are persisted, and warns when
 * that location will not survive a redeploy.
 *
 * The default is applied HERE rather than in the start script so that a
 * deployment variable — a mounted volume, say — always wins. It must run before
 * ./register-all-tools.js is imported, because the QuickBooks client reads
 * QUICKBOOKS_TOKEN_STORE_PATH once, at module-evaluation time.
 */
const configureTokenStore = (): void => {
  const configured = process.env.QUICKBOOKS_TOKEN_STORE_PATH?.trim();
  const tokenStorePath = configured || DEFAULT_TOKEN_STORE_PATH;

  if (!configured) {
    process.env.QUICKBOOKS_TOKEN_STORE_PATH = DEFAULT_TOKEN_STORE_PATH;
  }

  const isEphemeral =
    tokenStorePath === "/tmp" ||
    tokenStorePath.startsWith("/tmp/") ||
    tokenStorePath.startsWith("/var/tmp/");

  if (isEphemeral) {
    console.warn(
      `[qbo-mcp] WARNING: token store is ${tokenStorePath} (ephemeral). QuickBooks ` +
        "rotates the refresh token, and the rotated value is written there — it " +
        "will NOT survive a redeploy, restart, or container replacement. After a " +
        "redeploy the server falls back to the QUICKBOOKS_REFRESH_TOKEN env var, " +
        "which by then may be stale, and QuickBooks auth will fail until it is " +
        "re-authorized. Move this to a mounted volume before relying on it."
    );
  } else {
    console.log(`[qbo-mcp] Token store: ${tokenStorePath}`);
  }
};

/**
 * The audit trail: one info line per tool invocation, naming the signed-in user.
 * Reads the already-parsed JSON-RPC body, so no tool code has to change.
 */
const logToolCalls = (email: string, body: unknown): void => {
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    const record = message as { method?: unknown; params?: { name?: unknown } } | null;
    if (record?.method === "tools/call") {
      const tool = typeof record.params?.name === "string" ? record.params.name : "unknown";
      console.info(`[qbo-mcp][audit] user=${email} tool=${tool}`);
    }
  }
};

const sendJsonRpcError = (
  res: Response,
  statusCode: number,
  code: number,
  message: string
): void => {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(statusCode).json({ jsonrpc: "2.0", error: { code, message }, id: null });
};

const main = async (): Promise<void> => {
  // Fail fast, before anything else, with every configuration problem listed.
  let config: AuthConfig;
  try {
    config = loadAuthConfig();
  } catch (error) {
    console.error(`[qbo-mcp] ${(error as Error).message}`);
    process.exit(1);
  }

  // Optional bearer keys for non-interactive clients. Unset = off. A malformed value (a key under
  // 32 characters, an unknown scope, a duplicate) refuses to start; the message never holds a key.
  let serviceKeys: ServiceKey[];
  try {
    serviceKeys = parseServiceKeys(process.env.SERVICE_KEYS);
  } catch (error) {
    console.error(`[qbo-mcp] ${(error as Error).message}`);
    process.exit(1);
  }

  // Registered clients and refresh tokens, restored so a redeploy does not
  // disconnect every MCP client. Resolved BEFORE configureTokenStore fills in its
  // default QUICKBOOKS_TOKEN_STORE_PATH, which would otherwise mask the case
  // where neither path variable was set and skip the warning.
  const authStore = resolveAuthStorePath(process.env);
  if (authStore.warning) {
    console.warn(`[qbo-mcp] WARNING: ${authStore.warning}`);
  }
  loadAuthStore(authStore.path);

  // Must precede the dynamic import below — the QuickBooks client reads
  // QUICKBOOKS_TOKEN_STORE_PATH as its module body evaluates.
  configureTokenStore();

  // Imported dynamically so the warnings above are emitted BEFORE the QuickBooks
  // client module is evaluated — that module validates credentials at import
  // time and throws when they are missing, and a bare stack trace with no
  // preceding context is painful to diagnose from deploy logs.
  let registerAllTools: (
    server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer
  ) => void;
  let QuickbooksClient: typeof import("./clients/quickbooks-client.js").QuickbooksClient;
  try {
    ({ registerAllTools } = await import("./register-all-tools.js"));
    ({ QuickbooksClient } = await import("./clients/quickbooks-client.js"));
  } catch (error) {
    console.error(
      "[qbo-mcp] Failed to load tools. QuickBooks configuration is read from " +
        "environment variables (QUICKBOOKS_CLIENT_ID, QUICKBOOKS_CLIENT_SECRET, " +
        "QUICKBOOKS_REDIRECT_URI at minimum). Underlying error:"
    );
    throw error;
  }

  const provider = new GoogleBackedOAuthProvider(config);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(config.resourceUrl);
  startExpirySweep();

  const app = express();
  // Railway terminates TLS and forwards; without this the SDK's rate limiters
  // see the proxy's address for every caller.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  // Public: the deploy health check must never require a token.
  app.get(HEALTH_PATH, (_req: Request, res: Response) => {
    res.type("text/plain").send("ok");
  });

  // Public: policy pages. These must stay reachable without a token — they are
  // linked from the Google OAuth consent screen, which is fetched anonymously.
  app.get(PRIVACY_PATH, (_req: Request, res: Response) => {
    res.type("html").send(PRIVACY_HTML);
  });
  app.get(TERMS_PATH, (_req: Request, res: Response) => {
    res.type("html").send(TERMS_HTML);
  });

  // OAuth authorization server: /.well-known/*, /authorize, /token,
  // /register and /revoke. Must be mounted at the application root.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: config.issuerUrl,
      baseUrl: config.publicUrl,
      resourceServerUrl: config.resourceUrl,
      resourceName: "QuickBooks Online MCP Server",
    })
  );

  // Where Google sends the user back after sign-in.
  app.get("/auth/google/callback", provider.handleGoogleCallback);

  // The ONE place service keys enter: they are checked first, and any other token goes to the
  // Google-backed provider exactly as before. With no keys, the verifier IS the provider.
  const requireAuth = requireBearerAuth({
    verifier: buildMcpVerifier(serviceKeys, provider),
    resourceMetadataUrl,
  });

  // Expose the headers a browser-based MCP client needs to read. The SDK's own
  // OAuth handlers already apply CORS to their routes.
  const mcpCors = cors({
    exposedHeaders: ["mcp-session-id", "WWW-Authenticate"],
    allowedHeaders: ["content-type", "authorization", "mcp-session-id", "mcp-protocol-version"],
  });

  app.options(MCP_PATH, mcpCors);

  /** Resolves the session for a request, enforcing that it belongs to the caller. */
  const resolveSession = (req: Request, res: Response): Session | undefined | "denied" => {
    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId !== "string" || sessionId === "") return undefined;

    const session = sessions.get(sessionId);
    if (!session) return undefined;

    const email = emailFromAuthInfo(req.auth);
    if (session.email !== email) {
      // Every signed-in user has the same tools, so this is not a privilege
      // boundary — but an unpinned session would make the audit log unreliable.
      console.warn(
        `[qbo-mcp][audit] Session ${sessionId} belongs to ${session.email}; ` +
          `rejected request from ${email}`
      );
      sendJsonRpcError(res, 403, -32003, "Session belongs to a different user");
      return "denied";
    }
    return session;
  };

  app.post(
    MCP_PATH,
    mcpCors,
    requireAuth,
    express.json({ limit: MAX_BODY_BYTES }),
    // A read-only service key calling a tool outside search_/get_/read_ stops here (403).
    enforceServiceKeyScope,
    async (req: Request, res: Response) => {
      const email = emailFromAuthInfo(req.auth);
      logToolCalls(email, req.body);

      const session = resolveSession(req, res);
      if (session === "denied") return;

      if (session) {
        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      const sessionId = req.headers["mcp-session-id"];
      if (!isInitializeRequest(req.body)) {
        // A supplied-but-unknown session id must answer 404, not 400: that is the
        // signal a client uses to drop its session and re-initialize. Sessions are
        // held in memory, so every one of them is unknown after a restart or
        // redeploy — answering 400 there would strand connected clients.
        if (typeof sessionId === "string" && sessionId !== "") {
          sendJsonRpcError(res, 404, -32001, "Unknown or expired session");
          return;
        }
        sendJsonRpcError(
          res,
          400,
          -32000,
          "Bad Request: no valid session id, and this is not an initialize request"
        );
        return;
      }

      // New session: one transport and one McpServer per session, because an
      // McpServer can only ever be bound to a single transport.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, email });
          console.log(
            `[qbo-mcp] Session opened: ${id} for ${email} (${sessions.size} active)`
          );
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
          console.log(`[qbo-mcp] Session closed: ${id} (${sessions.size} active)`);
        },
      });

      // Covers transport teardown that does not come from a DELETE, so a
      // dropped connection cannot leak the session entry.
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id && sessions.delete(id)) {
          console.log(`[qbo-mcp] Session dropped: ${id} (${sessions.size} active)`);
        }
      };

      const mcpServer = QuickbooksMCPServer.NewServer();
      registerAllTools(mcpServer);
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    }
  );

  // GET (SSE stream) and DELETE (termination) only ever act on a live session.
  const handleSessionOnly = async (req: Request, res: Response): Promise<void> => {
    const session = resolveSession(req, res);
    if (session === "denied") return;
    if (!session) {
      sendJsonRpcError(res, 404, -32001, "Unknown or expired session");
      return;
    }
    await session.transport.handleRequest(req, res);
  };

  app.get(MCP_PATH, mcpCors, requireAuth, handleSessionOnly);
  app.delete(MCP_PATH, mcpCors, requireAuth, handleSessionOnly);

  app.use((req: Request, res: Response) => {
    sendJsonRpcError(res, 404, -32601, `Not found: ${req.path}`);
  });

  const httpServer = app.listen(PORT, HOST, () => {
    console.log(`[qbo-mcp] Public URL:      ${config.publicUrl.href}`);
    console.log(`[qbo-mcp] MCP endpoint:    ${config.resourceUrl.href}  (Bearer token required)`);
    console.log(`[qbo-mcp] Health check:    ${new URL(HEALTH_PATH, config.publicUrl).href}`);
    console.log(`[qbo-mcp] AS metadata:     ${new URL("/.well-known/oauth-authorization-server", config.publicUrl).href}`);
    console.log(`[qbo-mcp] RS metadata:     ${resourceMetadataUrl}`);
    console.log(`[qbo-mcp] Google callback: ${config.googleRedirectUri}`);
    console.log(`[qbo-mcp] Allow-list:      ${config.allowedEmails.size} address(es)`);
    console.log(`[qbo-mcp] Service keys:    ${describeServiceKeys(serviceKeys)}`);

    // Warm-up: authenticate now, so the first tool call does not pay for the token refresh and
    // a dead QuickBooks token shows in the deploy log. A failure is logged, never fatal.
    void QuickbooksClient.getInstance()
      .then(() => console.log("[qbo-mcp] Warm-up: QBO client ready"))
      .catch((error) => console.error(`[qbo-mcp] Warm-up failed: ${formatError(error)}`));
  });

  const shutdown = makeShutdown({
    httpServer,
    sessions,
    waitForRefresh: () => QuickbooksClient.waitForRefresh(),
  });
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
};

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
