import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { SessionManager } from '../src/core/session-manager.js';

class TestWorker extends EventEmitter {
  constructor() {
    super();
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
  activeRaid() { return null; }
  shutdown() {}
}

async function createMultiUserApp() {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-multi-app-'));
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
    workerFactory: () => {
      const worker = new TestWorker();
      workers.push(worker);
      return worker;
    }
  });
  const app = createApp({ sessionManager: manager, pollIntervalMs: 5, publicDir: new URL('../public/', import.meta.url), mode: 'live', liveWrites: true });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { app, manager, adapters, workers, root, baseUrl: `http://127.0.0.1:${app.server.address().port}` };
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
