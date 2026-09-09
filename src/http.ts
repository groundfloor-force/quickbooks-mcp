#!/usr/bin/env node

/**
 * Remote (Streamable HTTP) entry point.
 *
 * Serves the same QuickBooks MCP server as the stdio entry point (src/index.ts)
 * over HTTP, so it can be hosted behind HTTPS and added as a custom connector.
 * Tool definitions are NOT duplicated here — both entry points register the
 * identical list via ./register-all-tools.js.
 *
 * Routes:
 *   GET  /health  -> 200 "ok"
 *   POST /mcp     -> client-to-server JSON-RPC (initialize starts a session)
 *   GET  /mcp     -> server-to-client SSE stream for an existing session
 *   DELETE /mcp   -> explicit session termination
 *
 * NOTE: there is deliberately NO authentication in front of /mcp yet. Anyone
 * who can reach this URL can drive the QuickBooks tools. Auth is the next task.
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { QuickbooksMCPServer } from "./server/qbo-mcp-server.js";

const MCP_PATH = "/mcp";
const HEALTH_PATH = "/health";

// Railway injects PORT; fall back to 3000 for local runs.
const PORT = Number.parseInt(process.env.PORT ?? "", 10) || 3000;
// Bind all interfaces — a container-local bind would be unreachable from the edge.
const HOST = "0.0.0.0";

// Cap request bodies so a malformed or hostile client cannot exhaust memory.
const MAX_BODY_BYTES =
  Number.parseInt(process.env.MCP_MAX_BODY_BYTES ?? "", 10) || 10 * 1024 * 1024;

/** Live sessions, keyed by the session id the transport generates. */
const transports = new Map<string, StreamableHTTPServerTransport>();

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

/** Reads and JSON-parses a request body, enforcing MAX_BODY_BYTES. */
const readJsonBody = (req: http.IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(
          Object.assign(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`), {
            statusCode: 413,
          })
        );
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(
          Object.assign(new Error("Request body is not valid JSON"), { statusCode: 400 })
        );
      }
    });
  });

/** Sends a JSON-RPC error that is well-formed even before a session exists. */
const sendJsonRpcError = (
  res: http.ServerResponse,
  statusCode: number,
  code: number,
  message: string
): void => {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
};

const main = async (): Promise<void> => {
  logTokenStoreWarning();

  // Imported dynamically so the warning above is emitted BEFORE the QuickBooks
  // client module is evaluated — that module validates credentials at import
  // time and throws when they are missing, and a bare stack trace with no
  // preceding context is painful to diagnose from deploy logs.
  let registerAllTools: (server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer) => void;
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

  const httpServer = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (url.pathname === HEALTH_PATH) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405, { allow: "GET, HEAD" }).end();
          return;
        }
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end("ok");
        return;
      }

      if (url.pathname !== MCP_PATH) {
        sendJsonRpcError(res, 404, -32601, `Not found: ${url.pathname}`);
        return;
      }

      const sessionId = req.headers["mcp-session-id"];
      const existing =
        typeof sessionId === "string" ? transports.get(sessionId) : undefined;

      // GET (SSE stream) and DELETE (termination) only ever act on a live session.
      if (req.method === "GET" || req.method === "DELETE") {
        if (!existing) {
          sendJsonRpcError(res, 404, -32001, "Unknown or expired session");
          return;
        }
        await existing.handleRequest(req, res);
        return;
      }

      if (req.method !== "POST") {
        res.writeHead(405, { allow: "GET, POST, DELETE" }).end();
        return;
      }

      // The body must be parsed here to tell an initialize request apart from a
      // call on an existing session, so it is handed to the transport directly
      // (the stream has already been consumed).
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode ?? 400;
        sendJsonRpcError(res, statusCode, -32700, (error as Error).message);
        return;
      }

      if (existing) {
        await existing.handleRequest(req, res, body);
        return;
      }

      if (!isInitializeRequest(body)) {
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
          transports.set(id, transport);
          console.log(`[qbo-mcp] Session opened: ${id} (${transports.size} active)`);
        },
        onsessionclosed: (id) => {
          transports.delete(id);
          console.log(`[qbo-mcp] Session closed: ${id} (${transports.size} active)`);
        },
      });

      // Covers transport teardown that does not come from a DELETE, so a
      // dropped connection cannot leak the session entry.
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id && transports.delete(id)) {
          console.log(`[qbo-mcp] Session dropped: ${id} (${transports.size} active)`);
        }
      };

      const mcpServer = QuickbooksMCPServer.NewServer();
      registerAllTools(mcpServer);
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch((error) => {
      console.error("[qbo-mcp] Request failed:", error);
      sendJsonRpcError(res, 500, -32603, "Internal server error");
    });
  });

  httpServer.listen(PORT, HOST, () => {
    console.log(`[qbo-mcp] MCP Streamable HTTP endpoint: http://${HOST}:${PORT}${MCP_PATH}`);
    console.log(`[qbo-mcp] Health check: http://${HOST}:${PORT}${HEALTH_PATH}`);
    console.warn("[qbo-mcp] WARNING: /mcp is UNAUTHENTICATED — do not expose it publicly with live credentials.");
  });

  const shutdown = (signal: string) => {
    console.log(`[qbo-mcp] ${signal} received, shutting down.`);
    httpServer.close(() => process.exit(0));
    for (const transport of transports.values()) {
      void transport.close();
    }
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
};

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
