import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createECDH } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { SessionManager } from '../src/core/session-manager.js';

class TestWorker extends EventEmitter {
  constructor(persist) {
    super();
    this.persist = persist;
    this.current = { state: 'idle' };
  }
  status() { return structuredClone(this.current); }
  restore() { return false; }
  async start({ profile, selection }) {
    this.current = { state: 'searching', profile, selection };
    this.emit('state', this.status());
    return this.status();
  }
  async stop() { this.current = { state: 'stopped' }; return this.status(); }
  async match(raid) {
    this.current = { state: 'matched', raid };
    await this.persist(this.current);
    this.emit('matched', raid);
  }
  activeRaid() { return null; }
  shutdown() {}
}

async function createMultiUserApp({ managerOptions = {}, appOptions = {}, root: existingRoot = null } = {}) {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), 'raidnow-multi-app-'));
  const adapters = [];
  const workers = [];
  const manager = new SessionManager({
    rootDir: join(root, 'sessions'),
    adapterFactory: ({ token }) => {
      const adapter = {
        token: token || '',
        setToken(value) { this.token = value; },
        hasToken() { return Boolean(this.token); },
        async updateProfile() { return {}; },
        async listCurrentRaidBosses() { return []; }
      };
      adapters.push(adapter);
      return adapter;
    },
    workerFactory: ({ persist }) => {
      const worker = new TestWorker(persist);
      workers.push(worker);
      return worker;
    },
    ...managerOptions
  });
  const app = createApp({ sessionManager: manager, pollIntervalMs: 5, publicDir: new URL('../public/', import.meta.url), mode: 'live', liveWrites: true, ...appOptions });
  await app.ready;
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { app, manager, adapters, workers, root, baseUrl: `http://127.0.0.1:${app.server.address().port}` };
}

const pushEcdh = createECDH('prime256v1');
pushEcdh.generateKeys();
const pushSubscription = (suffix = 'one') => ({
  endpoint: `https://fcm.googleapis.com/send/${suffix}`,
  expirationTime: null,
  keys: { p256dh: pushEcdh.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 9).toString('base64url') }
});

async function waitFor(predicate, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition.');
}

async function newBrowser(baseUrl) {
  const response = await fetch(`${baseUrl}/api/config`);
  return response.headers.get('set-cookie').split(';', 1)[0];
}

function request(baseUrl, cookie, path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { cookie, 'content-type': 'application/json', ...(options.headers || {}) }
  });
}

test('isolates tokens, profiles, workers, and status between browser sessions', async () => {
  const fixture = await createMultiUserApp();
  try {
    const firstCookie = await newBrowser(fixture.baseUrl);
    const secondCookie = await newBrowser(fixture.baseUrl);
    assert.notEqual(firstCookie, secondCookie);

    await request(fixture.baseUrl, firstCookie, '/api/session/import', { method: 'POST', body: JSON.stringify({ token: 'first-token' }) });
    const firstConfig = await request(fixture.baseUrl, firstCookie, '/api/config').then((response) => response.json());
    const secondConfig = await request(fixture.baseUrl, secondCookie, '/api/config').then((response) => response.json());
    assert.equal(firstConfig.loggedIn, true);
    assert.equal(secondConfig.loggedIn, false);

    const firstProfile = { trainerName: 'FirstUser', trainerCode: '111122223333', level: 50, countryCode: 'se' };
    const secondProfile = { trainerName: 'SecondUser', trainerCode: '444455556666', level: 40, countryCode: 'dk' };
    const selection = { strategy: 'hybrid', ranks: ['5'], pokemon: ['Giratina'] };
    await request(fixture.baseUrl, firstCookie, '/api/autojoin/start', { method: 'POST', body: JSON.stringify({ ...selection, profile: firstProfile }) });
    await request(fixture.baseUrl, secondCookie, '/api/autojoin/start', { method: 'POST', body: JSON.stringify({ ...selection, profile: secondProfile }) });

    const firstStatus = await request(fixture.baseUrl, firstCookie, '/api/autojoin/status').then((response) => response.json());
    const secondStatus = await request(fixture.baseUrl, secondCookie, '/api/autojoin/status').then((response) => response.json());
    assert.equal(firstStatus.profile.trainerName, 'FirstUser');
    assert.equal(secondStatus.profile.trainerName, 'SecondUser');
    assert.equal(fixture.adapters[0].token, 'first-token');
    assert.equal(fixture.adapters[1].token, '');
    assert.notEqual(fixture.workers[0], fixture.workers[1]);
  } finally {
    await fixture.manager.shutdown();
    await new Promise((resolve) => fixture.app.server.close(resolve));
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('validates a browser profile without retaining it in backend state', async () => {
  const fixture = await createMultiUserApp();
  try {
    const cookie = await newBrowser(fixture.baseUrl);
    const profile = { trainerName: 'LocalOnly', trainerCode: '123456789012', level: 50, countryCode: 'se' };
    const saved = await request(fixture.baseUrl, cookie, '/api/profile', { method: 'PUT', body: JSON.stringify(profile) });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), profile);
    assert.deepEqual(await request(fixture.baseUrl, cookie, '/api/profile').then((response) => response.json()), {});
  } finally {
    await fixture.manager.shutdown();
    await new Promise((resolve) => fixture.app.server.close(resolve));
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('static, health, and unknown non-API GETs do not allocate sessions', async () => {
  const fixture = await createMultiUserApp();
  try {
    const cases = [
      ['/', 200],
      ['/app.js', 200],
      ['/api/health', 200],
      ['/manifest.webmanifest', 200],
      ['/service-worker.js', 200],
      ['/icons/icon-192.png', 200],
      ['/future/icon.png', 404],
      ['/missing.js', 404],
      ['/missing-route', 200]
    ];
    for (const [path, expectedStatus] of cases) {
      const response = await fetch(`${fixture.baseUrl}${path}`);
      assert.equal(response.status, expectedStatus, path);
      assert.equal(response.headers.get('set-cookie'), null, path);
      if (path === '/manifest.webmanifest') assert.match(response.headers.get('content-type'), /^application\/manifest\+json/);
      if (path === '/service-worker.js') {
        assert.match(response.headers.get('content-type'), /^text\/javascript/);
        assert.equal(response.headers.get('cache-control'), 'no-cache');
      }
      if (path.endsWith('.png') && expectedStatus === 200) assert.equal(response.headers.get('content-type'), 'image/png');
      if (expectedStatus === 404) assert.notEqual(response.headers.get('content-type'), 'text/html; charset=utf-8');
    }
    assert.deepEqual(await readdir(join(fixture.root, 'sessions')), []);

    const config = await fetch(`${fixture.baseUrl}/api/config`);
    assert.match(config.headers.get('set-cookie'), /^raidnow_session=/);
    assert.equal((await readdir(join(fixture.root, 'sessions'))).length, 1);
  } finally {
    await fixture.manager.shutdown();
    await new Promise((resolve) => fixture.app.server.close(resolve));
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('unrecognized API routes and methods do not allocate sessions', async () => {
  const fixture = await createMultiUserApp();
  try {
    const cases = [
      ['/api/not-a-route', {}, 404],
      ['/api/config', { method: 'POST' }, 405],
      ['/api/autojoin/start', { method: 'GET' }, 405],
      ['/not-an-api', { method: 'POST' }, 404]
    ];
    for (const [path, options, expected] of cases) {
      const response = await fetch(`${fixture.baseUrl}${path}`, options);
      assert.equal(response.status, expected, `${options.method ?? 'GET'} ${path}`);
      assert.equal(response.headers.get('set-cookie'), null, path);
    }
    assert.deepEqual(await readdir(join(fixture.root, 'sessions')), []);
  } finally {
    await fixture.manager.shutdown();
    await new Promise((resolve) => fixture.app.server.close(resolve));
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('idle reset removes state, expires the cookie, and creates a fresh session later', async () => {
  const fixture = await createMultiUserApp({ managerOptions: { cookieSecure: true } });
  try {
    const cookie = await newBrowser(fixture.baseUrl);
    const reset = await request(fixture.baseUrl, cookie, '/api/session/reset', { method: 'POST' });
    assert.equal(reset.status, 200);
    assert.deepEqual(await reset.json(), { reset: true });
    assert.match(reset.headers.get('set-cookie'), /^raidnow_session=;/);
    assert.match(reset.headers.get('set-cookie'), /Secure/);
    assert.equal((await readdir(join(fixture.root, 'sessions'))).length, 0);
    const fresh = await fetch(`${fixture.baseUrl}/api/config`);
    assert.notEqual(fresh.headers.get('set-cookie').split(';', 1)[0], cookie);
  } finally {
    await fixture.manager.shutdown();
    await new Promise((resolve) => fixture.app.server.close(resolve));
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('active reset conflicts and session capacity maps to 503', async () => {
  const fixture = await createMultiUserApp({ managerOptions: { maxContexts: 1 } });
  try {
    const cookie = await newBrowser(fixture.baseUrl);
    const profile = { trainerName: 'ActiveUser', trainerCode: '111122223333', level: 50, countryCode: 'se' };
    await request(fixture.baseUrl, cookie, '/api/autojoin/start', { method: 'POST', body: JSON.stringify({ ranks: ['5'], pokemon: ['Giratina'], profile }) });
    assert.equal((await request(fixture.baseUrl, cookie, '/api/session/reset', { method: 'POST' })).status, 409);
    assert.equal((await fetch(`${fixture.baseUrl}/api/config`)).status, 503);
  } finally {
    await fixture.manager.shutdown();
    await new Promise((resolve) => fixture.app.server.close(resolve));
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('SSE enforces per-session limits, sends heartbeats, and releases disconnected clients', async () => {
  const fixture = await createMultiUserApp({ managerOptions: { sessionSseLimit: 1 }, appOptions: { sseHeartbeatMs: 5 } });
  const firstController = new AbortController();
  try {
    const cookie = await newBrowser(fixture.baseUrl);
    const first = await fetch(`${fixture.baseUrl}/api/events`, { headers: { cookie }, signal: firstController.signal });
    assert.equal(first.status, 200);
    const reader = first.body.getReader();
    const initial = new TextDecoder().decode((await reader.read()).value);
    assert.match(initial, /event: status/);
    let heartbeat = '';
    for (let index = 0; index < 5 && !heartbeat.includes(': heartbeat'); index += 1) heartbeat += new TextDecoder().decode((await reader.read()).value);
    assert.match(heartbeat, /: heartbeat/);
    assert.equal((await fetch(`${fixture.baseUrl}/api/events`, { headers: { cookie } })).status, 429);
    firstController.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const replacementController = new AbortController();
    const replacement = await fetch(`${fixture.baseUrl}/api/events`, { headers: { cookie }, signal: replacementController.signal });
    assert.equal(replacement.status, 200);
    replacementController.abort();
  } finally {
    firstController.abort();
    await fixture.manager.shutdown();
    await new Promise((resolve) => fixture.app.server.close(resolve));
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('an in-flight request lease prevents max-capacity eviction until the handler finishes', { timeout: 5_000 }, async () => {
  let releaseRaids;
  let raidsStarted;
  const started = new Promise((resolve) => { raidsStarted = resolve; });
  const fixture = await createMultiUserApp({ managerOptions: { maxContexts: 1 } });
  try {
    const firstCookie = await newBrowser(fixture.baseUrl);
    fixture.adapters[0].hasToken = () => true;
    fixture.adapters[0].listCurrentRaidBosses = async () => {
      raidsStarted();
      await new Promise((resolve) => { releaseRaids = resolve; });
      return [];
    };
    const inFlight = request(fixture.baseUrl, firstCookie, '/api/raids');
    await started;

    const blocked = await fetch(`${fixture.baseUrl}/api/config`);
    assert.equal(blocked.status, 503);
    assert.equal((await readdir(join(fixture.root, 'sessions'))).length, 1);

    releaseRaids();
    assert.equal((await inFlight).status, 200);
    const admitted = await fetch(`${fixture.baseUrl}/api/config`);
    assert.equal(admitted.status, 200);
    assert.equal((await readdir(join(fixture.root, 'sessions'))).length, 1);
  } finally {
    releaseRaids?.();
    await fixture.manager.shutdown();
    await new Promise((resolve) => fixture.app.server.close(resolve));
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('request leases are released after handler errors', async () => {
  const fixture = await createMultiUserApp({ managerOptions: { maxContexts: 1 } });
  try {
    const firstCookie = await newBrowser(fixture.baseUrl);
    fixture.adapters[0].hasToken = () => true;
    fixture.adapters[0].listCurrentRaidBosses = async () => { throw new Error('expected failure'); };
    assert.equal((await request(fixture.baseUrl, firstCookie, '/api/raids')).status, 500);
    assert.equal((await fetch(`${fixture.baseUrl}/api/config`)).status, 200);
    assert.equal((await readdir(join(fixture.root, 'sessions'))).length, 1);
  } finally {
    await fixture.manager.shutdown();
    await new Promise((resolve) => fixture.app.server.close(resolve));
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('push config is stateless and exposes no VAPID private material', async () => {
  const fixture = await createMultiUserApp({
    appOptions: {
      pushNotifier: {
        enabled: true,
        publicConfig: () => ({ enabled: true, publicKey: 'public-key-only' }),
        async send() { return { delivered: true, terminal: false, statusCode: null }; }
      }
    }
  });
  try {
    const response = await fetch(`${fixture.baseUrl}/api/push/config`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(await response.json(), { enabled: true, publicKey: 'public-key-only' });
    assert.deepEqual(await readdir(join(fixture.root, 'sessions')), []);
  } finally {
    await fixture.manager.shutdown();
    await new Promise((resolve) => fixture.app.server.close(resolve));
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('push subscriptions validate, deduplicate, cap, isolate, persist, and remove by safe id', async () => {
  const fixture = await createMultiUserApp({
    managerOptions: { pushNotifier: { enabled: true, async send() { return { delivered: true, terminal: false, statusCode: null }; } } },
    appOptions: { pushNotifier: { enabled: true, publicConfig: () => ({ enabled: true, publicKey: 'public' }) } }
  });
  try {
    const firstCookie = await newBrowser(fixture.baseUrl);
    const secondCookie = await newBrowser(fixture.baseUrl);
    const invalid = await request(fixture.baseUrl, firstCookie, '/api/push/subscriptions', {
      method: 'POST', body: JSON.stringify({ ...pushSubscription(), endpoint: 'http://push.example.test/nope' })
    });
    assert.equal(invalid.status, 400);

    const added = await request(fixture.baseUrl, firstCookie, '/api/push/subscriptions', {
      method: 'POST', body: JSON.stringify(pushSubscription('same'))
    });
    assert.equal(added.status, 201);
    const addedBody = await added.json();
    assert.deepEqual(Object.keys(addedBody).sort(), ['id', 'subscribed']);
    assert.equal(JSON.stringify(addedBody).includes('push.example'), false);
    assert.equal(JSON.stringify(addedBody).includes('BBBB'), false);

    const deduped = await request(fixture.baseUrl, firstCookie, '/api/push/subscriptions', {
      method: 'POST', body: JSON.stringify(pushSubscription('same'))
    });
    assert.equal(deduped.status, 200);
    for (const suffix of ['two', 'three', 'four']) {
      assert.ok([200, 201].includes((await request(fixture.baseUrl, firstCookie, '/api/push/subscriptions', {
        method: 'POST', body: JSON.stringify(pushSubscription(suffix))
      })).status));
    }
    assert.equal((await request(fixture.baseUrl, firstCookie, '/api/push/subscriptions', {
      method: 'POST', body: JSON.stringify(pushSubscription('five'))
    })).status, 409);

    const files = await readdir(join(fixture.root, 'sessions'));
    assert.equal(files.length, 2);
    const states = await Promise.all(files.map(async (file) => JSON.parse(await readFile(join(fixture.root, 'sessions', file), 'utf8'))));
    assert.deepEqual(states.map((state) => state.pushSubscriptions?.length ?? 0).sort(), [0, 4]);

    const removed = await request(fixture.baseUrl, firstCookie, '/api/push/subscriptions', {
      method: 'DELETE', body: JSON.stringify({ id: addedBody.id })
    });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { removed: true });
    assert.equal((await request(fixture.baseUrl, secondCookie, '/api/push/subscriptions', {
      method: 'DELETE', body: JSON.stringify({ id: addedBody.id })
    })).status, 404);
  } finally {
    await fixture.manager.shutdown();
    await new Promise((resolve) => fixture.app.server.close(resolve));
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('persisted push delivery job suppresses the same durable raid after a session-manager restart', async () => {
  const deliveries = [];
  const notifier = { enabled: true, async send() { deliveries.push('sent'); return { delivered: true, terminal: false, statusCode: null }; } };
  const appPush = { enabled: true, publicConfig: () => ({ enabled: true, publicKey: 'public' }) };
  const first = await createMultiUserApp({ managerOptions: { pushNotifier: notifier }, appOptions: { pushNotifier: appPush } });
  const root = first.root;
  let second;
  try {
    const cookie = await newBrowser(first.baseUrl);
    assert.equal((await request(first.baseUrl, cookie, '/api/push/subscriptions', {
      method: 'POST', body: JSON.stringify(pushSubscription('restart'))
    })).status, 201);
    await first.workers[0].match({ rpl_id: 'durable-raid' });
    await waitFor(() => deliveries.length === 1);
    await first.manager.shutdown();
    await new Promise((resolve) => first.app.server.close(resolve));

    second = await createMultiUserApp({ root, managerOptions: { pushNotifier: notifier }, appOptions: { pushNotifier: appPush } });
    assert.equal((await request(second.baseUrl, cookie, '/api/config')).status, 200);
    await second.workers[0].match({ rpl_id: 'durable-raid' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(deliveries.length, 1);
  } finally {
    if (second) {
      await second.manager.shutdown();
      await new Promise((resolve) => second.app.server.close(resolve));
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('matched push is durable, asynchronous, duplicate-suppressed, and prunes only terminal subscriptions', async () => {
  const deliveries = [];
  const notifier = {
    enabled: true,
    async send(subscription) {
      deliveries.push(subscription.endpoint);
      if (subscription.endpoint.endsWith('/gone')) return { delivered: false, terminal: true, statusCode: 410 };
      if (subscription.endpoint.endsWith('/transient')) return { delivered: false, terminal: false, statusCode: 503 };
      return { delivered: true, terminal: false, statusCode: null };
    }
  };
  const fixture = await createMultiUserApp({
    managerOptions: { pushNotifier: notifier },
    appOptions: { pushNotifier: { enabled: true, publicConfig: () => ({ enabled: true, publicKey: 'public' }) } }
  });
  try {
    const cookie = await newBrowser(fixture.baseUrl);
    for (const suffix of ['ok', 'gone', 'transient']) {
      assert.equal((await request(fixture.baseUrl, cookie, '/api/push/subscriptions', {
        method: 'POST', body: JSON.stringify(pushSubscription(suffix))
      })).status, 201);
    }
    const [file] = await readdir(join(fixture.root, 'sessions'));
    const path = join(fixture.root, 'sessions', file);
    await fixture.workers[0].match({ rpl_id: 'raid-1', rpl_pokemon: 'SecretBoss', rpl_code: '123456789012' });

    await waitFor(() => deliveries.length === 3);
    await fixture.workers[0].match({ rpl_id: 'raid-1', rpl_pokemon: 'SecretBoss', rpl_code: '123456789012' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(deliveries.length, 3);

    const persisted = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(persisted.pushDeliveryJobs.length, 1);
    assert.match(persisted.pushDeliveryJobs[0].marker, /^[a-f0-9]{64}$/);
    assert.equal(persisted.pushDeliveryJobs[0].pending.length, 1);
    assert.equal(persisted.pushDeliveryJobs[0].pending[0].attempts, 1);
    assert.equal(persisted.pushDeliveryJobs[0].completed.length, 2);
    assert.equal(persisted.pushSubscriptions.length, 2);
    assert.ok(persisted.pushSubscriptions.some((subscription) => subscription.endpoint.endsWith('/transient')));
    assert.ok(persisted.pushSubscriptions.some((subscription) => subscription.endpoint.endsWith('/ok')));
  } finally {
    await fixture.manager.shutdown();
    await new Promise((resolve) => fixture.app.server.close(resolve));
    await rm(fixture.root, { recursive: true, force: true });
  }
});
