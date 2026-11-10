import { jest } from '@jest/globals';
import { makeShutdown } from '../../../src/helpers/shutdown';

type CloseCallback = (err?: Error) => void;

/** Builds a shutdown over fakes: two open sessions, a server whose close() we finish by hand. */
function setup(options: { refresh?: 'pending' | 'settled' } = {}) {
  const transports = [
    { close: jest.fn(async () => undefined) },
    { close: jest.fn(async () => undefined) },
  ];
  const sessions = new Map(
    transports.map((transport, i) => [`session-${i}`, { transport, email: 'user@example.com' }])
  );

  let finishClose: CloseCallback | undefined;
  const httpServer = {
    close: jest.fn((cb: CloseCallback) => {
      finishClose = cb;
    }),
  };

  let settleRefresh: () => void = () => undefined;
  const waitForRefresh = jest.fn(() =>
    options.refresh === 'pending'
      ? new Promise<void>((resolve) => {
          settleRefresh = resolve;
        })
      : Promise.resolve()
  );

  const exit = jest.fn();
  const log = jest.fn();
  const shutdown = makeShutdown({ httpServer, sessions, waitForRefresh, exit, log, graceMs: 5000 });

  return {
    shutdown,
    transports,
    httpServer,
    waitForRefresh,
    exit,
    log,
    finishClose: () => finishClose?.(),
    settleRefresh: () => settleRefresh(),
  };
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('makeShutdown', () => {
  it('logs the signal and closes every session transport', async () => {
    const t = setup();

    await t.shutdown('SIGTERM');

    expect(t.log).toHaveBeenCalledWith('[qbo-mcp] SIGTERM received, shutting down.');
    expect(t.transports[0].close).toHaveBeenCalledTimes(1);
    expect(t.transports[1].close).toHaveBeenCalledTimes(1);
  });

  it('waits for an in-flight token refresh, then closes the server and exits 0', async () => {
    const t = setup({ refresh: 'pending' });

    const done = t.shutdown('SIGTERM');
    await Promise.resolve();
    expect(t.waitForRefresh).toHaveBeenCalledTimes(1);
    expect(t.httpServer.close).not.toHaveBeenCalled(); // still waiting on the refresh

    t.settleRefresh();
    await done;
    expect(t.httpServer.close).toHaveBeenCalledTimes(1);
    expect(t.exit).not.toHaveBeenCalled(); // close() has not finished yet

    t.finishClose();
    expect(t.exit).toHaveBeenCalledTimes(1);
    expect(t.exit).toHaveBeenCalledWith(0);

    // The force-exit timer was cleared: running past the grace period exits nothing more.
    jest.advanceTimersByTime(10_000);
    expect(t.exit).toHaveBeenCalledTimes(1);
  });

  it('forces exit 1 when the server never finishes closing', async () => {
    const t = setup();

    await t.shutdown('SIGTERM');
    expect(t.httpServer.close).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(4999);
    expect(t.exit).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(t.exit).toHaveBeenCalledTimes(1);
    expect(t.exit).toHaveBeenCalledWith(1);
    expect(t.log).toHaveBeenCalledWith('[qbo-mcp] Shutdown did not finish within 5000 ms; forcing exit.');
  });

  it('forces exit 1 when the token refresh never settles', async () => {
    const t = setup({ refresh: 'pending' });

    void t.shutdown('SIGTERM');
    await Promise.resolve();

    jest.advanceTimersByTime(5000);
    expect(t.exit).toHaveBeenCalledWith(1);
    expect(t.httpServer.close).not.toHaveBeenCalled();
  });

  it('treats a second signal as a no-op', async () => {
    const t = setup();

    await t.shutdown('SIGTERM');
    await t.shutdown('SIGINT');

    expect(t.log).toHaveBeenCalledTimes(1);
    expect(t.transports[0].close).toHaveBeenCalledTimes(1);
    expect(t.waitForRefresh).toHaveBeenCalledTimes(1);
    expect(t.httpServer.close).toHaveBeenCalledTimes(1);
  });

  it('defaults to console.log, process.exit and a 10 s grace period', async () => {
    const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const processExit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const httpServer = { close: jest.fn() }; // never calls back
    const shutdown = makeShutdown({ httpServer, sessions: new Map(), waitForRefresh: async () => undefined });

    await shutdown('SIGINT');
    expect(consoleLog).toHaveBeenCalledWith('[qbo-mcp] SIGINT received, shutting down.');

    jest.advanceTimersByTime(9999);
    expect(processExit).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(processExit).toHaveBeenCalledWith(1);
  });
});
