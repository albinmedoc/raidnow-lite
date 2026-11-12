import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { AutoJoinWorker } from './core/autojoin-worker.js';
import { SessionManager } from './core/session-manager.js';
import { MockRaidNowAdapter } from './adapters/mock-raidnow-adapter.js';
import { RaidNowAdapter } from './adapters/raidnow-adapter.js';
import webPush from 'web-push';
import { createPushNotifier, loadPushConfig } from './core/web-push.js';
import { installGracefulShutdown } from './core/graceful-shutdown.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const mode = process.env.RAIDNOW_MODE === 'live' ? 'live' : 'demo';
const liveWrites = process.env.RAIDNOW_LIVE_WRITES === 'true';
const pollIntervalMs = Number(process.env.RAIDNOW_POLL_INTERVAL_MS || (mode === 'demo' ? 3_000 : 15_000));
// Session resource bounds. Defaults are intentionally conservative for one small instance.
const sessionTtlMs = Number(process.env.RAIDNOW_SESSION_TTL_MS || 30 * 24 * 60 * 60 * 1_000);
const maxSessionContexts = Number(process.env.RAIDNOW_MAX_SESSION_CONTEXTS || 500);
const perSessionSseLimit = Number(process.env.RAIDNOW_SESSION_SSE_LIMIT || 3);
const globalSseLimit = Number(process.env.RAIDNOW_GLOBAL_SSE_LIMIT || 100);
const cookieSecure = process.env.RAIDNOW_COOKIE_SECURE === 'true';
// HTTP request limits are separate from upstream Raid NOW throttling.
const maxBodyBytes = Number(process.env.RAIDNOW_MAX_BODY_BYTES || 1_000_000);
const mutationLimit = Number(process.env.RAIDNOW_MUTATION_LIMIT || 30);
const mutationWindowMs = Number(process.env.RAIDNOW_MUTATION_WINDOW_MS || 60_000);
const sseHeartbeatMs = Number(process.env.RAIDNOW_SSE_HEARTBEAT_MS || 15_000);
const shutdownTimeoutMs = Number(process.env.RAIDNOW_SHUTDOWN_TIMEOUT_MS || 10_000);
const pushConfig = loadPushConfig(process.env);
const pushNotifier = createPushNotifier({ config: pushConfig, webPush });

const sessionManager = new SessionManager({
  rootDir: resolve(root, 'data/sessions'),
  defaults: { profile: {}, account: null, autoJoin: null, pushSubscriptions: [], pushDeliveryJobs: [] },
  ttlMs: sessionTtlMs,
  maxContexts: maxSessionContexts,
  sessionSseLimit: perSessionSseLimit,
  globalSseLimit,
  cookieSecure,
  pushNotifier,
  adapterFactory: ({ token }) => mode === 'live'
    ? new RaidNowAdapter({ allowWrites: liveWrites, token: token || process.env.RAIDNOW_TOKEN || '', csrfToken: process.env.RAIDNOW_CSRF_TOKEN || '' })
    : new MockRaidNowAdapter({ matchAfterPolls: 3 }),
  workerFactory: ({ adapter, runOperation, persist }) => new AutoJoinWorker({
    adapter,
    runOperation,
    pollIntervalMs,
    persist
  })
});

const app = createApp({
  sessionManager,
  pushNotifier,
  pollIntervalMs,
  publicDir: resolve(root, 'public'),
  mode,
  liveWrites,
  maxBodyBytes,
  mutationLimit,
  mutationWindowMs,
  sseHeartbeatMs
});

await app.ready;
app.server.listen(port, host, () => {
  console.log(`Raid NOW Lite listening on http://${host}:${port} (${mode}${liveWrites ? ', live writes enabled' : ''})`);
});

installGracefulShutdown({
  shutdown: () => app.worker.shutdown(),
  server: app.server,
  timeoutMs: shutdownTimeoutMs
});
