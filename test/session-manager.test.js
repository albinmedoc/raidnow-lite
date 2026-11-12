import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access, chmod, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../src/core/session-manager.js';
import { pushSubscriptionId, raidNotificationMarker } from '../src/core/web-push.js';
import { AutoJoinWorker } from '../src/core/autojoin-worker.js';
import { initialSnapshot } from '../src/core/autojoin-state-machine.js';

function responseStub() {
  const headers = new Map();
  return {
    setHeader(name, value) { headers.set(name.toLowerCase(), value); },
    getHeader(name) { return headers.get(name.toLowerCase()); }
  };
}

function requestStub(cookie = '') {
  return { headers: cookie ? { cookie } : {} };
}

function pushRecord(suffix) {
  const endpoint = `https://fcm.googleapis.com/send/${suffix}`;
  return { id: pushSubscriptionId(endpoint), endpoint, expirationTime: null, keys: { p256dh: 'key', auth: 'auth' } };
}

function matchedSnapshot(id) {
  return {
    ...initialSnapshot(),
    raid: { state: 'matched', target: id, value: { rpl_id: id } },
    terminal: { target: 'matched', error: null }
  };
}

async function waitFor(predicate, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition.');
}

test('issues an HttpOnly session cookie and isolates state and workers per browser', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-sessions-'));
  const adapters = [];
  const workers = [];
  const manager = new SessionManager({
    rootDir: root,
    adapterFactory: ({ token }) => {
      const adapter = { token, setToken(value) { this.token = value; }, hasToken() { return Boolean(this.token); } };
      adapters.push(adapter);
      return adapter;
    },
    workerFactory: ({ adapter }) => {
      const worker = { adapter, status() { return { state: 'idle' }; }, restore() { return false; }, shutdown() {} };
      workers.push(worker);
      return worker;
    }
  });

  try {
    const firstResponse = responseStub();
    const first = await manager.resolve(requestStub(), firstResponse);
    const cookieHeader = firstResponse.getHeader('set-cookie');
    assert.match(cookieHeader, /^raidnow_session=[A-Za-z0-9_-]+;/);
    assert.match(cookieHeader, /HttpOnly/);
    assert.match(cookieHeader, /SameSite=Strict/);
    const cookie = cookieHeader.split(';')[0];

    await first.store.update({ account: { token: 'first-token' } });
    first.adapter.setToken('first-token');

    const repeated = await manager.resolve(requestStub(cookie), responseStub());
    assert.equal(repeated, first);
    assert.equal(repeated.store.get().account.token, 'first-token');

    const secondResponse = responseStub();
    const second = await manager.resolve(requestStub(), secondResponse);
    assert.notEqual(second, first);
    assert.notEqual(secondResponse.getHeader('set-cookie').split(';')[0], cookie);
    assert.equal(second.store.get().account, null);
    assert.notEqual(second.worker, first.worker);

    const files = await readdir(root);
    assert.equal(files.length, 2);
    assert.ok(files.every((name) => /^[a-f0-9]{64}\.json$/.test(name)));
    assert.ok(files.every((name) => !name.includes(cookie.split('=')[1])));
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('does not import legacy single-user state into a browser session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-no-migration-'));
  const legacyStore = {
    get() {
      return {
        account: { token: 'legacy-token' },
        profile: { trainerName: 'LegacyUser', trainerCode: '123456789012', level: 50, countryCode: 'se' },
        autoJoin: { state: 'matched', raid: { rpl_id: 'legacy-raid' } }
      };
    }
  };
  const manager = new SessionManager({
    rootDir: root,
    legacyStore,
    adapterFactory: ({ token }) => ({ token, hasToken() { return Boolean(this.token); } }),
    workerFactory: () => ({ status() { return { state: 'idle' }; }, restore() { return false; }, shutdown() {} })
  });
  try {
    const context = await manager.resolve(requestStub(), responseStub());
    assert.equal(context.store.get().account, null);
    assert.deepEqual(context.store.get().profile ?? {}, {});
    assert.equal(context.store.get().autoJoin, null);
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('creates only one context for concurrent requests from the same browser', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-session-race-'));
  let workersCreated = 0;
  const manager = new SessionManager({
    rootDir: root,
    adapterFactory: () => ({}),
    workerFactory: () => {
      workersCreated += 1;
      return { status() { return { state: 'idle' }; }, restore() { return false; }, shutdown() {} };
    }
  });
  try {
    const cookie = 'raidnow_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const requests = Array.from({ length: 5 }, () => manager.resolve(requestStub(cookie), responseStub()));
    const contexts = await Promise.all(requests);
    assert.equal(workersCreated, 1);
    assert.ok(contexts.every((context) => context === contexts[0]));
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('creates the session directory with owner-only permissions', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'raidnow-session-parent-'));
  const root = join(parent, 'sessions');
  const manager = new SessionManager({
    rootDir: root,
    adapterFactory: () => ({}),
    workerFactory: () => ({ status() { return { state: 'idle' }; }, restore() { return false; }, shutdown() {} })
  });
  try {
    await manager.resolve(requestStub(), responseStub());
    assert.equal((await stat(root)).mode & 0o777, 0o700);
  } finally {
    await manager.shutdown();
    await rm(parent, { recursive: true, force: true });
  }
});

test('passes the session store to the worker and awaits async restore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-session-restore-'));
  let factoryStore;
  let restoreFinished = false;
  const manager = new SessionManager({
    rootDir: root,
    defaults: { autoJoin: { state: 'searching', profile: {}, selection: {} } },
    adapterFactory: () => ({}),
    workerFactory: ({ store }) => {
      factoryStore = store;
      return {
        status() { return { state: 'idle' }; },
        async restore() { await new Promise((resolve) => setImmediate(resolve)); restoreFinished = true; return true; },
        shutdown() {}
      };
    }
  });
  try {
    const context = await manager.resolve(requestStub(), responseStub());
    assert.equal(factoryStore, context.store);
    assert.equal(restoreFinished, true);
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('requests arriving during restore wait for the same initialized context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-session-restore-race-'));
  let releaseRestore;
  let restoreStarted;
  const started = new Promise((resolve) => { restoreStarted = resolve; });
  const manager = new SessionManager({
    rootDir: root,
    defaults: { autoJoin: { state: 'searching' } },
    adapterFactory: () => ({}),
    workerFactory: () => ({
      status() { return { state: 'idle' }; },
      async restore() {
        restoreStarted();
        await new Promise((resolve) => { releaseRestore = resolve; });
        return true;
      },
      shutdown() {}
    })
  });
  try {
    const cookie = 'raidnow_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const first = manager.resolve(requestStub(cookie), responseStub());
    await started;
    let secondResolved = false;
    const second = manager.resolve(requestStub(cookie), responseStub()).then((value) => { secondResolved = true; return value; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(secondResolved, false);
    releaseRestore();
    assert.equal(await second, await first);
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy recovery runs only after restore returns false for a compatible active state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-session-legacy-recover-'));
  const recovered = [];
  const manager = new SessionManager({
    rootDir: root,
    defaults: { autoJoin: { state: 'retrying', profile: { trainerName: 'Legacy' }, selection: { ranks: ['5'] } } },
    adapterFactory: () => ({}),
    workerFactory: () => ({
      status() { return { state: 'idle' }; },
      async restore() { return false; },
      async recover(value) { recovered.push(value); },
      shutdown() {}
    })
  });
  try {
    await manager.resolve(requestStub(), responseStub());
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].profile.trainerName, 'Legacy');
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('schema-v2 restore failure preserves durable obligations and stores only a generic diagnostic', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-session-restore-failure-'));
  const snapshot = {
    ...initialSnapshot(),
    intent: 'leave',
    search: { profile: { trainerName: 'SecretTrainer' }, selection: { strategy: 'hybrid' }, nextQueuePollAt: null, attemptedRaids: {} },
    queue: { state: 'unknown' },
    raid: { state: 'unknown', target: 'raid-1', value: { rpl_id: 'raid-1', rpl_code: '123456789012' } },
    operation: { opId: 'leave-1', kind: 'leaveRaid', input: { raidId: 'raid-1', token: 'secret-token' }, startedAt: '2026-11-11T10:00:00.000Z', attempt: 1 },
    wake: { kind: 'reconcileRaid', dueAt: '2026-11-11T10:01:00.000Z' }
  };
  const manager = new SessionManager({
    rootDir: root,
    defaults: { autoJoin: snapshot },
    adapterFactory: () => ({}),
    workerFactory: () => ({
      status() { return { state: 'idle' }; },
      async restore() {
        const error = new Error('secret-token 123456789012 corrupt snapshot');
        error.name = 'SecretToken';
        throw error;
      },
      shutdown() {}
    })
  });
  try {
    const context = await manager.resolve(requestStub(), responseStub());
    const saved = context.store.get();
    assert.deepEqual(saved.autoJoin, snapshot);
    assert.deepEqual(saved.restoreError, { code: 'RESTORE_FAILED', state: 'locked' });
    assert.equal(JSON.stringify(saved.restoreError).includes('secret-token'), false);
    assert.equal(context.restoreError.state, 'locked');
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('a preserved schema-v2 restore failure is retried on the next startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-session-restore-retry-'));
  const key = '9'.repeat(64);
  const snapshot = {
    ...initialSnapshot(),
    intent: 'leave',
    raid: { state: 'unknown', target: 'raid-1', value: { rpl_id: 'raid-1' } },
    wake: { kind: 'reconcileRaid', dueAt: '2026-11-11T10:01:00.000Z' }
  };
  await writeFile(join(root, `${key}.json`), JSON.stringify({ autoJoin: snapshot }), { mode: 0o600 });
  const first = new SessionManager({
    rootDir: root,
    logger: { error() {} },
    adapterFactory: () => ({}),
    workerFactory: () => ({ status: () => ({ state: 'idle' }), async restore() { throw new Error('restore failed'); }, shutdown() {} })
  });
  await first.ready();
  await first.shutdown();

  let restored;
  const second = new SessionManager({
    rootDir: root,
    adapterFactory: () => ({}),
    workerFactory: () => ({ status: () => ({ state: 'idle' }), async restore(saved) { restored = saved; return true; }, shutdown() {} })
  });
  try {
    await second.ready();
    assert.deepEqual(restored, snapshot);
    const context = await second.resolve(requestStub(`raidnow_session=${'A'.repeat(43)}`), responseStub());
    assert.equal(context.restoreError, null);
  } finally {
    await second.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('state events publish status without overwriting durable worker snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-session-publish-only-'));
  let worker;
  const manager = new SessionManager({
    rootDir: root,
    defaults: { autoJoin: { schemaVersion: 2, intent: 'search' } },
    adapterFactory: () => ({}),
    workerFactory: () => {
      worker = new (class extends EventEmitter {
        status() { return { state: 'searching' }; }
        async restore() { return true; }
        shutdown() {}
      })();
      return worker;
    }
  });
  try {
    const context = await manager.resolve(requestStub(), responseStub());
    worker.emit('state', { state: 'retrying', error: 'temporary' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(context.store.get().autoJoin.schemaVersion, 2);
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('startup eagerly restores only exact regular session files with durable obligations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-session-eager-'));
  const activeKey = 'a'.repeat(64);
  const matchedKey = 'b'.repeat(64);
  const idleKey = 'c'.repeat(64);
  const malformedKey = 'd'.repeat(64);
  const linkedKey = 'e'.repeat(64);
  const unreadableKey = 'f'.repeat(64);
  const active = {
    ...initialSnapshot(),
    intent: 'search',
    search: { profile: {}, selection: { strategy: 'fast' }, nextQueuePollAt: null, attemptedRaids: {} },
    wake: { kind: 'scan', dueAt: '2099-01-01T00:00:00.000Z' }
  };
  await writeFile(join(root, `${activeKey}.json`), JSON.stringify({ autoJoin: active }), { mode: 0o600 });
  await writeFile(join(root, `${matchedKey}.json`), JSON.stringify({ autoJoin: { state: 'matched', raid: { rpl_id: 'raid-1' } } }), { mode: 0o600 });
  await writeFile(join(root, `${idleKey}.json`), JSON.stringify({ autoJoin: { state: 'idle' } }), { mode: 0o600 });
  await writeFile(join(root, `${malformedKey}.json`), '{not-json', { mode: 0o600 });
  await writeFile(join(root, `${unreadableKey}.json`), JSON.stringify({ autoJoin: active }), { mode: 0o600 });
  await chmod(join(root, `${unreadableKey}.json`), 0o000);
  await writeFile(join(root, 'unrelated.json'), JSON.stringify({ autoJoin: active }), { mode: 0o600 });
  await writeFile(join(root, `${'0'.repeat(64)}.json.tmp`), JSON.stringify({ autoJoin: active }), { mode: 0o600 });
  await symlink(join(root, `${activeKey}.json`), join(root, `${linkedKey}.json`));
  const restored = [];
  const logged = [];
  const manager = new SessionManager({
    rootDir: root,
    logger: { error(...args) { logged.push(args); } },
    adapterFactory: ({ sessionKey }) => ({ sessionKey }),
    workerFactory: ({ sessionKey }) => ({
      status() { return { state: 'idle' }; },
      async restore(saved) { restored.push({ sessionKey, saved }); return true; },
      shutdown() {}
    })
  });
  try {
    await manager.ready();
    assert.deepEqual(restored.map(({ sessionKey }) => sessionKey).sort(), [activeKey, matchedKey]);
    assert.equal(logged.length, 2);
    assert.equal(logged[0].join(' ').includes('not-json'), false);
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('startup resumes durable work without a browser request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-session-headless-'));
  const key = '1'.repeat(64);
  const pending = {
    ...initialSnapshot(),
    intent: 'stop',
    queue: { state: 'unknown' },
    wake: { kind: 'reconcileQueue', dueAt: '2000-01-01T00:00:00.000Z' },
    terminal: { target: 'stopped', error: null }
  };
  await writeFile(join(root, `${key}.json`), JSON.stringify({ autoJoin: pending }), { mode: 0o600 });
  let checks = 0;
  const manager = new SessionManager({
    rootDir: root,
    adapterFactory: () => ({ async checkMatching() { checks += 1; return {}; } }),
    workerFactory: ({ adapter, store }) => new AutoJoinWorker({
      adapter,
      pollIntervalMs: 5,
      persist: (snapshot) => store.update({ autoJoin: snapshot })
    })
  });
  try {
    await manager.ready();
    for (let index = 0; index < 100 && checks === 0; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(checks, 1);
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('startup bounds actual upstream work across restored workers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-session-bounded-'));
  const pending = {
    ...initialSnapshot(),
    intent: 'stop',
    queue: { state: 'unknown' },
    wake: { kind: 'reconcileQueue', dueAt: '2000-01-01T00:00:00.000Z' },
    terminal: { target: 'stopped', error: null }
  };
  for (let index = 0; index < 9; index += 1) {
    await writeFile(join(root, `${index.toString(16).repeat(64)}.json`), JSON.stringify({ autoJoin: pending }), { mode: 0o600 });
  }
  let concurrent = 0;
  let maximum = 0;
  let completed = 0;
  const manager = new SessionManager({
    rootDir: root,
    restoreConcurrency: 1.9,
    adapterFactory: () => ({
      async checkMatching() {
        concurrent += 1;
        maximum = Math.max(maximum, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrent -= 1;
        completed += 1;
        return {};
      }
    }),
    workerFactory: ({ adapter, store, runOperation }) => new AutoJoinWorker({
      adapter,
      runOperation,
      pollIntervalMs: 5,
      persist: (snapshot) => store.update({ autoJoin: snapshot })
    })
  });
  try {
    await manager.ready();
    for (let index = 0; index < 200 && completed < 9; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(completed, 9);
    assert.equal(maximum, 1);
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('observes worker errors with sanitized diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-session-worker-error-'));
  const logged = [];
  let worker;
  const manager = new SessionManager({
    rootDir: root,
    logger: { error(...args) { logged.push(args); } },
    adapterFactory: () => ({}),
    workerFactory: () => {
      worker = new EventEmitter();
      worker.status = () => ({ state: 'idle' });
      worker.restore = () => false;
      worker.shutdown = () => {};
      return worker;
    }
  });
  try {
    await manager.resolve(requestStub(), responseStub());
    const error = new Error('secret-token trainer 123456789012');
    error.name = 'SecretToken';
    worker.emit('workerError', error);
    assert.equal(logged.length, 1);
    const output = JSON.stringify(logged[0]);
    assert.match(output, /Auto Join worker failed/);
    assert.equal(output.includes('secret-token'), false);
    assert.equal(output.includes('SecretToken'), false);
    assert.equal(output.includes('123456789012'), false);
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('shutdown prevents a worker waiting for an upstream permit from launching', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-session-abort-wait-'));
  const pending = {
    ...initialSnapshot(),
    intent: 'stop',
    queue: { state: 'unknown' },
    wake: { kind: 'reconcileQueue', dueAt: '2000-01-01T00:00:00.000Z' },
    terminal: { target: 'stopped', error: null }
  };
  for (const key of ['a'.repeat(64), 'b'.repeat(64)]) {
    await writeFile(join(root, `${key}.json`), JSON.stringify({ autoJoin: pending }), { mode: 0o600 });
  }
  let started = 0;
  const manager = new SessionManager({
    rootDir: root,
    restoreConcurrency: 1,
    adapterFactory: () => ({
      async checkMatching(_input, { signal }) {
        started += 1;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
    }),
    workerFactory: ({ adapter, store, runOperation }) => new AutoJoinWorker({
      adapter,
      runOperation,
      persist: (snapshot) => store.update({ autoJoin: snapshot })
    })
  });
  try {
    await manager.ready();
    for (let index = 0; index < 100 && started === 0; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(started, 1);
    await manager.shutdown();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cleanup expires idle loaded and unloaded sessions but preserves protected and malformed state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-session-cleanup-'));
  let now = 10_000;
  const workers = [];
  const manager = new SessionManager({
    rootDir: root,
    ttlMs: 1_000,
    now: () => now,
    adapterFactory: () => ({}),
    workerFactory: () => {
      const worker = { current: { state: 'idle' }, status() { return this.current; }, restore() { return false; }, shutdown() {} };
      workers.push(worker);
      return worker;
    }
  });
  try {
    const idleResponse = responseStub();
    const idle = await manager.resolve(requestStub(), idleResponse, { lease: true });
    await idle.store.update({ account: { token: 'expirable-token' } });
    const protectedResponse = responseStub();
    const protectedContext = await manager.resolve(requestStub(), protectedResponse);
    workers[1].current = { state: 'matched' };
    const streamingResponse = responseStub();
    const streamingContext = await manager.resolve(requestStub(), streamingResponse);
    const releaseStream = manager.addSseClient(streamingContext, { write() {} });

    const unloadedKey = '7'.repeat(64);
    const malformedKey = '8'.repeat(64);
    const old = new Date(0);
    await writeFile(join(root, `${unloadedKey}.json`), JSON.stringify({ autoJoin: { state: 'idle' } }), { mode: 0o600 });
    await writeFile(join(root, `${malformedKey}.json`), '{broken', { mode: 0o600 });
    await utimes(join(root, `${unloadedKey}.json`), old, old);
    await utimes(join(root, `${malformedKey}.json`), old, old);

    now += 2_000;
    await manager.cleanup();
    await access(join(root, `${idle.sessionKey}.json`));
    manager.release(idle);
    now += 2_000;
    await manager.cleanup();
    await assert.rejects(access(join(root, `${idle.sessionKey}.json`)));
    await assert.rejects(access(join(root, `${unloadedKey}.json`)));
    await access(join(root, `${protectedContext.sessionKey}.json`));
    await access(join(root, `${streamingContext.sessionKey}.json`));
    await access(join(root, `${malformedKey}.json`));
    releaseStream();
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('startup and cleanup remove only stale regular atomic temp files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-session-temp-cleanup-'));
  const stale = `${'a'.repeat(64)}.json.123.tmp`;
  const recent = `${'b'.repeat(64)}.json.456.tmp`;
  const linked = `${'c'.repeat(64)}.json.789.tmp`;
  const unrelated = `${'d'.repeat(64)}.json.tmp`;
  const target = join(root, 'target');
  await writeFile(join(root, stale), 'stale');
  await writeFile(join(root, recent), 'recent');
  await writeFile(target, 'target');
  await symlink(target, join(root, linked));
  await writeFile(join(root, unrelated), 'unrelated');
  await utimes(join(root, stale), new Date(0), new Date(0));
  const manager = new SessionManager({
    rootDir: root,
    staleTempMs: 1_000,
    now: () => 10_000,
    adapterFactory: () => ({}),
    workerFactory: () => ({ status: () => ({ state: 'idle' }), restore: () => false, shutdown() {} })
  });
  try {
    await manager.ready();
    await assert.rejects(access(join(root, stale)));
    await access(join(root, recent));
    await access(join(root, linked));
    await access(join(root, unrelated));

    const later = `${'e'.repeat(64)}.json.321.tmp`;
    await writeFile(join(root, later), 'later');
    await utimes(join(root, later), new Date(0), new Date(0));
    await manager.cleanup();
    await assert.rejects(access(join(root, later)));
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('capacity evicts the least-recently-used safe context and rejects when every context is protected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-session-capacity-'));
  const workers = [];
  const manager = new SessionManager({
    rootDir: root,
    maxContexts: 2,
    adapterFactory: () => ({}),
    workerFactory: () => {
      const worker = { current: { state: 'idle' }, status() { return this.current; }, restore() { return false; }, shutdown() {} };
      workers.push(worker);
      return worker;
    }
  });
  try {
    const first = await manager.resolve(requestStub(`raidnow_session=${'A'.repeat(43)}`), responseStub());
    await manager.resolve(requestStub(`raidnow_session=${'B'.repeat(43)}`), responseStub());
    workers[1].current = { state: 'searching' };
    const third = await manager.resolve(requestStub(`raidnow_session=${'C'.repeat(43)}`), responseStub());
    assert.notEqual(third.sessionKey, first.sessionKey);
    await assert.rejects(access(join(root, `${first.sessionKey}.json`)));
    workers[2].current = { state: 'matched' };
    await assert.rejects(
      manager.resolve(requestStub(`raidnow_session=${'D'.repeat(43)}`), responseStub()),
      (error) => error?.code === 'SESSION_CAPACITY'
    );
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('reset removes only idle sessions and expires the cookie with matching security attributes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-session-reset-'));
  const manager = new SessionManager({
    rootDir: root,
    cookieSecure: true,
    adapterFactory: () => ({}),
    workerFactory: () => ({ status: () => ({ state: 'idle' }), restore: () => false, shutdown() {} })
  });
  try {
    const issued = responseStub();
    const context = await manager.resolve(requestStub(), issued, { lease: true });
    const cookie = issued.getHeader('set-cookie').split(';', 1)[0];
    assert.match(issued.getHeader('set-cookie'), /; Secure/);
    await assert.rejects(manager.reset(requestStub(cookie), responseStub(), context), (error) => error.code === 'SESSION_CONFLICT');
    manager.release(context);
    context.restoreError = { code: 'RESTORE_FAILED', state: 'locked' };
    await assert.rejects(manager.reset(requestStub(cookie), responseStub(), context), (error) => error.code === 'SESSION_CONFLICT');
    context.restoreError = null;
    await context.store.update({ autoJoin: { ...initialSnapshot(), queue: { state: 'unknown' } } });
    await assert.rejects(manager.reset(requestStub(cookie), responseStub(), context), (error) => error.code === 'SESSION_CONFLICT');
    await context.store.update({ autoJoin: initialSnapshot() });
    const resetResponse = responseStub();
    await manager.reset(requestStub(cookie), resetResponse, context);
    assert.match(resetResponse.getHeader('set-cookie'), /^raidnow_session=;/);
    assert.match(resetResponse.getHeader('set-cookie'), /Max-Age=0/);
    assert.match(resetResponse.getHeader('set-cookie'), /HttpOnly; SameSite=Strict; Secure/);
    await assert.rejects(access(join(root, `${context.sessionKey}.json`)));
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('a request arriving during reset waits and receives a fresh context after deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-session-reset-race-'));
  let releaseShutdown;
  let shutdownStarted;
  const started = new Promise((resolve) => { shutdownStarted = resolve; });
  let workersCreated = 0;
  const manager = new SessionManager({
    rootDir: root,
    adapterFactory: () => ({}),
    workerFactory: () => {
      workersCreated += 1;
      const generation = workersCreated;
      let shutdownCalls = 0;
      return {
        generation,
        status: () => ({ state: 'idle' }),
        restore: () => false,
        async shutdown() {
          shutdownCalls += 1;
          if (generation !== 1 || shutdownCalls !== 1) return;
          shutdownStarted();
          await new Promise((resolve) => { releaseShutdown = resolve; });
        }
      };
    }
  });
  try {
    const issued = responseStub();
    const original = await manager.resolve(requestStub(), issued);
    const cookie = issued.getHeader('set-cookie').split(';', 1)[0];
    await original.store.update({ account: { token: 'old-secret-token' } });

    const resetting = manager.reset(requestStub(cookie), responseStub(), original);
    await started;
    let replacementResolved = false;
    const replacementPromise = manager.resolve(requestStub(cookie), responseStub(), { lease: true })
      .then((context) => { replacementResolved = true; return context; });
    const concurrentReplacementPromise = manager.resolve(requestStub(cookie), responseStub(), { lease: true });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(replacementResolved, false);
    assert.equal(original.activeRequests, 0);
    releaseShutdown();
    await resetting;
    const replacement = await replacementPromise;
    const concurrentReplacement = await concurrentReplacementPromise;
    assert.notEqual(replacement, original);
    assert.equal(concurrentReplacement, replacement);
    assert.equal(workersCreated, 2);
    assert.equal(replacement.worker.generation, 2);
    assert.equal(replacement.store.get().account, null);
    assert.equal(replacement.activeRequests, 2);
    await access(join(root, `${replacement.sessionKey}.json`));
    manager.release(replacement);
    manager.release(concurrentReplacement);
  } finally {
    releaseShutdown?.();
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('resolve revalidates a captured context before leasing while reset removes it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-session-pre-lease-race-'));
  let releaseShutdown;
  let shutdownStarted;
  const started = new Promise((resolve) => { shutdownStarted = resolve; });
  let workersCreated = 0;
  const manager = new SessionManager({
    rootDir: root,
    adapterFactory: () => ({}),
    workerFactory: () => {
      workersCreated += 1;
      const generation = workersCreated;
      return {
        generation,
        status: () => ({ state: 'idle' }),
        restore: () => false,
        async shutdown() {
          if (generation !== 1) return;
          shutdownStarted();
          await new Promise((resolve) => { releaseShutdown = resolve; });
        }
      };
    }
  });
  try {
    const issued = responseStub();
    const original = await manager.resolve(requestStub(), issued);
    const cookie = issued.getHeader('set-cookie').split(';', 1)[0];

    let resolved = false;
    const resolving = manager.resolve(requestStub(cookie), responseStub(), { lease: true })
      .then((context) => { resolved = true; return context; });
    await Promise.resolve();
    await Promise.resolve();

    const resetting = manager.reset(requestStub(cookie), responseStub(), original);
    await started;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resolved, false);
    assert.equal(original.activeRequests, 0);

    releaseShutdown();
    await resetting;
    const replacement = await resolving;
    assert.notEqual(replacement, original);
    assert.equal(replacement.worker.generation, 2);
    assert.equal(replacement.removing, undefined);
    assert.equal(replacement.removed, undefined);
    assert.equal(replacement.activeRequests, 1);
    manager.release(replacement);
  } finally {
    releaseShutdown?.();
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('failed removal leaves the old context tombstoned and unavailable to resolve', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-session-reset-failure-'));
  let workersCreated = 0;
  const removalError = new Error('shutdown contained secret-token 123456789012');
  const manager = new SessionManager({
    rootDir: root,
    adapterFactory: () => ({}),
    workerFactory: () => {
      workersCreated += 1;
      return {
        status: () => ({ state: 'idle' }),
        restore: () => false,
        async shutdown() { throw removalError; }
      };
    }
  });
  const issued = responseStub();
  const original = await manager.resolve(requestStub(), issued);
  const cookie = issued.getHeader('set-cookie').split(';', 1)[0];
  try {
    await assert.rejects(manager.reset(requestStub(cookie), responseStub(), original), (error) => error === removalError);
    await assert.rejects(manager.resolve(requestStub(cookie), responseStub(), { lease: true }), (error) => error === removalError);
    assert.equal(original.activeRequests, 0);
    assert.equal(workersCreated, 1);
    await access(join(root, `${original.sessionKey}.json`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('capacity counts pending context creation without waiting for it to finish', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-session-pending-capacity-'));
  let releaseRestore;
  let restoreStarted;
  const started = new Promise((resolve) => { restoreStarted = resolve; });
  const manager = new SessionManager({
    rootDir: root,
    maxContexts: 1,
    adapterFactory: () => ({}),
    workerFactory: () => ({
      status: () => ({ state: 'idle' }),
      async restore() {
        restoreStarted();
        await new Promise((resolve) => { releaseRestore = resolve; });
        return false;
      },
      shutdown() {}
    })
  });
  try {
    const first = manager.resolve(requestStub(`raidnow_session=${'A'.repeat(43)}`), responseStub());
    await started;
    const result = await Promise.race([
      manager.resolve(requestStub(`raidnow_session=${'B'.repeat(43)}`), responseStub()).then(() => 'admitted', (error) => error.code),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 25))
    ]);
    assert.equal(result, 'SESSION_CAPACITY');
    releaseRestore();
    await first;
  } finally {
    releaseRestore?.();
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('session state files retain owner-only permissions after updates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-session-file-mode-'));
  const manager = new SessionManager({
    rootDir: root,
    adapterFactory: () => ({}),
    workerFactory: () => ({ status: () => ({ state: 'idle' }), restore: () => false, shutdown() {} })
  });
  try {
    const context = await manager.resolve(requestStub(), responseStub());
    await context.store.update({ account: { token: 'secret' } });
    assert.equal((await stat(join(root, `${context.sessionKey}.json`))).mode & 0o777, 0o600);
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('startup restores every durable obligation even above capacity and rejects new admissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-session-startup-capacity-'));
  const durable = { ...initialSnapshot(), intent: 'search', wake: { kind: 'scan', dueAt: '2099-01-01T00:00:00.000Z' } };
  for (const key of ['a'.repeat(64), 'b'.repeat(64)]) await writeFile(join(root, `${key}.json`), JSON.stringify({ autoJoin: durable }), { mode: 0o600 });
  let restored = 0;
  const manager = new SessionManager({
    rootDir: root,
    maxContexts: 1,
    logger: { error() {} },
    adapterFactory: () => ({}),
    workerFactory: () => ({ status: () => ({ state: 'searching' }), restore() { restored += 1; return true; }, shutdown() {} })
  });
  try {
    await manager.ready();
    assert.equal(restored, 2);
    assert.equal((await readdir(root)).length, 2);
    await assert.rejects(
      manager.resolve(requestStub(`raidnow_session=${'C'.repeat(43)}`), responseStub()),
      (error) => error?.code === 'SESSION_CAPACITY'
    );
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('global SSE capacity spans sessions and disconnect release restores capacity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-session-global-sse-'));
  const manager = new SessionManager({
    rootDir: root,
    globalSseLimit: 1,
    adapterFactory: () => ({}),
    workerFactory: () => ({ status: () => ({ state: 'idle' }), restore: () => false, shutdown() {} })
  });
  try {
    const first = await manager.resolve(requestStub(`raidnow_session=${'A'.repeat(43)}`), responseStub());
    const second = await manager.resolve(requestStub(`raidnow_session=${'B'.repeat(43)}`), responseStub());
    const release = manager.addSseClient(first, { write() {} });
    assert.throws(() => manager.addSseClient(second, { write() {} }), (error) => error.code === 'SESSION_RATE_LIMIT');
    release();
    const releaseSecond = manager.addSseClient(second, { write() {} });
    releaseSecond();
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('push subscription mutations share one FIFO queue without lost adds or resurrection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-push-mutation-'));
  const manager = new SessionManager({
    rootDir: root,
    adapterFactory: () => ({}),
    workerFactory: () => ({ status: () => ({ state: 'idle' }), restore: () => false, shutdown() {} })
  });
  try {
    const context = await manager.resolve(requestStub(), responseStub());
    const first = pushRecord('first');
    const second = pushRecord('second');
    await Promise.all([
      manager.addPushSubscription(context, { endpoint: first.endpoint, expirationTime: null, keys: first.keys }),
      manager.addPushSubscription(context, { endpoint: second.endpoint, expirationTime: null, keys: second.keys })
    ]);
    assert.deepEqual(context.store.get().pushSubscriptions.map((entry) => entry.id).sort(), [first.id, second.id].sort());

    const third = pushRecord('third');
    const addThenDelete = manager.addPushSubscription(context, { endpoint: third.endpoint, expirationTime: null, keys: third.keys });
    const deleteAfterAdd = manager.removePushSubscription(context, third.id);
    await Promise.all([addThenDelete, deleteAfterAdd]);
    assert.equal(context.store.get().pushSubscriptions.some((entry) => entry.id === third.id), false);

    const deleteFirst = manager.removePushSubscription(context, first.id);
    const addAfterDelete = manager.addPushSubscription(context, { endpoint: first.endpoint, expirationTime: null, keys: { p256dh: 'new', auth: 'new' } });
    await Promise.all([deleteFirst, addAfterDelete]);
    assert.deepEqual(context.store.get().pushSubscriptions.find((entry) => entry.id === first.id).keys, { p256dh: 'new', auth: 'new' });
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('matched worker persistence atomically records a push job that restores headlessly after the matched callback is lost', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-push-atomic-match-'));
  const cookie = `raidnow_session=${'A'.repeat(43)}`;
  const subscription = pushRecord('atomic-match');
  let persistWorkerSnapshot;
  const first = new SessionManager({
    rootDir: root,
    pushNotifier: { enabled: true, async send() { throw new Error('matched callback was suppressed'); } },
    adapterFactory: () => ({}),
    workerFactory: ({ persist }) => {
      persistWorkerSnapshot = persist;
      return { status: () => ({ state: 'idle' }), restore: () => false, shutdown() {} };
    }
  });
  try {
    const context = await first.resolve(requestStub(cookie), responseStub());
    await first.addPushSubscription(context, subscription);
    const matched = {
      ...initialSnapshot(),
      raid: { state: 'matched', target: 'raid-atomic', value: { rpl_id: 'raid-atomic' } },
      terminal: { target: 'matched', error: null }
    };

    await persistWorkerSnapshot(matched);
    const saved = JSON.parse(await readFile(join(root, `${context.sessionKey}.json`), 'utf8'));
    assert.deepEqual(saved.autoJoin, matched);
    assert.equal(saved.pushDeliveryJobs.length, 1);
    assert.equal(saved.pushDeliveryJobs[0].pending.length, 1);
    assert.equal(saved.pushDeliveryJobs[0].pending[0].id, subscription.id);
    assert.equal(saved.pushDeliveryJobs[0].pending[0].attempts, 0);
    await first.shutdown();

    let sends = 0;
    const restored = new SessionManager({
      rootDir: root,
      pushNotifier: { enabled: true, async send() { sends += 1; return { delivered: true, terminal: false, statusCode: null }; } },
      adapterFactory: () => ({}),
      workerFactory: () => ({ status: () => ({ state: 'matched' }), restore: () => true, shutdown() {} })
    });
    try {
      await restored.ready();
      await waitFor(async () => {
        const state = JSON.parse(await readFile(join(root, `${context.sessionKey}.json`), 'utf8'));
        return sends === 1 && state.pushDeliveryJobs[0].pending.length === 0;
      });
    } finally {
      await restored.shutdown();
    }
  } finally {
    await first.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('matched worker persistence merges subscriptions without resetting completed or pending outcomes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-push-atomic-merge-'));
  const completed = pushRecord('completed');
  const pending = pushRecord('pending');
  const added = pushRecord('added');
  const marker = raidNotificationMarker({ rpl_id: 'raid-merge' });
  let persistWorkerSnapshot;
  const manager = new SessionManager({
    rootDir: root,
    now: () => 500,
    pushShutdownWaitMs: 5,
    pushNotifier: { enabled: true, async send() { return new Promise(() => {}); } },
    defaults: {
      autoJoin: initialSnapshot(),
      pushSubscriptions: [completed, pending, added],
      pushDeliveryJobs: [{
        marker,
        createdAt: new Date(0).toISOString(),
        pending: [{ id: pending.id, attempts: 3, nextRetryAt: 900 }],
        completed: [completed.id]
      }]
    },
    adapterFactory: () => ({}),
    workerFactory: ({ persist }) => {
      persistWorkerSnapshot = persist;
      return { status: () => ({ state: 'idle' }), restore: () => false, shutdown() {} };
    }
  });
  try {
    const context = await manager.resolve(requestStub(), responseStub());
    await persistWorkerSnapshot({
      ...initialSnapshot(),
      raid: { state: 'matched', target: 'raid-merge', value: { rpl_id: 'raid-merge' } },
      terminal: { target: 'matched', error: null }
    });
    const job = context.store.get().pushDeliveryJobs[0];
    assert.equal(job.createdAt, new Date(0).toISOString());
    assert.deepEqual(job.completed, [completed.id]);
    assert.deepEqual(job.pending, [
      { id: pending.id, attempts: 3, nextRetryAt: 900 },
      { id: added.id, attempts: 0, nextRetryAt: 500 }
    ]);
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('returning from uncertain leave reconciliation does not notify subscriptions added after the original match', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-push-leave-reconcile-'));
  const original = pushRecord('leave-original');
  const addedLater = pushRecord('leave-added');
  const raid = { rpl_id: 'raid-leave-reconcile' };
  const marker = raidNotificationMarker(raid);
  let persistWorkerSnapshot;
  const manager = new SessionManager({
    rootDir: root,
    pushNotifier: { enabled: true, async send() { throw new Error('no delivery expected'); } },
    defaults: {
      autoJoin: {
        ...initialSnapshot(),
        intent: 'leave',
        raid: { state: 'unknown', target: raid.rpl_id, value: raid },
        terminal: { target: 'idle', error: null }
      },
      pushSubscriptions: [original, addedLater],
      pushDeliveryJobs: [{ marker, createdAt: new Date(0).toISOString(), pending: [], completed: [original.id] }]
    },
    adapterFactory: () => ({}),
    workerFactory: ({ persist }) => {
      persistWorkerSnapshot = persist;
      return { status: () => ({ state: 'matched' }), restore: () => false, shutdown() {} };
    }
  });
  try {
    const context = await manager.resolve(requestStub(), responseStub());
    await persistWorkerSnapshot(matchedSnapshot(raid.rpl_id));
    assert.deepEqual(context.store.get().pushDeliveryJobs[0].completed, [original.id]);
    assert.deepEqual(context.store.get().pushDeliveryJobs[0].pending, []);
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('startup repairs a legacy matched snapshot missing its push job before readiness without duplicating completed jobs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-push-repair-match-'));
  const missingKey = '4'.repeat(64);
  const completedKey = '5'.repeat(64);
  const missingSubscription = pushRecord('repair-missing');
  const completedSubscription = pushRecord('repair-completed');
  const matched = {
    ...initialSnapshot(),
    raid: { state: 'matched', target: 'raid-repair', value: { rpl_id: 'raid-repair' } },
    terminal: { target: 'matched', error: null }
  };
  const marker = raidNotificationMarker(matched.raid.value);
  await writeFile(join(root, `${missingKey}.json`), JSON.stringify({ autoJoin: matched, pushSubscriptions: [missingSubscription], pushDeliveryJobs: [] }), { mode: 0o600 });
  await writeFile(join(root, `${completedKey}.json`), JSON.stringify({
    autoJoin: matched,
    pushSubscriptions: [completedSubscription],
    pushDeliveryJobs: [{ marker, createdAt: new Date(0).toISOString(), pending: [], completed: [completedSubscription.id] }]
  }), { mode: 0o600 });
  let sends = 0;
  const manager = new SessionManager({
    rootDir: root,
    pushNotifier: { enabled: true, async send() { sends += 1; return { delivered: true, terminal: false, statusCode: null }; } },
    adapterFactory: () => ({}),
    workerFactory: () => ({ status: () => ({ state: 'matched' }), restore: () => true, shutdown() {} })
  });
  try {
    await manager.ready();
    const repaired = JSON.parse(await readFile(join(root, `${missingKey}.json`), 'utf8'));
    const preserved = JSON.parse(await readFile(join(root, `${completedKey}.json`), 'utf8'));
    assert.equal(repaired.pushDeliveryJobs.length, 1);
    assert.equal(preserved.pushDeliveryJobs.length, 1);
    assert.deepEqual(preserved.pushDeliveryJobs[0].completed, [completedSubscription.id]);
    await waitFor(() => sends === 1);
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('push delivery persists before send, retries transient failure, and suppresses completed duplicates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-push-retry-'));
  let worker;
  let context;
  let persistWorkerSnapshot;
  let sends = 0;
  const notifier = {
    enabled: true,
    async send() {
      sends += 1;
      const pending = context.store.get().pushDeliveryJobs?.[0]?.pending ?? [];
      assert.equal(pending.length, 1);
      return sends === 1
        ? { delivered: false, terminal: false, statusCode: 503 }
        : { delivered: true, terminal: false, statusCode: null };
    }
  };
  const manager = new SessionManager({
    rootDir: root,
    pushNotifier: notifier,
    pushRetryBaseMs: 5,
    pushRetryMaxMs: 10,
    adapterFactory: () => ({}),
    workerFactory: ({ persist }) => {
      persistWorkerSnapshot = persist;
      worker = new EventEmitter();
      worker.status = () => ({ state: 'idle' });
      worker.restore = () => false;
      worker.shutdown = () => {};
      return worker;
    }
  });
  try {
    context = await manager.resolve(requestStub(), responseStub());
    const subscription = pushRecord('retry');
    await manager.addPushSubscription(context, subscription);
    await persistWorkerSnapshot(matchedSnapshot('raid-retry'));
    worker.emit('matched', { rpl_id: 'raid-retry' });
    await waitFor(() => sends === 2 && context.store.get().pushDeliveryJobs?.[0]?.pending.length === 0);
    const job = context.store.get().pushDeliveryJobs[0];
    assert.deepEqual(job.completed, [subscription.id]);
    worker.emit('matched', { rpl_id: 'raid-retry' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sends, 2);
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('startup resumes pending push jobs headlessly and terminal delivery removes the subscription', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-push-resume-'));
  const key = '6'.repeat(64);
  const subscription = pushRecord('gone');
  const marker = raidNotificationMarker({ rpl_id: 'raid-gone' });
  await writeFile(join(root, `${key}.json`), JSON.stringify({
    autoJoin: null,
    pushSubscriptions: [subscription],
    pushDeliveryJobs: [{ marker, createdAt: new Date(0).toISOString(), pending: [{ id: subscription.id, attempts: 2, nextRetryAt: 0 }], completed: [] }]
  }), { mode: 0o600 });
  let sends = 0;
  const manager = new SessionManager({
    rootDir: root,
    pushNotifier: { enabled: true, async send() { sends += 1; return { delivered: false, terminal: true, statusCode: 410 }; } },
    adapterFactory: () => ({}),
    workerFactory: () => ({ status: () => ({ state: 'idle' }), restore: () => false, shutdown() {} })
  });
  try {
    await manager.ready();
    await waitFor(async () => {
      const saved = JSON.parse(await readFile(join(root, `${key}.json`), 'utf8'));
      return sends === 1 && saved.pushSubscriptions.length === 0 && saved.pushDeliveryJobs[0].pending.length === 0;
    });
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('pending push jobs protect a session from capacity eviction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-push-protected-'));
  let worker;
  let persistWorkerSnapshot;
  const manager = new SessionManager({
    rootDir: root,
    maxContexts: 1,
    pushRetryBaseMs: 60_000,
    pushNotifier: { enabled: true, async send() { return { delivered: false, terminal: false, statusCode: null }; } },
    adapterFactory: () => ({}),
    workerFactory: ({ persist }) => {
      persistWorkerSnapshot = persist;
      worker = new EventEmitter();
      worker.status = () => ({ state: 'idle' });
      worker.restore = () => false;
      worker.shutdown = () => {};
      return worker;
    }
  });
  try {
    const context = await manager.resolve(requestStub(`raidnow_session=${'A'.repeat(43)}`), responseStub());
    await manager.addPushSubscription(context, pushRecord('protected'));
    await persistWorkerSnapshot(matchedSnapshot('raid-protected'));
    worker.emit('matched', { rpl_id: 'raid-protected' });
    await waitFor(() => context.store.get().pushDeliveryJobs?.[0]?.pending[0]?.attempts === 1);
    await assert.rejects(
      manager.resolve(requestStub(`raidnow_session=${'B'.repeat(43)}`), responseStub()),
      (error) => error.code === 'SESSION_CAPACITY'
    );
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('shutdown bounds a hung push send and preserves its pending durable job', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-push-shutdown-'));
  let worker;
  let persistWorkerSnapshot;
  let sendStarted;
  const started = new Promise((resolve) => { sendStarted = resolve; });
  const manager = new SessionManager({
    rootDir: root,
    pushShutdownWaitMs: 10,
    pushNotifier: { enabled: true, async send() { sendStarted(); return new Promise(() => {}); } },
    adapterFactory: () => ({}),
    workerFactory: ({ persist }) => {
      persistWorkerSnapshot = persist;
      worker = new EventEmitter();
      worker.status = () => ({ state: 'idle' });
      worker.restore = () => false;
      worker.shutdown = () => {};
      return worker;
    }
  });
  try {
    const context = await manager.resolve(requestStub(), responseStub());
    await manager.addPushSubscription(context, pushRecord('hung'));
    await persistWorkerSnapshot(matchedSnapshot('raid-hung'));
    worker.emit('matched', { rpl_id: 'raid-hung' });
    await started;
    await manager.shutdown();
    const saved = JSON.parse(await readFile(join(root, `${context.sessionKey}.json`), 'utf8'));
    assert.equal(saved.pushDeliveryJobs[0].pending.length, 1);
    assert.equal(saved.pushDeliveryJobs[0].pending[0].attempts, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
