import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonStore } from './json-store.js';
import { MAX_PUSH_SUBSCRIPTIONS, pushSubscriptionId, raidNotificationMarker } from './web-push.js';

const COOKIE_NAME = 'raidnow_session';
const ACTIVE_STATES = new Set(['starting', 'searching', 'retrying', 'joining', 'stopping', 'reconciling', 'matched', 'unknown']);
const LEGACY_RECOVERABLE_STATES = new Set(['starting', 'searching', 'retrying']);
const SESSION_FILE = /^[a-f0-9]{64}\.json$/;
const ATOMIC_TEMP_FILE = /^[a-f0-9]{64}\.json\.\d+\.tmp$/;
const DEFAULT_STALE_TEMP_MS = 60 * 60 * 1_000;
const DEFAULT_PUSH_RETRY_BASE_MS = 30_000;
const DEFAULT_PUSH_RETRY_MAX_MS = 60 * 60 * 1_000;
const DEFAULT_PUSH_SHUTDOWN_WAIT_MS = 2_000;
const MAX_COMPLETED_PUSH_JOBS = 64;
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const DEFAULT_MAX_LOADED_CONTEXTS = 500;
export const DEFAULT_SESSION_SSE_LIMIT = 3;
export const DEFAULT_GLOBAL_SSE_LIMIT = 100;

export class SessionCapacityError extends Error {
  constructor() {
    super('Session capacity is exhausted.');
    this.code = 'SESSION_CAPACITY';
  }
}

export class SessionConflictError extends Error {
  constructor() {
    super('The session has active or uncertain work and cannot be reset.');
    this.code = 'SESSION_CONFLICT';
  }
}

export class SessionRateLimitError extends Error {
  constructor(message = 'Too many open event streams.') {
    super(message);
    this.code = 'SESSION_RATE_LIMIT';
  }
}

function hasDurableObligation(saved) {
  if (!saved) return false;
  if (saved.schemaVersion === 2) {
    return saved.intent === 'search' ||
      (Boolean(saved.queue?.state) && saved.queue.state !== 'none') ||
      (Boolean(saved.raid?.state) && saved.raid.state !== 'none') ||
      Boolean(saved.operation) ||
      Boolean(saved.wake);
  }
  return ACTIVE_STATES.has(saved.state) || Boolean(saved.queueCancelPending) || Boolean(saved.operation) || Boolean(saved.wake) || Boolean(saved.raid);
}

function hasPendingPushDelivery(saved) {
  return (saved?.pushDeliveryJobs ?? []).some((job) => Array.isArray(job.pending) && job.pending.length > 0);
}

function matchedRaid(saved) {
  if (!saved) return null;
  if (saved.schemaVersion === 2) {
    const matched = ['matched', 'leaving'].includes(saved.raid?.state) ||
      (saved.raid?.state === 'unknown' && saved.intent === 'leave');
    return matched ? saved.raid?.value ?? null : null;
  }
  return saved.state === 'matched' ? saved.raid ?? null : null;
}

function cookieValue(header = '', name) {
  for (const part of String(header).split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return '';
}

function validSessionId(value) {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function sessionKey(sessionId) {
  return createHash('sha256').update(sessionId).digest('hex');
}

function abortReason(signal) {
  return signal?.reason ?? new Error('Operation aborted.');
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.floor(number)) : fallback;
}

function createOperationRunner(maxConcurrency) {
  let active = 0;
  const waiting = [];
  const drain = () => {
    while (active < maxConcurrency && waiting.length > 0) {
      const entry = waiting.shift();
      if (entry.signal?.aborted) {
        entry.reject(abortReason(entry.signal));
        continue;
      }
      active += 1;
      if (entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
      entry.resolve();
    }
  };
  const acquire = (signal) => {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (active < maxConcurrency) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const entry = { signal, resolve, reject, onAbort: null };
      if (signal) {
        entry.onAbort = () => {
          const index = waiting.indexOf(entry);
          if (index !== -1) waiting.splice(index, 1);
          reject(abortReason(signal));
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      waiting.push(entry);
    });
  };
  return async (operation, { signal } = {}) => {
    await acquire(signal);
    try {
      if (signal?.aborted) throw abortReason(signal);
      return await operation();
    } finally {
      active -= 1;
      drain();
    }
  };
}

export class SessionManager {
  #rootDir;
  #adapterFactory;
  #workerFactory;
  #contexts = new Map();
  #pendingContexts = new Map();
  #removingContexts = new Map();
  #defaults;
  #initializePromise;
  #runOperation;
  #restoreConcurrency;
  #logger;
  #startupErrors = [];
  #ttlMs;
  #maxContexts;
  #now;
  #cookieSecure;
  #cleanupTimer;
  #admissionQueue = Promise.resolve();
  #sessionSseLimit;
  #globalSseLimit;
  #openSseClients = 0;
  #staleTempMs;
  #pushNotifier;
  #pushRetryBaseMs;
  #pushRetryMaxMs;
  #pushShutdownWaitMs;

  constructor({
    rootDir,
    adapterFactory,
    workerFactory,
    defaults = { account: null, autoJoin: null },
    restoreConcurrency = 4,
    logger = console,
    ttlMs = DEFAULT_SESSION_TTL_MS,
    maxContexts = DEFAULT_MAX_LOADED_CONTEXTS,
    cleanupIntervalMs,
    now = Date.now,
    cookieSecure = false,
    sessionSseLimit = DEFAULT_SESSION_SSE_LIMIT,
    globalSseLimit = DEFAULT_GLOBAL_SSE_LIMIT,
    staleTempMs = DEFAULT_STALE_TEMP_MS,
    pushNotifier = null,
    pushRetryBaseMs = DEFAULT_PUSH_RETRY_BASE_MS,
    pushRetryMaxMs = DEFAULT_PUSH_RETRY_MAX_MS,
    pushShutdownWaitMs = DEFAULT_PUSH_SHUTDOWN_WAIT_MS
  }) {
    this.#rootDir = rootDir;
    this.#adapterFactory = adapterFactory;
    this.#workerFactory = workerFactory;
    this.#defaults = defaults;
    this.#restoreConcurrency = normalizePositiveInteger(restoreConcurrency, 4);
    this.#runOperation = createOperationRunner(this.#restoreConcurrency);
    this.#logger = logger;
    this.#ttlMs = normalizePositiveInteger(ttlMs, DEFAULT_SESSION_TTL_MS);
    this.#maxContexts = normalizePositiveInteger(maxContexts, DEFAULT_MAX_LOADED_CONTEXTS);
    this.#now = now;
    this.#cookieSecure = Boolean(cookieSecure);
    this.#sessionSseLimit = normalizePositiveInteger(sessionSseLimit, DEFAULT_SESSION_SSE_LIMIT);
    this.#globalSseLimit = normalizePositiveInteger(globalSseLimit, DEFAULT_GLOBAL_SSE_LIMIT);
    this.#staleTempMs = normalizePositiveInteger(staleTempMs, DEFAULT_STALE_TEMP_MS);
    this.#pushNotifier = pushNotifier;
    this.#pushRetryBaseMs = normalizePositiveInteger(pushRetryBaseMs, DEFAULT_PUSH_RETRY_BASE_MS);
    this.#pushRetryMaxMs = normalizePositiveInteger(pushRetryMaxMs, DEFAULT_PUSH_RETRY_MAX_MS);
    this.#pushShutdownWaitMs = normalizePositiveInteger(pushShutdownWaitMs, DEFAULT_PUSH_SHUTDOWN_WAIT_MS);
    this.#initializePromise = this.#initialize();
    const interval = normalizePositiveInteger(cleanupIntervalMs, Math.min(this.#ttlMs, 60 * 60 * 1_000));
    this.#cleanupTimer = setInterval(() => this.cleanup().catch(() => {}), interval);
    this.#cleanupTimer.unref?.();
  }

  ready() {
    return this.#initializePromise;
  }

  startupErrors() {
    return structuredClone(this.#startupErrors);
  }

  async resolve(request, response, { lease = false } = {}) {
    await this.#initializePromise;
    let id = cookieValue(request.headers?.cookie, COOKIE_NAME);
    if (!validSessionId(id)) {
      id = randomBytes(32).toString('base64url');
      response.setHeader('Set-Cookie', this.#cookie(id, Math.floor(this.#ttlMs / 1_000)));
    }
    const key = sessionKey(id);
    while (true) {
      await this.#waitForRemoval(key);
      const existing = this.#contexts.get(key) ?? this.#pendingContexts.get(key);
      const context = await (existing ?? this.#admit(key));
      if (this.#contexts.get(key) !== context || context.removing || context.removed) {
        await this.#waitForRemoval(key);
        continue;
      }
      context.lastAccess = this.#now();
      if (lease) context.activeRequests += 1;
      return context;
    }
  }

  release(context) {
    if (!context || context.activeRequests <= 0) return;
    context.activeRequests -= 1;
    context.lastAccess = this.#now();
  }

  async #admit(key) {
    const decision = this.#admissionQueue.then(async () => {
      await this.#waitForRemoval(key);
      const existing = this.#contexts.get(key) ?? this.#pendingContexts.get(key);
      if (existing) return { context: existing };
      await this.cleanup();
      while (this.#contexts.size + this.#pendingContexts.size >= this.#maxContexts) {
        const candidate = [...this.#contexts.values()]
          .filter((context) => !this.#isProtected(context))
          .sort((left, right) => left.lastAccess - right.lastAccess)[0];
        if (!candidate) throw new SessionCapacityError();
        await this.#removeContext(candidate, { deleteFile: true });
      }
      return { context: this.#getOrCreateContext(key) };
    });
    this.#admissionQueue = decision.then(() => {}, () => {});
    return decision.then(({ context }) => context);
  }

  async #waitForRemoval(key) {
    const removal = this.#removingContexts.get(key);
    if (removal) await removal;
  }

  #cookie(value, maxAge) {
    return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${this.#cookieSecure ? '; Secure' : ''}`;
  }

  #getOrCreateContext(key, { startup = false } = {}) {
    if (this.#contexts.has(key)) return this.#contexts.get(key);
    if (this.#pendingContexts.has(key)) return this.#pendingContexts.get(key);
    const pending = this.#createContext(key, { startup }).finally(() => this.#pendingContexts.delete(key));
    this.#pendingContexts.set(key, pending);
    return pending;
  }

  async #createContext(key, { startup = false } = {}) {
    const store = await JsonStore.open(join(this.#rootDir, `${key}.json`), this.#defaults);
    await this.#repairMatchedPush(store);
    const adapter = this.#adapterFactory({ token: store.get().account?.token || '', store, sessionKey: key });
    const persist = (snapshot) => this.#persistWorkerSnapshot(store, snapshot);
    const worker = this.#workerFactory({ adapter, store, sessionKey: key, runOperation: this.#runOperation, persist });
    const context = { sessionKey: key, store, adapter, worker, clients: new Set(), activeRequests: 0, restoreError: null, workerListeners: [], pushQueue: Promise.resolve(), pushRetryTimer: null, pushStopping: false, pushStopped: false, lastAccess: this.#now() };
    if (typeof worker.on === 'function') {
      const onState = (state) => this.publish(context, 'status', state);
      const onMatched = (raid) => {
        this.publish(context, 'matched', raid);
        this.#enqueuePush(context, () => this.#drainPushJobs(context)).catch(() => this.#logPushError());
      };
      const onWorkerError = (error) => this.#logWorkerError(error);
      worker.on('state', onState);
      worker.on('matched', onMatched);
      worker.on('workerError', onWorkerError);
      context.workerListeners.push(['state', onState], ['matched', onMatched], ['workerError', onWorkerError]);
    }
    const saved = store.get().autoJoin;
    try {
      const restored = worker.restore ? await worker.restore(saved) : false;
      if (!restored && LEGACY_RECOVERABLE_STATES.has(saved?.state) && saved?.profile && saved?.selection && worker.recover) {
        await worker.recover({ profile: saved.profile, selection: saved.selection });
      }
      if (store.get().restoreError) await store.update({ restoreError: null });
    } catch (error) {
      if (startup) this.#recordStartupError(`${key}.json`, error);
      const diagnostic = { code: 'RESTORE_FAILED', state: 'locked' };
      context.restoreError = diagnostic;
      await store.update({ restoreError: diagnostic });
      this.publish(context, 'status', { state: 'error', error: 'Auto Join restore failed; saved work remains locked for retry.' });
    }
    this.#contexts.set(key, context);
    if (hasPendingPushDelivery(store.get())) this.#schedulePushRetry(context, 0);
    return context;
  }

  #isProtected(context) {
    if (context.restoreError || context.clients.size > 0 || context.activeRequests > 0) return true;
    if (hasDurableObligation(context.store.get().autoJoin) || hasPendingPushDelivery(context.store.get())) return true;
    let status;
    try {
      status = context.worker.status?.();
    } catch {
      return true;
    }
    return ACTIVE_STATES.has(status?.state) || status?.state === 'unknown';
  }

  async cleanup() {
    await this.#initializePromise;
    const cutoff = this.#now() - this.#ttlMs;
    for (const context of [...this.#contexts.values()]) {
      if (context.lastAccess <= cutoff && !this.#isProtected(context)) await this.#removeContext(context, { deleteFile: true });
    }
    const entries = await readdir(this.#rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !SESSION_FILE.test(entry.name)) continue;
      const key = entry.name.slice(0, -5);
      if (this.#contexts.has(key) || this.#pendingContexts.has(key) || this.#removingContexts.has(key)) continue;
      const path = join(this.#rootDir, entry.name);
      try {
        const info = await stat(path);
        if (info.mtimeMs > cutoff) continue;
        const parsed = JSON.parse(await readFile(path, 'utf8'));
        if (parsed.restoreError || hasDurableObligation(parsed.autoJoin) || hasPendingPushDelivery(parsed)) continue;
        await unlink(path);
      } catch (error) {
        if (error.code !== 'ENOENT') continue;
      }
    }
    await this.#cleanupAtomicTemps(entries);
  }

  async #cleanupAtomicTemps(entries = null) {
    const candidates = entries ?? await readdir(this.#rootDir, { withFileTypes: true });
    const cutoff = this.#now() - this.#staleTempMs;
    for (const entry of candidates) {
      if (!entry.isFile() || !ATOMIC_TEMP_FILE.test(entry.name)) continue;
      const path = join(this.#rootDir, entry.name);
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.mtimeMs > cutoff) continue;
        await unlink(path);
      } catch (error) {
        if (error.code !== 'ENOENT') continue;
      }
    }
  }

  addSseClient(context, response) {
    if (context.clients.size >= this.#sessionSseLimit || this.#openSseClients >= this.#globalSseLimit) throw new SessionRateLimitError();
    context.clients.add(response);
    this.#openSseClients += 1;
    context.lastAccess = this.#now();
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      if (context.clients.delete(response)) this.#openSseClients -= 1;
    };
  }

  publish(context, event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of [...context.clients]) {
      try {
        client.write(payload);
      } catch {
        context.clients.delete(client);
        this.#openSseClients = Math.max(0, this.#openSseClients - 1);
      }
    }
  }

  async reset(request, response, context) {
    const id = cookieValue(request.headers?.cookie, COOKIE_NAME);
    if (!validSessionId(id) || sessionKey(id) !== context.sessionKey || this.#isProtected(context)) throw new SessionConflictError();
    await this.#removeContext(context, { deleteFile: true });
    response.setHeader('Set-Cookie', this.#cookie('', 0));
  }

  #removeContext(context, { deleteFile }) {
    const key = context.sessionKey;
    const existingRemoval = this.#removingContexts.get(key);
    if (existingRemoval) return existingRemoval;
    context.removing = true;
    if (this.#contexts.get(key) === context) this.#contexts.delete(key);
    const removal = Promise.resolve().then(async () => {
      if (typeof context.worker.off === 'function') {
        for (const [event, listener] of context.workerListeners) context.worker.off(event, listener);
      }
      for (const client of context.clients) {
        this.#openSseClients = Math.max(0, this.#openSseClients - 1);
        try { client.end?.(); } catch {}
      }
      context.clients.clear();
      await this.#stopPushContext(context);
      await context.worker.shutdown?.();
      if (deleteFile) {
        try {
          await unlink(join(this.#rootDir, `${key}.json`));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      context.removed = true;
    });
    this.#removingContexts.set(key, removal);
    removal.then(() => {
      if (this.#removingContexts.get(key) === removal) this.#removingContexts.delete(key);
    }, () => {});
    return removal;
  }

  async #initialize() {
    await mkdir(this.#rootDir, { recursive: true, mode: 0o700 });
    await chmod(this.#rootDir, 0o700);
    const entries = await readdir(this.#rootDir, { withFileTypes: true });
    await this.#cleanupAtomicTemps(entries);
    const files = entries.filter((entry) => entry.isFile() && SESSION_FILE.test(entry.name));
    let cursor = 0;
    const restoreNext = async () => {
      while (cursor < files.length) {
        const entry = files[cursor++];
        try {
          const parsed = JSON.parse(await readFile(join(this.#rootDir, entry.name), 'utf8'));
          if (!hasDurableObligation(parsed.autoJoin) && !hasPendingPushDelivery(parsed)) continue;
          await this.#getOrCreateContext(entry.name.slice(0, -5), { startup: true });
        } catch (error) {
          this.#recordStartupError(entry.name, error);
        }
      }
    };
    const concurrency = Math.min(this.#restoreConcurrency, files.length);
    await Promise.all(Array.from({ length: concurrency }, restoreNext));
  }

  #recordStartupError(file, _error) {
    const record = { file, code: 'RESTORE_FAILED' };
    this.#startupErrors.push(record);
    try { this.#logger?.error?.('Session restore skipped.', record); } catch {}
  }


  #enqueuePush(context, operation) {
    const task = context.pushQueue.then(async () => {
      if (context.pushStopped) return;
      return operation();
    });
    context.pushQueue = task.catch(() => {});
    return task;
  }

  #mergeMatchedPushJob(saved, raid) {
    const subscriptions = saved.pushSubscriptions ?? [];
    const marker = raidNotificationMarker(raid);
    if (!marker || !subscriptions.length) return saved.pushDeliveryJobs ?? [];
    const jobs = saved.pushDeliveryJobs ?? [];
    const index = jobs.findIndex((job) => job.marker === marker);
    if (index === -1) {
      return this.#prunePushJobs([...jobs, {
        marker,
        createdAt: new Date(this.#now()).toISOString(),
        pending: subscriptions.map((record) => ({ id: record.id, attempts: 0, nextRetryAt: this.#now() })),
        completed: []
      }]);
    }
    const job = jobs[index];
    const represented = new Set([...(job.pending ?? []).map((entry) => entry.id), ...(job.completed ?? [])]);
    const missing = subscriptions
      .filter((record) => !represented.has(record.id))
      .map((record) => ({ id: record.id, attempts: 0, nextRetryAt: this.#now() }));
    if (!missing.length) return jobs;
    const next = jobs.slice();
    next[index] = { ...job, pending: [...(job.pending ?? []), ...missing] };
    return this.#prunePushJobs(next);
  }

  async #persistWorkerSnapshot(store, snapshot) {
    const saved = store.get();
    const nextRaid = matchedRaid(snapshot);
    const previousMarker = raidNotificationMarker(matchedRaid(saved.autoJoin));
    const nextMarker = raidNotificationMarker(nextRaid);
    const patch = { autoJoin: snapshot };
    if (this.#pushNotifier?.enabled && nextMarker && nextMarker !== previousMarker && (saved.pushSubscriptions ?? []).length > 0) {
      patch.pushDeliveryJobs = this.#mergeMatchedPushJob(saved, nextRaid);
    }
    await store.update(patch);
  }

  async #repairMatchedPush(store) {
    if (!this.#pushNotifier?.enabled) return;
    const saved = store.get();
    const raid = matchedRaid(saved.autoJoin);
    const marker = raidNotificationMarker(raid);
    if (!marker || !(saved.pushSubscriptions ?? []).length || (saved.pushDeliveryJobs ?? []).some((job) => job.marker === marker)) return;
    await store.update({ pushDeliveryJobs: this.#mergeMatchedPushJob(saved, raid) });
  }

  async addPushSubscription(context, subscription) {
    return this.#enqueuePush(context, async () => {
      const current = context.store.get().pushSubscriptions ?? [];
      const id = pushSubscriptionId(subscription.endpoint);
      const index = current.findIndex((entry) => entry.id === id);
      if (index === -1 && current.length >= MAX_PUSH_SUBSCRIPTIONS) {
        const error = new Error('Too many push subscriptions for this session.');
        error.code = 'PUSH_SUBSCRIPTION_CAPACITY';
        throw error;
      }
      const next = current.slice();
      const record = { id, ...subscription };
      if (index === -1) next.push(record);
      else next[index] = record;
      await context.store.update({ pushSubscriptions: next });
      return { created: index === -1, id };
    });
  }

  async removePushSubscription(context, id) {
    return this.#enqueuePush(context, async () => {
      const saved = context.store.get();
      const current = saved.pushSubscriptions ?? [];
      const next = current.filter((entry) => entry.id !== id);
      if (next.length === current.length) {
        const error = new Error('Push subscription not found.');
        error.code = 'PUSH_SUBSCRIPTION_NOT_FOUND';
        throw error;
      }
      const jobs = (saved.pushDeliveryJobs ?? []).map((job) => ({
        ...job,
        pending: (job.pending ?? []).filter((entry) => entry.id !== id)
      }));
      await context.store.update({ pushSubscriptions: next, pushDeliveryJobs: this.#prunePushJobs(jobs) });
      this.#schedulePushRetry(context);
      return { removed: true };
    });
  }

  async #drainPushJobs(context) {
    if (context.pushStopped || !this.#pushNotifier?.enabled) return;
    clearTimeout(context.pushRetryTimer);
    context.pushRetryTimer = null;
    while (!context.pushStopped) {
      const saved = context.store.get();
      const jobs = saved.pushDeliveryJobs ?? [];
      const dueJob = jobs.find((job) => (job.pending ?? []).some((entry) => Number(entry.nextRetryAt) <= this.#now()));
      if (!dueJob) break;
      const pending = dueJob.pending.find((entry) => Number(entry.nextRetryAt) <= this.#now());
      const subscription = (saved.pushSubscriptions ?? []).find((entry) => entry.id === pending.id);
      if (!subscription) {
        await this.#completePushDelivery(context, dueJob.marker, pending.id, false);
        continue;
      }
      const result = await this.#pushNotifier.send({ endpoint: subscription.endpoint, expirationTime: subscription.expirationTime, keys: subscription.keys });
      if (result?.terminal) {
        await this.#completePushDelivery(context, dueJob.marker, pending.id, true);
      } else if (result?.delivered === true) {
        await this.#completePushDelivery(context, dueJob.marker, pending.id, false);
      } else {
        await this.#retryPushDelivery(context, dueJob.marker, pending);
      }
    }
    this.#schedulePushRetry(context);
  }

  async #completePushDelivery(context, marker, id, removeSubscription) {
    const saved = context.store.get();
    const jobs = (saved.pushDeliveryJobs ?? []).map((job) => job.marker !== marker ? job : ({
      ...job,
      pending: (job.pending ?? []).filter((entry) => entry.id !== id),
      completed: [...new Set([...(job.completed ?? []), id])]
    }));
    const patch = { pushDeliveryJobs: this.#prunePushJobs(jobs) };
    if (removeSubscription) patch.pushSubscriptions = (saved.pushSubscriptions ?? []).filter((entry) => entry.id !== id);
    await context.store.update(patch);
  }

  async #retryPushDelivery(context, marker, pending) {
    const attempts = Number(pending.attempts || 0) + 1;
    const delay = Math.min(this.#pushRetryMaxMs, this.#pushRetryBaseMs * (2 ** Math.min(attempts - 1, 16)));
    const jobs = (context.store.get().pushDeliveryJobs ?? []).map((job) => job.marker !== marker ? job : ({
      ...job,
      pending: (job.pending ?? []).map((entry) => entry.id === pending.id ? { ...entry, attempts, nextRetryAt: this.#now() + delay } : entry)
    }));
    await context.store.update({ pushDeliveryJobs: jobs });
  }

  #prunePushJobs(jobs) {
    const pending = jobs.filter((job) => (job.pending ?? []).length > 0);
    const completed = jobs.filter((job) => !(job.pending ?? []).length).slice(-MAX_COMPLETED_PUSH_JOBS);
    return [...pending, ...completed];
  }

  #schedulePushRetry(context, delay = null) {
    clearTimeout(context.pushRetryTimer);
    context.pushRetryTimer = null;
    if (context.pushStopping || context.pushStopped || !this.#pushNotifier?.enabled) return;
    const pending = (context.store.get().pushDeliveryJobs ?? []).flatMap((job) => job.pending ?? []);
    if (!pending.length) return;
    const wait = delay ?? Math.max(0, Math.min(...pending.map((entry) => Number(entry.nextRetryAt))) - this.#now());
    context.pushRetryTimer = setTimeout(() => {
      context.pushRetryTimer = null;
      this.#enqueuePush(context, () => this.#drainPushJobs(context)).catch(() => this.#logPushError());
    }, wait);
    context.pushRetryTimer.unref?.();
  }

  async #stopPushContext(context) {
    context.pushStopping = true;
    clearTimeout(context.pushRetryTimer);
    context.pushRetryTimer = null;
    let timer;
    try {
      await Promise.race([
        context.pushQueue,
        new Promise((resolve) => { timer = setTimeout(resolve, this.#pushShutdownWaitMs); })
      ]);
    } finally {
      clearTimeout(timer);
      context.pushStopped = true;
    }
  }

  #logPushError() {
    try { this.#logger?.error?.('Web Push delivery failed.', { code: 'PUSH_FAILED' }); } catch {}
  }

  #logWorkerError(_error) {
    try { this.#logger?.error?.('Auto Join worker failed.', { code: 'WORKER_FAILED' }); } catch {}
  }

  async shutdown() {
    await this.ready();
    clearInterval(this.#cleanupTimer);
    await Promise.all([...this.#contexts.values()].map((context) => this.#removeContext(context, { deleteFile: false })));
  }
}
