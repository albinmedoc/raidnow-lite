import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AutoJoinWorker } from './core/autojoin-worker.js';
import { normalizeSearchSelection } from './core/search-selection.js';
import { normalizeProfile, validateProfile } from './core/validation.js';
import { buildRaidBossCatalog, enrichRaids, groupRaidBosses } from './core/raid-catalog.js';
import { canonicalizePushSubscription, MAX_PUSH_SUBSCRIPTIONS, pushSubscriptionId } from './core/web-push.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const DEFAULT_MAX_BODY_BYTES = 1_000_000;
const DEFAULT_MUTATION_LIMIT = 30;
const DEFAULT_MUTATION_WINDOW_MS = 60_000;
const DEFAULT_SSE_HEARTBEAT_MS = 15_000;
const MUTATION_ROUTES = new Set([
  'POST /api/login', 'POST /api/session/import', 'PUT /api/profile',
  'POST /api/autojoin/start', 'POST /api/autojoin/stop',
  'POST /api/active-raid/leave', 'POST /api/session/reset',
  'POST /api/push/subscriptions', 'DELETE /api/push/subscriptions'
]);
const STATEFUL_API_METHODS = new Map([
  ['/api/profile', new Set(['GET', 'PUT'])],
  ['/api/login', new Set(['POST'])],
  ['/api/session/import', new Set(['POST'])],
  ['/api/config', new Set(['GET'])],
  ['/api/raids', new Set(['GET'])],
  ['/api/autojoin/status', new Set(['GET'])],
  ['/api/active-raid', new Set(['GET'])],
  ['/api/autojoin/start', new Set(['POST'])],
  ['/api/autojoin/stop', new Set(['POST'])],
  ['/api/active-raid/leave', new Set(['POST'])],
  ['/api/session/reset', new Set(['POST'])],
  ['/api/push/subscriptions', new Set(['POST', 'DELETE'])],
  ['/api/events', new Set(['GET'])]
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function readJson(request, maxBodyBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBodyBytes) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body.');
  }
}

export function createApp({ adapter, store, sessionManager = null, pushNotifier = null, pollIntervalMs = 15_000, scanIntervalMs = 1_000, publicDir, mode = 'demo', liveWrites = false, logger = console, maxBodyBytes = DEFAULT_MAX_BODY_BYTES, mutationLimit = DEFAULT_MUTATION_LIMIT, mutationWindowMs = DEFAULT_MUTATION_WINDOW_MS, sseHeartbeatMs = DEFAULT_SSE_HEARTBEAT_MS, now = Date.now }) {
  const defaultWorker = sessionManager ? null : new AutoJoinWorker({
    adapter,
    pollIntervalMs,
    scanIntervalMs,
    persist: (snapshot) => store.update({ autoJoin: snapshot })
  });
  const defaultClients = new Set();
  const defaultContext = { adapter, store, worker: defaultWorker, clients: defaultClients, restoreError: null };
  const mutationBuckets = new WeakMap();
  const publicPath = publicDir instanceof URL ? fileURLToPath(publicDir) : publicDir;

  function publish(clients, event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) client.write(payload);
  }

  if (defaultWorker) {
    defaultWorker.on('state', (state) => {
      publish(defaultClients, 'status', state);
    });
    defaultWorker.on('matched', (raid) => publish(defaultClients, 'matched', raid));
    defaultWorker.on('workerError', () => {
      try {
        logger?.error?.('Auto Join worker failed.', { code: 'WORKER_FAILED' });
      } catch {
        // Logging must not turn a contained worker failure into a process failure.
      }
    });
  }

  const pushConfig = pushNotifier?.publicConfig?.() ?? { enabled: false, publicKey: null };
  const ready = sessionManager
    ? sessionManager.ready()
    : defaultWorker.restore(store.get().autoJoin);

  const server = http.createServer(async (request, response) => {
    let context;
    let releaseContext = false;
    try {
      const url = new URL(request.url, 'http://localhost');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
      response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), accelerometer=(), gyroscope=(), magnetometer=()');
      if (url.pathname.startsWith('/api/')) response.setHeader('Cache-Control', 'no-store');
      await ready;

      if (request.method === 'GET' && url.pathname === '/api/health') {
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === 'GET' && url.pathname === '/api/push/config') {
        return sendJson(response, 200, pushConfig);
      }

      if (request.method === 'GET' && !url.pathname.startsWith('/api/')) {
        const requested = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
        const safe = normalize(requested).replace(/^(\.\.[/\\])+/, '');
        const filePath = join(publicPath, safe);
        try {
          const content = await readFile(filePath);
          const headers = { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' };
          if (url.pathname === '/service-worker.js') headers['cache-control'] = 'no-cache';
          response.writeHead(200, headers);
          response.end(content);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          if (extname(url.pathname)) return sendJson(response, 404, { message: 'Not found.' });
          const content = await readFile(join(publicPath, 'index.html'));
          response.writeHead(200, { 'content-type': MIME['.html'] });
          response.end(content);
        }
        return;
      }

      if (!url.pathname.startsWith('/api/')) return sendJson(response, 404, { message: 'Not found.' });
      if (url.pathname === '/api/health') {
        response.setHeader('Allow', 'GET');
        return sendJson(response, 405, { message: 'Method not allowed.' });
      }
      if (url.pathname === '/api/push/config') {
        response.setHeader('Allow', 'GET');
        return sendJson(response, 405, { message: 'Method not allowed.' });
      }
      const allowedMethods = STATEFUL_API_METHODS.get(url.pathname);
      if (!allowedMethods) return sendJson(response, 404, { message: 'Not found.' });
      if (!allowedMethods.has(request.method)) {
        response.setHeader('Allow', [...allowedMethods].join(', '));
        return sendJson(response, 405, { message: 'Method not allowed.' });
      }

      context = sessionManager
        ? await sessionManager.resolve(request, response, { lease: true })
        : defaultContext;
      releaseContext = Boolean(sessionManager);
      const { adapter: activeAdapter, store: activeStore, worker, clients, restoreError } = context;
      const restoreLocked = Boolean(restoreError);
      const restoreFailure = { state: 'error', error: 'Auto Join restore failed; saved work remains locked for retry.' };
      if (MUTATION_ROUTES.has(`${request.method} ${url.pathname}`)) {
        const timestamp = now();
        const bucket = mutationBuckets.get(context) ?? [];
        while (bucket.length && bucket[0] <= timestamp - mutationWindowMs) bucket.shift();
        if (bucket.length >= mutationLimit) return sendJson(response, 429, { message: 'Too many session mutations.' });
        bucket.push(timestamp);
        mutationBuckets.set(context, bucket);
      }

      if (request.method === 'GET' && url.pathname === '/api/profile') {
        const profile = activeStore.get().profile ?? {};
        if (sessionManager && Object.keys(profile).length) await activeStore.update({ profile: {} });
        return sendJson(response, 200, profile);
      }
      if (request.method === 'POST' && url.pathname === '/api/login') {
        if (restoreLocked) return sendJson(response, 409, { message: restoreFailure.error });
        const credentials = await readJson(request, maxBodyBytes);
        if (!credentials.email || !credentials.password) return sendJson(response, 400, { message: 'Email and password are required.' });
        if (!activeAdapter.login) return sendJson(response, 400, { message: 'Login is unavailable in this mode.' });
        const result = await activeAdapter.login({ email: credentials.email, password: credentials.password });
        if (result?.status !== 'success' || !result.token) return sendJson(response, 401, { message: result?.text || 'Raid NOW login failed.' });
        const current = activeStore.get().profile ?? {};
        const profile = normalizeProfile({
          trainerName: result.rplu_tid || current.trainerName,
          trainerCode: result.rplu_code || current.trainerCode,
          level: result.rplu_level || current.level,
          countryCode: result.rplu_country_code || current.countryCode || 'world'
        });
        await activeStore.update(sessionManager
          ? { account: { token: result.token, email: credentials.email } }
          : { profile, account: { token: result.token, email: credentials.email } });
        return sendJson(response, 200, { profile });
      }
      if (request.method === 'POST' && url.pathname === '/api/session/import') {
        if (restoreLocked) return sendJson(response, 409, { message: restoreFailure.error });
        const input = await readJson(request, maxBodyBytes);
        const token = String(input.token || '').trim();
        if (!token) return sendJson(response, 400, { message: 'A Raid NOW session token is required.' });
        if (!activeAdapter.setToken) return sendJson(response, 400, { message: 'Session import is unavailable in this mode.' });
        activeAdapter.setToken(token);
        await activeStore.update({ account: { token, type: 'anonymous' } });
        return sendJson(response, 200, { connected: true });
      }
      if (request.method === 'GET' && url.pathname === '/api/config') {
        return sendJson(response, 200, { mode, liveWrites, pollIntervalMs, loggedIn: activeAdapter.hasToken ? activeAdapter.hasToken() : true });
      }
      if (request.method === 'PUT' && url.pathname === '/api/profile') {
        if (restoreLocked) return sendJson(response, 409, { message: restoreFailure.error });
        const profile = normalizeProfile(await readJson(request, maxBodyBytes));
        const errors = validateProfile(profile);
        if (Object.keys(errors).length) return sendJson(response, 400, { errors });
        if (activeAdapter.updateProfile) await activeAdapter.updateProfile(profile);
        if (!sessionManager) await activeStore.update({ profile });
        return sendJson(response, 200, profile);
      }
      if (request.method === 'GET' && url.pathname === '/api/raids') {
        if (activeAdapter.listCurrentRaidBosses) {
          let bosses = buildRaidBossCatalog(await activeAdapter.listCurrentRaidBosses());
          const rank = String(url.searchParams.get('rank') || '0');
          if (rank !== '0') bosses = bosses.filter((boss) => boss.rank === rank);
          return sendJson(response, 200, { raids: [], bosses, fetchedAt: new Date().toISOString() });
        }
        const raids = enrichRaids(await activeAdapter.listRaids({
          page: Number(url.searchParams.get('page') || 1),
          rank: url.searchParams.get('rank') || 0
        }));
        return sendJson(response, 200, { raids, bosses: groupRaidBosses(raids), fetchedAt: new Date().toISOString() });
      }
      if (request.method === 'GET' && url.pathname === '/api/autojoin/status') {
        return sendJson(response, 200, restoreLocked ? restoreFailure : worker.status());
      }
      if (request.method === 'GET' && url.pathname === '/api/active-raid') {
        const status = worker.status();
        if (status.state !== 'matched' || !status.raid?.rpl_id) return sendJson(response, 404, { message: 'There is no active raid.' });
        if (!activeAdapter.listRaidPlayers) return sendJson(response, 501, { message: 'Player details are unavailable in this mode.' });
        const details = await activeAdapter.listRaidPlayers(status.raid.rpl_id);
        return sendJson(response, 200, { raid: enrichRaids([status.raid])[0], ...details, fetchedAt: new Date().toISOString() });
      }
      if (request.method === 'POST' && url.pathname === '/api/autojoin/start') {
        if (restoreLocked) return sendJson(response, 409, { message: restoreFailure.error });
        if (!['idle', 'stopped', 'error'].includes(worker.status().state)) return sendJson(response, 409, { message: 'An Auto Join search is already active.' });
        const input = await readJson(request, maxBodyBytes);
        const profile = sessionManager
          ? normalizeProfile(input.profile ?? {})
          : activeStore.get().profile ?? {};
        const errors = validateProfile(profile);
        if (Object.keys(errors).length) return sendJson(response, 400, { message: 'Complete your profile first.', errors });
        const selection = normalizeSearchSelection(input);
        const status = await worker.start({ profile, selection });
        return sendJson(response, 200, status);
      }
      if (request.method === 'POST' && url.pathname === '/api/autojoin/stop') {
        if (restoreLocked) return sendJson(response, 409, { message: restoreFailure.error });
        return sendJson(response, 200, await worker.stop());
      }
      if (request.method === 'POST' && url.pathname === '/api/active-raid/leave') {
        if (restoreLocked) return sendJson(response, 409, { message: restoreFailure.error });
        const status = worker.status();
        if (status.state !== 'matched' || !status.raid?.rpl_id) return sendJson(response, 404, { message: 'There is no active raid to leave.' });
        if (!activeAdapter.leaveRaid) return sendJson(response, 501, { message: 'Leaving raids is unavailable in this mode.' });
        return sendJson(response, 200, await worker.leaveRaid());
      }
      if (request.method === 'POST' && url.pathname === '/api/session/reset') {
        if (!sessionManager) return sendJson(response, 400, { message: 'Session reset is unavailable in this mode.' });
        sessionManager.release(context);
        releaseContext = false;
        await sessionManager.reset(request, response, context);
        return sendJson(response, 200, { reset: true });
      }
      if (url.pathname === '/api/push/subscriptions') {
        if (!pushConfig.enabled || !pushNotifier?.enabled) return sendJson(response, 503, { message: 'Push notifications are not configured.' });
        if (request.method === 'POST') {
          let subscription;
          try {
            const input = await readJson(request, Math.min(maxBodyBytes, 16_384));
            subscription = pushNotifier?.canonicalizeSubscription
              ? pushNotifier.canonicalizeSubscription(input)
              : canonicalizePushSubscription(input);
          } catch (error) {
            if (error instanceof HttpError) throw error;
            return sendJson(response, 400, { message: error.message });
          }
          if (sessionManager?.addPushSubscription) {
            try {
              const result = await sessionManager.addPushSubscription(context, subscription);
              return sendJson(response, result.created ? 201 : 200, { subscribed: true, id: result.id });
            } catch (error) {
              if (error.code === 'PUSH_SUBSCRIPTION_CAPACITY') return sendJson(response, 409, { message: error.message });
              throw error;
            }
          }
          const current = activeStore.get().pushSubscriptions ?? [];
          const id = pushSubscriptionId(subscription.endpoint);
          const index = current.findIndex((entry) => entry.id === id);
          if (index === -1 && current.length >= MAX_PUSH_SUBSCRIPTIONS) return sendJson(response, 409, { message: 'Too many push subscriptions for this session.' });
          const next = current.slice();
          const record = { id, ...subscription };
          if (index === -1) next.push(record);
          else next[index] = record;
          await activeStore.update({ pushSubscriptions: next });
          return sendJson(response, index === -1 ? 201 : 200, { subscribed: true, id });
        }
        const input = await readJson(request, Math.min(maxBodyBytes, 4_096));
        const id = typeof input.id === 'string' && /^[a-f0-9]{32}$/.test(input.id)
          ? input.id
          : (typeof input.endpoint === 'string' ? pushSubscriptionId(input.endpoint) : null);
        if (!id) return sendJson(response, 400, { message: 'A valid subscription id or endpoint is required.' });
        if (sessionManager?.removePushSubscription) {
          try {
            return sendJson(response, 200, await sessionManager.removePushSubscription(context, id));
          } catch (error) {
            if (error.code === 'PUSH_SUBSCRIPTION_NOT_FOUND') return sendJson(response, 404, { message: error.message });
            throw error;
          }
        }
        const current = activeStore.get().pushSubscriptions ?? [];
        const next = current.filter((entry) => entry.id !== id);
        if (next.length === current.length) return sendJson(response, 404, { message: 'Push subscription not found.' });
        await activeStore.update({ pushSubscriptions: next });
        return sendJson(response, 200, { removed: true });
      }
      if (request.method === 'GET' && url.pathname === '/api/events') {
        let release;
        try {
          release = sessionManager && typeof sessionManager.addSseClient === 'function'
            ? sessionManager.addSseClient(context, response)
            : (() => {
                if (clients.size >= 3) throw new HttpError(429, 'Too many open event streams.');
                clients.add(response);
                return () => clients.delete(response);
              })();
        } catch (error) {
          if (error.code === 'SESSION_RATE_LIMIT') throw new HttpError(429, error.message);
          throw error;
        }
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive'
        });
        let heartbeat;
        const close = () => {
          clearInterval(heartbeat);
          release();
        };
        try {
          response.write(`event: status\ndata: ${JSON.stringify(restoreLocked ? restoreFailure : worker.status())}\n\n`);
        } catch {
          close();
          return;
        }
        heartbeat = setInterval(() => {
          try {
            response.write(': heartbeat\n\n');
          } catch {
            close();
          }
        }, sseHeartbeatMs);
        heartbeat.unref?.();
        request.once('close', close);
        response.once('error', close);
        return;
      }

      return sendJson(response, 404, { message: 'Not found.' });
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status = error.status || ({ SESSION_CAPACITY: 503, SESSION_CONFLICT: 409, SESSION_RATE_LIMIT: 429 }[error.code]) || 500;
      if (status === 500) {
        try { logger?.error?.('Unexpected request failure.', { code: 'INTERNAL_ERROR' }); } catch {}
        sendJson(response, 500, { message: 'Ett internt fel uppstod.' });
      } else {
        sendJson(response, status, { message: error.message || String(error) });
      }
    } finally {
      if (releaseContext) sessionManager.release?.(context);
    }
  });

  return { server, worker: sessionManager || defaultWorker, ready };
}
