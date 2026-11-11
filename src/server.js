import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { AutoJoinWorker } from './core/autojoin-worker.js';
import { JsonStore } from './core/json-store.js';
import { SessionManager } from './core/session-manager.js';
import { MockRaidNowAdapter } from './adapters/mock-raidnow-adapter.js';
import { RaidNowAdapter } from './adapters/raidnow-adapter.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const mode = process.env.RAIDNOW_MODE === 'live' ? 'live' : 'demo';
const liveWrites = process.env.RAIDNOW_LIVE_WRITES === 'true';
const pollIntervalMs = Number(process.env.RAIDNOW_POLL_INTERVAL_MS || (mode === 'demo' ? 3_000 : 15_000));

const store = await JsonStore.open(resolve(root, 'data/state.json'), {
  profile: {}, preferences: {}, autoJoin: null, account: null
});

const sessionManager = new SessionManager({
  rootDir: resolve(root, 'data/sessions'),
  defaults: { profile: {}, account: null, autoJoin: null },
  adapterFactory: ({ token }) => mode === 'live'
    ? new RaidNowAdapter({ allowWrites: liveWrites, token: token || process.env.RAIDNOW_TOKEN || '', csrfToken: process.env.RAIDNOW_CSRF_TOKEN || '' })
    : new MockRaidNowAdapter({ matchAfterPolls: 3 }),
  workerFactory: ({ adapter }) => new AutoJoinWorker({ adapter, pollIntervalMs })
});

const app = createApp({
  sessionManager,
  pollIntervalMs,
  publicDir: resolve(root, 'public'),
  mode,
  liveWrites
});

app.server.listen(port, host, () => {
  console.log(`Raid NOW Lite listening on http://${host}:${port} (${mode}${liveWrites ? ', live writes enabled' : ''})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    app.worker.shutdown();
    const forceExit = setTimeout(() => process.exit(0), 2_000);
    forceExit.unref();
    app.server.close(() => process.exit(0));
  });
}
