import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../src/core/session-manager.js';

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
