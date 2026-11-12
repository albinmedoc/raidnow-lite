function closeServer(server) {
  return new Promise((resolve, reject) => {
    try {
      server.close((error) => error ? reject(error) : resolve());
    } catch (error) {
      reject(error);
    }
  });
}

export function installGracefulShutdown({
  shutdown,
  server,
  signals = ['SIGINT', 'SIGTERM'],
  timeoutMs = 10_000,
  processRef = process,
  logger = console,
  clock = globalThis
}) {
  let running = null;
  const handlers = new Map();

  const run = () => {
    if (running) return running;
    running = (async () => {
      const forceExit = clock.setTimeout(() => processRef.exit(1), timeoutMs);
      forceExit.unref?.();
      let failed = false;
      let closed = false;
      try {
        await shutdown();
      } catch {
        failed = true;
        processRef.exitCode = 1;
        try { logger?.error?.('Graceful shutdown failed.', { code: 'SHUTDOWN_FAILED' }); } catch {}
      } finally {
        try {
          await closeServer(server);
          closed = true;
        } catch {
          failed = true;
          processRef.exitCode = 1;
          try { logger?.error?.('Graceful shutdown failed.', { code: 'SHUTDOWN_FAILED' }); } catch {}
        }
        if (closed && !failed) clock.clearTimeout(forceExit);
        processRef.exitCode = failed ? 1 : 0;
      }
    })();
    return running;
  };

  for (const signal of signals) {
    const handler = () => { void run(); };
    handlers.set(signal, handler);
    processRef.on(signal, handler);
  }

  return {
    current: () => running ?? Promise.resolve(),
    shutdown: run,
    dispose() {
      for (const [signal, handler] of handlers) processRef.off(signal, handler);
      handlers.clear();
    }
  };
}
