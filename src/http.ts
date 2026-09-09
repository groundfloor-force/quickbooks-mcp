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
import { startExpirySweep } from "./auth/store.js";
import { emailFromAuthInfo } from "./auth/tokens.js";

const MCP_PATH = "/mcp";
const HEALTH_PATH = "/health";

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

/**
 * Warn loudly when rotated refresh tokens are being written somewhere that does
 * not survive a redeploy. QUICKBOOKS_TOKEN_STORE_PATH is read by the client at
 * import time; /tmp is writable in the container but is NOT persistent.
 */
const logTokenStoreWarning = (): void => {
  const tokenStorePath = process.env.QUICKBOOKS_TOKEN_STORE_PATH?.trim();

  if (!tokenStorePath) {
    console.warn(
      "[qbo-mcp] WARNING: QUICKBOOKS_TOKEN_STORE_PATH is not set. Rotated refresh " +
        "tokens will be written next to the installed module, which is typically " +
        "read-only or ephemeral in a container. Set it to a writable path."
    );
    return;
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

  logTokenStoreWarning();

  // Imported dynamically so the warnings above are emitted BEFORE the QuickBooks
  // client module is evaluated — that module validates credentials at import
  // time and throws when they are missing, and a bare stack trace with no
  // preceding context is painful to diagnose from deploy logs.
  let registerAllTools: (
    server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer
  ) => void;
  try {
    ({ registerAllTools } = await import("./register-all-tools.js"));
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

  const requireAuth = requireBearerAuth({ verifier: provider, resourceMetadataUrl });

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
    console.warn(
      "[qbo-mcp] NOTE: clients, authorization codes and refresh tokens are held in " +
        "memory — a redeploy clears them and users simply sign in with Google again."
    );
  });

  const shutdown = (signal: string) => {
    console.log(`[qbo-mcp] ${signal} received, shutting down.`);
    httpServer.close(() => process.exit(0));
    for (const session of sessions.values()) {
      void session.transport.close();
    }
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
};

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
