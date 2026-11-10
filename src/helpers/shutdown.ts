/** What shutdown needs from a live MCP session. */
interface ClosableSession {
  transport: { close(): Promise<void> };
}

export interface ShutdownOptions {
  /** The HTTP server; close() stops new connections and calls back once open ones end. */
  httpServer: { close(callback: (err?: Error) => void): unknown };
  /** Live MCP sessions, each closed so its open stream ends. */
  sessions: Map<string, ClosableSession>;
  /** Resolves once any in-flight QBO token refresh has settled, so a rotated token is persisted. */
  waitForRefresh: () => Promise<void>;
  exit?: (code: number) => void;
  log?: (message: string) => void;
  /** How long shutdown may take before the process is forced to exit 1. */
  graceMs?: number;
}

/**
 * Builds the SIGTERM/SIGINT handler: close every session, wait for an in-flight token refresh,
 * then close the server and exit 0. A timer forces exit 1 if any of that takes longer than
 * graceMs. It is unref'd, so it never by itself keeps the process alive. A second signal is a
 * no-op.
 */
export function makeShutdown({
  httpServer,
  sessions,
  waitForRefresh,
  exit = process.exit,
  log = console.log,
  graceMs = 10_000,
}: ShutdownOptions): (signal: string) => Promise<void> {
  let started = false;

  return async (signal: string): Promise<void> => {
    if (started) return;
    started = true;

    log(`[qbo-mcp] ${signal} received, shutting down.`);
    for (const session of sessions.values()) {
      void session.transport.close();
    }

    const forceExit = setTimeout(() => {
      log(`[qbo-mcp] Shutdown did not finish within ${graceMs} ms; forcing exit.`);
      exit(1);
    }, graceMs);
    forceExit.unref();

    await waitForRefresh();
    httpServer.close(() => {
      clearTimeout(forceExit);
      exit(0);
    });
  };
}
