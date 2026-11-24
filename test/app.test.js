import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { MockRaidNowAdapter } from '../src/adapters/mock-raidnow-adapter.js';
import { CliCommandError } from '../src/adapters/cli-process-runner.js';

async function startTestApp(adapter, options = {}) {
  let state = { profile: {}, preferences: {}, autoJoin: null };
  const store = {
    get() { return structuredClone(state); },
    async update(patch) { state = { ...state, ...patch }; return this.get(); }
  };
  const app = createApp({ adapter, store, pollIntervalMs: 5, scanIntervalMs: 1, publicDir: new URL('../public/', import.meta.url), ...options });
  await app.ready;
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  return { ...app, baseUrl: `http://127.0.0.1:${address.port}`, readStore: () => structuredClone(state) };
}

async function close(app) {
  await app.worker.stop();
  app.worker.shutdown?.();
  await new Promise((resolve) => app.server.close(resolve));
}

test('saves and returns a normalized profile', async () => {
  const app = await startTestApp({ async listRaids() { return []; } });
  try {
    const saved = await fetch(`${app.baseUrl}/api/profile`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trainerName: 'Albin123', trainerCode: '1234 5678 9012', level: '50', countryCode: 'SE' })
    });
    assert.equal(saved.status, 200);
    const loaded = await fetch(`${app.baseUrl}/api/profile`).then((r) => r.json());
    assert.equal(loaded.trainerCode, '123456789012');
    assert.equal(loaded.countryCode, 'se');
  } finally { await close(app); }
});

test('initializes the upstream live profile when the adapter supports it', async () => {
  let upstreamProfile = null;
  const app = await startTestApp({
    async listRaids() { return []; },
    async updateProfile(profile) { upstreamProfile = profile; return {}; }
  });
  try {
    const response = await fetch(`${app.baseUrl}/api/profile`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trainerName: 'Albin123', trainerCode: '123456789012', level: 50, countryCode: 'se' })
    });
    assert.equal(response.status, 200);
    assert.equal(upstreamProfile.trainerName, 'Albin123');
  } finally { await close(app); }
});

test('non-numeric upstream status returns a generic 500 without crashing the server', async () => {
  const app = await startTestApp({
    async updateProfile() {
      throw Object.assign(new Error('Upstream failed.'), { status: 'failed' });
    }
  });
  try {
    const response = await fetch(`${app.baseUrl}/api/profile`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trainerName: 'Albin123', trainerCode: '123456789012', level: 50, countryCode: 'se' })
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { message: 'Ett internt fel uppstod.' });
    assert.equal((await fetch(`${app.baseUrl}/api/health`)).status, 200);
  } finally { await close(app); }
});

test('logs in without returning or storing the password in the browser response', async () => {
  const app = await startTestApp({
    async listRaids() { return []; },
    async login() {
      return { status: 'success', token: 'token-123', rplu_tid: 'Albin123', rplu_level: 50, rplu_code: '123456789012', rplu_country_code: 'se' };
    }
  });
  try {
    const response = await fetch(`${app.baseUrl}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', password: 'secret' })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.profile.trainerName, 'Albin123');
    assert.equal('token' in body, false);
    assert.equal(JSON.stringify(body).includes('secret'), false);
  } finally { await close(app); }
});

test('imports an anonymous Raid NOW token without echoing it', async () => {
  let imported = '';
  const app = await startTestApp({
    setToken(token) { imported = token; },
    hasToken() { return Boolean(imported); },
    async listRaids() { return []; }
  });
  try {
    const response = await fetch(`${app.baseUrl}/api/session/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'anonymous-token' })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.connected, true);
    assert.equal(JSON.stringify(body).includes('anonymous-token'), false);
    assert.equal(imported, 'anonymous-token');
  } finally { await close(app); }
});

test('anonymous-only mode advertises its API policy', async () => {
  const app = await startTestApp({ async listRaids() { return []; } }, { anonymousOnly: true });
  try {
    const response = await fetch(`${app.baseUrl}/api/config`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).anonymousOnly, true);
  } finally { await close(app); }
});

test('anonymous-only mode hides login and token import before parsing request bodies', async () => {
  let loginCalls = 0;
  let importCalls = 0;
  let state = { profile: {}, autoJoin: null, account: { token: 'existing-token', email: 'existing@example.com' } };
  const store = {
    get() { return structuredClone(state); },
    async update(patch) { state = { ...state, ...patch }; return this.get(); }
  };
  const app = createApp({
    adapter: {
      async login() { loginCalls += 1; return { status: 'success', token: 'replacement-token' }; },
      setToken() { importCalls += 1; }
    },
    store,
    anonymousOnly: true,
    maxBodyBytes: 8,
    publicDir: new URL('../public/', import.meta.url)
  });
  await app.ready;
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const responses = await Promise.all([
      fetch(`${baseUrl}/api/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{malformed'
      }),
      fetch(`${baseUrl}/api/session/import`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'oversize-token' })
      })
    ]);
    for (const response of responses) {
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { message: 'Not found.' });
    }
    assert.equal(loginCalls, 0);
    assert.equal(importCalls, 0);
    assert.deepEqual(state.account, { token: 'existing-token', email: 'existing@example.com' });
  } finally {
    app.worker.shutdown();
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test('rejects invalid profiles without saving them', async () => {
  const app = await startTestApp({ async listRaids() { return []; } });
  try {
    const response = await fetch(`${app.baseUrl}/api/profile`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trainerName: 'x' })
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.ok(body.errors.trainerCode);
  } finally { await close(app); }
});

test('returns the complete Auto Join boss list instead of homepage raid posts', async () => {
  let homepageListCalled = false;
  const app = await startTestApp({
    hasToken() { return true; },
    async listRaids() { homepageListCalled = true; return []; },
    async listCurrentRaidBosses() {
      return [
        { rank: '5', pokemon: 'ザシアン(けんのおう)', displayName: 'Zacian (Crowned Sword)', image: 'https://example.test/zacian.png' },
        { rank: '3', pokemon: 'ピカチュウ', displayName: 'Pikachu', image: 'https://example.test/pikachu.png' }
      ];
    }
  });
  try {
    const response = await fetch(`${app.baseUrl}/api/raids`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.bosses.length, 2);
    assert.equal(body.bosses[0].displayName, 'Zacian (Crowned Sword)');
    assert.equal('activeRaids' in body.bosses[0], false);
    assert.equal(homepageListCalled, false);
  } finally { await close(app); }
});

test('returns the Auto Join boss list without an account or imported token', async () => {
  let catalogCalls = 0;
  const app = await startTestApp({
    hasToken() { return false; },
    async listCurrentRaidBosses() {
      catalogCalls += 1;
      return [{ rank: '5', pokemon: 'ミュウツー', displayName: 'Mewtwo', image: '' }];
    }
  });
  try {
    const response = await fetch(`${app.baseUrl}/api/raids`);
    assert.equal(response.status, 200);
    assert.equal(catalogCalls, 1);
    const body = await response.json();
    assert.equal(body.bosses[0].displayName, 'Mewtwo');
  } finally { await close(app); }
});

test('returns upstream session failures from the catalog route as 401 recovery errors', async () => {
  const app = await startTestApp({
    async listCurrentRaidBosses() {
      throw Object.assign(new Error('The session has expired. Please restart.'), { status: 401 });
    }
  });
  try {
    const response = await fetch(`${app.baseUrl}/api/raids`);
    assert.equal(response.status, 401);
    assert.match((await response.json()).message, /session has expired/i);
  } finally { await close(app); }
});

test('rejects unsupported search filter values before starting a durable worker', async () => {
  let createCalls = 0;
  const adapter = {
    async createMatching() { createCalls += 1; return { status: 'success' }; },
    async cancelMatching() { return { status: 'success' }; },
    async checkMatching() { return { status: 'success', id: '' }; }
  };
  const app = await startTestApp(adapter);
  try {
    await fetch(`${app.baseUrl}/api/profile`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trainerName: 'Albin123', trainerCode: '123456789012', level: 50, countryCode: 'se' })
    });
    const response = await fetch(`${app.baseUrl}/api/autojoin/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ranks: ['5'], pokemon: ['Giratina'], hostLevel: 5 })
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /host level/i);
    assert.equal(createCalls, 0);
  } finally { await close(app); }
});

test('starts server-owned Auto Join and reaches matched state', async () => {
  let polls = 0;
  const adapter = {
    async listRaids() { return [{ rpl_id: '1', rpl_rank: '5', rpl_pokemon: 'Giratina' }]; },
    async listRaidsForSelection() { return []; },
    async joinRaidFast() { return { status: 'error', text: 'No direct candidate expected.' }; },
    async createMatching() { return { status: 'success' }; },
    async pollMatching() { polls++; return polls < 2 ? { status: 'success', rpllm_status: 1 } : { status: 'success', rpllm_status: 2, rpllm_rpl_id: '1' }; },
    async findRaid() { return { rpl_id: '1', rpl_pokemon: 'Giratina', rpl_code: '999988887777' }; },
    async cancelMatching() { return { status: 'success' }; }
  };
  const app = await startTestApp(adapter);
  try {
    await fetch(`${app.baseUrl}/api/profile`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trainerName: 'Albin123', trainerCode: '123456789012', level: 50, countryCode: 'se' }) });
    const started = await fetch(`${app.baseUrl}/api/autojoin/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ranks: ['5'], pokemon: ['Giratina'] }) });
    assert.equal(started.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const status = await fetch(`${app.baseUrl}/api/autojoin/status`).then((r) => r.json());
    assert.equal(status.state, 'matched');
    assert.equal(status.raid.rpl_pokemon, 'Giratina');
  } finally { await close(app); }
});

test('allows a new Auto Join attempt after a terminal start rejection with no remaining resources', async () => {
  let attempts = 0;
  const adapter = new MockRaidNowAdapter();
  adapter.createMatching = async () => {
    attempts += 1;
    if (attempts === 1) return { status: 'error', text: 'Within 2 mins, you have recruited or participated in a raid. Check the list and try again later.' };
    return { status: 'success' };
  };
  const app = await startTestApp(adapter);
  const body = {
    ranks: ['5'],
    pokemon: ['Giratina'],
    strategy: 'hybrid',
    profile: { trainerName: 'Albin123', trainerCode: '123456789012', level: 50, countryCode: 'se' }
  };
  try {
    const profile = await fetch(`${app.baseUrl}/api/profile`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body.profile)
    });
    assert.equal(profile.status, 200);
    const first = await fetch(`${app.baseUrl}/api/autojoin/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    assert.equal(first.status, 200);
    for (let attempt = 0; attempt < 50 && app.worker.status().state !== 'error'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(app.worker.status().state, 'error');

    const second = await fetch(`${app.baseUrl}/api/autojoin/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    assert.equal(second.status, 200);
    assert.equal(attempts, 2);
  } finally { await close(app); }
});

test('default app persists durable actor snapshots instead of public status', async () => {
  const adapter = {
    async listRaids() { return []; },
    async listRaidsForSelection() { return []; },
    async joinRaidFast() { return { status: 'error', text: 'No direct candidate expected.' }; },
    async createMatching() { return { status: 'success' }; },
    async pollMatching() { return { status: 'success', rpllm_status: 1 }; }
  };
  const app = await startTestApp(adapter);
  try {
    await fetch(`${app.baseUrl}/api/profile`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trainerName: 'Albin123', trainerCode: '123456789012', level: 50, countryCode: 'se' }) });
    await fetch(`${app.baseUrl}/api/autojoin/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ranks: ['5'], pokemon: ['Giratina'] }) });
    assert.equal(app.readStore().autoJoin.schemaVersion, 2);
    assert.equal(app.readStore().autoJoin.intent, 'search');
  } finally { await close(app); }
});

test('default app restores persisted Auto Join before readiness resolves', async () => {
  let state = {
    profile: {},
    autoJoin: { state: 'matched', raid: { rpl_id: 'restored-raid', rpl_pokemon: 'Giratina' } }
  };
  const store = {
    get() { return structuredClone(state); },
    async update(patch) { state = { ...state, ...patch }; return this.get(); }
  };
  const app = createApp({ adapter: {}, store, publicDir: new URL('../public/', import.meta.url) });
  await app.ready;
  assert.equal(app.worker.status().state, 'matched');
  assert.equal(app.worker.status().raid.rpl_id, 'restored-raid');
  app.worker.shutdown();
});

test('default app observes worker errors without logging secret details', async () => {
  const logged = [];
  const store = { get: () => ({ autoJoin: null }), async update() {} };
  const app = createApp({
    adapter: {},
    store,
    logger: { error(...args) { logged.push(args); } },
    publicDir: new URL('../public/', import.meta.url)
  });
  await app.ready;
  const error = new Error('secret-token trainer 123456789012');
  error.name = 'SecretToken';
  app.worker.emit('workerError', error);
  assert.equal(logged.length, 1);
  const output = JSON.stringify(logged[0]);
  assert.match(output, /Auto Join worker failed/);
  assert.equal(output.includes('secret-token'), false);
  assert.equal(output.includes('SecretToken'), false);
  assert.equal(output.includes('123456789012'), false);
  app.worker.shutdown();
});

test('restore-locked sessions expose a generic status and reject destructive lifecycle calls', async () => {
  let starts = 0;
  let imports = 0;
  const context = {
    restoreError: { code: 'Error', state: 'locked' },
    adapter: { setToken() { imports += 1; } },
    store: { get: () => ({ profile: {} }), async update() {} },
    clients: new Set(),
    worker: {
      status: () => ({ state: 'idle' }),
      async start() { starts += 1; return { state: 'searching' }; }
    }
  };
  const sessionManager = {
    ready: async () => {},
    resolve: async () => context
  };
  const app = createApp({ sessionManager, publicDir: new URL('../public/', import.meta.url) });
  await app.ready;
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const status = await fetch(`${baseUrl}/api/autojoin/status`);
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { state: 'error', error: 'Auto Join restore failed; saved work remains locked for retry.' });
    const started = await fetch(`${baseUrl}/api/autojoin/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ranks: ['5'], pokemon: ['Giratina'], profile: { trainerName: 'Albin123', trainerCode: '123456789012', level: 50, countryCode: 'se' } })
    });
    assert.equal(started.status, 409);
    assert.equal(starts, 0);

    const imported = await fetch(`${baseUrl}/api/session/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'replacement-token' })
    });
    assert.equal(imported.status, 409);
    assert.equal(imports, 0);

    const controller = new AbortController();
    const events = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
    const reader = events.body.getReader();
    try {
      const firstEvent = new TextDecoder().decode((await reader.read()).value);
      assert.match(firstEvent, /"state":"error"/);
      assert.equal(firstEvent.includes('SecretTrainer'), false);
    } finally {
      controller.abort();
    }
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test('refreshes exact raid details so direct matches expose the host trainer code and QR payload', async () => {
  let exactLookups = 0;
  const adapter = {
    async createMatching() { return { status: 'success' }; },
    async listRaidsForSelection() {
      return [{ rpl_id: 'direct-raid', rpl_rank: '5', rpl_pokemon: 'Giratina', rpl_tid: 'HostOne' }];
    },
    async joinRaidFast() { return { status: 'success' }; },
    async findRaid() {
      exactLookups += 1;
      return { rpl_id: 'direct-raid', rpl_pokemon: 'Giratina', rpl_tid: 'HostOne', rpl_code: '999988887777' };
    },
    async listRaidPlayers() { return { players: [], count: 1, readyCount: 0 }; }
  };
  const app = await startTestApp(adapter);
  try {
    await fetch(`${app.baseUrl}/api/profile`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trainerName: 'Albin123', trainerCode: '123456789012', level: 50, countryCode: 'se' }) });
    await fetch(`${app.baseUrl}/api/autojoin/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ranks: ['5'], pokemon: ['Giratina'], strategy: 'hybrid' }) });
    for (let attempt = 0; attempt < 50 && app.worker.status().state !== 'matched'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(app.worker.status().state, 'matched');
    const details = await fetch(`${app.baseUrl}/api/active-raid`).then((response) => response.json());
    assert.equal(details.raid.rpl_code, '999988887777');
    assert.ok(exactLookups >= 1);
  } finally { await close(app); }
});

test('ended active raid returns a recovery response and resumes the saved search', async () => {
  const adapter = {
    async findRaid() { return null; },
    async listRaidPlayers() { throw new Error('Player list rejected.'); },
    async checkMatching() { return {}; },
    async createMatching() { return { status: 'success' }; },
    async pollMatching() { return {}; },
    async listRaidsForSelection() { return []; }
  };
  const app = await startTestApp(adapter);
  try {
    await app.worker.restore({
      schemaVersion: 2,
      intent: 'search',
      startedAt: '2026-11-21T20:00:00.000Z',
      search: {
        profile: { trainerName: 'Albin123', trainerCode: '123456789012', level: 50, countryCode: 'se' },
        selection: { strategy: 'hybrid', ranks: ['5'], pokemon: ['Giratina'] },
        nextQueuePollAt: null,
        attemptedRaids: {}
      },
      queue: { state: 'unknown' },
      raid: { state: 'matched', target: 'raid-ended', value: { rpl_id: 'raid-ended', rpl_pokemon: 'Giratina' } },
      operation: null,
      wake: { kind: 'revalidateMatched', dueAt: new Date(Date.now() + 60_000).toISOString() },
      terminal: { target: 'matched', error: null },
      lastContactAt: null,
      retryCount: 0,
      lastError: null,
      opSequence: 2
    });
    const response = await fetch(`${app.baseUrl}/api/active-raid`);
    assert.equal(response.status, 410);
    const body = await response.json();
    assert.equal(body.code, 'RAID_ENDED');
    assert.match(body.message, /sökningen återupptas/i);
    assert.notEqual(app.worker.status().state, 'matched');
    assert.deepEqual(app.worker.status().selection.pokemon, ['Giratina']);
    assert.equal(app.worker.status().workflowNotice.kind, 'raid-ended');
  } finally { await close(app); }
});

test('active raid player refresh survives an exact-detail lookup failure', async () => {
  const adapter = {
    async createMatching() { return { status: 'success' }; },
    async listRaidsForSelection() {
      return [{ rpl_id: 'raid-1', rpl_rank: '5', rpl_pokemon: 'Giratina', rpl_tid: 'HostOne' }];
    },
    async joinRaidFast() { return { status: 'success' }; },
    async findRaid() { throw new Error('Exact lookup failed.'); },
    async listRaidPlayers() { return { players: [{ trainerName: 'PlayerOne', level: 50, isMe: true }], count: 1, readyCount: 0 }; }
  };
  const app = await startTestApp(adapter);
  try {
    await fetch(`${app.baseUrl}/api/profile`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trainerName: 'Albin123', trainerCode: '123456789012', level: 50, countryCode: 'se' }) });
    await fetch(`${app.baseUrl}/api/autojoin/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ranks: ['5'], pokemon: ['Giratina'] }) });
    for (let attempt = 0; attempt < 50 && app.worker.status().state !== 'matched'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const response = await fetch(`${app.baseUrl}/api/active-raid`);
    assert.equal(response.status, 200);
    const details = await response.json();
    assert.equal(details.players[0].trainerName, 'PlayerOne');
  } finally { await close(app); }
});

test('reconciles an unknown ready write before allowing another attempt', async (t) => {
  for (const scenario of [
    { name: 'already ready', players: [{ isMe: true, ready: 1 }], status: 200, body: { ready: true, reconciled: true } },
    { name: 'definitively not ready', players: [{ isMe: true, ready: 0 }], status: 409, body: { code: 'READY_NOT_CONFIRMED', retryAllowed: true } },
    { name: 'guest missing from reconciliation read', players: [], status: 409, body: { code: 'READY_OUTCOME_UNKNOWN', retryAllowed: false } }
  ]) {
    await t.test(scenario.name, async () => {
      const adapter = {
        async createMatching() { return { status: 'success' }; },
        async listRaidsForSelection() { return [{ rpl_id: 'raid-1', rpl_rank: '5', rpl_pokemon: 'Giratina', rpl_tid: 'HostOne' }]; },
        async joinRaidFast() { return { status: 'success' }; },
        async markRaidReady() {
          throw new CliCommandError({ code: 'WRITE_OUTCOME_UNKNOWN', exitCode: 9, command: 'raid ready', status: 'failed', message: 'Write outcome is unknown.' });
        },
        async listRaidPlayers() { return { players: scenario.players, count: scenario.players.length, readyCount: scenario.players.filter((player) => player.ready).length }; }
      };
      const app = await startTestApp(adapter);
      try {
        await fetch(`${app.baseUrl}/api/profile`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trainerName: 'Albin123', trainerCode: '123456789012', level: 50, countryCode: 'se' }) });
        await fetch(`${app.baseUrl}/api/autojoin/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ranks: ['5'], pokemon: ['Giratina'] }) });
        for (let attempt = 0; attempt < 50 && app.worker.status().state !== 'matched'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
        const response = await fetch(`${app.baseUrl}/api/active-raid/ready`, { method: 'POST' });
        assert.equal(response.status, scenario.status);
        const body = await response.json();
        for (const [key, value] of Object.entries(scenario.body)) assert.equal(body[key], value);
      } finally { await close(app); }
    });
  }
});

test('returns active raid players, marks the guest ready, and lets the guest leave', async () => {
  let readyId = null;
  let leftId = null;
  const adapter = {
    async listRaids() { return []; },
    async listRaidsForSelection() { return []; },
    async joinRaidFast() { return { status: 'error', text: 'No direct candidate expected.' }; },
    async createMatching() { return { status: 'success' }; },
    async pollMatching() { return { status: 'success', rpllm_status: 2, rpllm_rpl_id: 'raid-1' }; },
    async findRaid() { return { rpl_id: 'raid-1', rpl_pokemon: 'Giratina', rpl_tid: 'HostOne', rpl_code: '999988887777' }; },
    async listRaidPlayers() { return { players: [{ trainerName: 'PlayerOne', level: 50, isMe: true }], count: 1, readyCount: 0 }; },
    async markRaidReady(id) { readyId = id; return { status: 'success' }; },
    async leaveRaid(id) { leftId = id; return { status: 'success' }; }
  };
  const app = await startTestApp(adapter);
  try {
    await fetch(`${app.baseUrl}/api/profile`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trainerName: 'Albin123', trainerCode: '123456789012', level: 50, countryCode: 'se' }) });
    await fetch(`${app.baseUrl}/api/autojoin/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ranks: ['5'], pokemon: ['Giratina'] }) });
    await new Promise((resolve) => setTimeout(resolve, 15));
    const active = await fetch(`${app.baseUrl}/api/active-raid`);
    assert.equal(active.status, 200);
    const details = await active.json();
    assert.equal(details.raid.rpl_tid, 'HostOne');
    assert.equal(details.players[0].trainerName, 'PlayerOne');

    const ready = await fetch(`${app.baseUrl}/api/active-raid/ready`, { method: 'POST' });
    assert.equal(ready.status, 200);
    assert.equal(readyId, 'raid-1');
    assert.deepEqual(await ready.json(), { ready: true });

    const left = await fetch(`${app.baseUrl}/api/active-raid/leave`, { method: 'POST' });
    assert.equal(left.status, 200);
    assert.equal(leftId, 'raid-1');
    assert.equal((await left.json()).state, 'idle');
  } finally { await close(app); }
});

test('demo route leaves a deterministic mock match and returns idle', async () => {
  const app = await startTestApp(new MockRaidNowAdapter({ matchAfterPolls: 1 }));
  try {
    const profile = { trainerName: 'Albin123', trainerCode: '123456789012', level: 50, countryCode: 'se' };
    await fetch(`${app.baseUrl}/api/profile`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(profile) });
    const raid = (await fetch(`${app.baseUrl}/api/raids`).then((response) => response.json())).bosses[0];
    await fetch(`${app.baseUrl}/api/autojoin/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ranks: [raid.rank], pokemon: raid.pokemon })
    });
    for (let attempt = 0; attempt < 50 && app.worker.status().state !== 'matched'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(app.worker.status().state, 'matched');

    const response = await fetch(`${app.baseUrl}/api/active-raid/leave`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state, 'idle');
  } finally { await close(app); }
});

test('leave route probes unknown durable raid membership before writing', async () => {
  let leftId = null;
  const order = [];
  const app = await startTestApp({
    async findRaid(id) { order.push(`probe:${id}`); return { rpl_id: id, join: 1 }; },
    async listRaidPlayers(id) { order.push(`players:${id}`); return { players: [] }; },
    async leaveRaid(id) { order.push(`leave:${id}`); leftId = id; return { status: 'success' }; }
  });
  try {
    await app.worker.restore({
      schemaVersion: 2,
      intent: 'search',
      startedAt: '2026-11-24T10:00:00.000Z',
      search: null,
      queue: { state: 'none' },
      raid: { state: 'unknown', target: 'raid-unknown', value: { rpl_id: 'raid-unknown', rpl_pokemon: 'Giratina' } },
      operation: null,
      wake: { kind: 'reconcileRaid', dueAt: new Date(Date.now() + 60_000).toISOString() },
      terminal: { target: 'searching', error: null },
      lastContactAt: null,
      retryCount: 1,
      lastError: 'Membership check timed out.',
      abandonQueueAfterLeave: false,
      leaveQueueCancelRejections: 0,
      opSequence: 3
    });

    const before = await fetch(`${app.baseUrl}/api/autojoin/status`).then((response) => response.json());
    assert.equal(before.canRequestLeave, true);
    assert.equal(before.raidMembership, 'unknown');

    const response = await fetch(`${app.baseUrl}/api/active-raid/leave`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.deepEqual(order, ['probe:raid-unknown', 'players:raid-unknown', 'leave:raid-unknown']);
    assert.equal(leftId, 'raid-unknown');
    assert.equal((await response.json()).state, 'idle');
  } finally { await close(app); }
});

test('leave route completes absent membership recovery without write capability', async () => {
  const reads = [];
  const app = await startTestApp({
    async findRaid(id) { reads.push(`exact:${id}`); return { rpl_id: id, join: 0 }; },
    async listRaidPlayers(id) { reads.push(`players:${id}`); return { players: [], raidDeleted: false }; }
  });
  try {
    await app.worker.restore({
      schemaVersion: 2,
      intent: 'search',
      queue: { state: 'none' },
      raid: { state: 'unknown', target: 'raid-read-only', value: { rpl_id: 'raid-read-only' } },
      operation: null,
      wake: { kind: 'reconcileRaid', dueAt: new Date(Date.now() + 60_000).toISOString() },
      terminal: { target: 'searching', error: null }
    });

    const response = await fetch(`${app.baseUrl}/api/active-raid/leave`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state, 'idle');
    assert.deepEqual(reads.sort(), ['exact:raid-read-only', 'players:raid-read-only']);
  } finally { await close(app); }
});

test('leave route returns typed 501 after reads confirm a write is required', async () => {
  const reads = [];
  const app = await startTestApp({
    async findRaid(id) { reads.push(`exact:${id}`); return { rpl_id: id, join: 1 }; },
    async listRaidPlayers(id) { reads.push(`players:${id}`); return { players: [], raidDeleted: false }; }
  });
  try {
    await app.worker.restore({
      schemaVersion: 2,
      intent: 'search',
      queue: { state: 'none' },
      raid: { state: 'unknown', target: 'raid-read-only', value: { rpl_id: 'raid-read-only' } },
      operation: null,
      wake: { kind: 'reconcileRaid', dueAt: new Date(Date.now() + 60_000).toISOString() },
      terminal: { target: 'searching', error: null }
    });

    const response = await fetch(`${app.baseUrl}/api/active-raid/leave`, { method: 'POST' });
    assert.equal(response.status, 501);
    assert.equal((await response.json()).code, 'AUTOJOIN_UNAVAILABLE');
    assert.deepEqual(reads.sort(), ['exact:raid-read-only', 'players:raid-read-only']);
    assert.equal(app.worker.status().state, 'matched');
    assert.equal(app.worker.status().nextRetryAt, null);
    const authoritative = await fetch(`${app.baseUrl}/api/autojoin/status`).then((result) => result.json());
    assert.deepEqual(authoritative.workflowNotice, {
      kind: 'leave-unavailable',
      severity: 'error',
      message: 'Raiden kunde inte lämnas eftersom funktionen inte är tillgänglig.'
    });
  } finally { await close(app); }
});

test('allows explicit local abandonment only for repeated safe queue uncertainty', async () => {
  const app = await startTestApp({ async checkMatching() { return { id: 'still-present' }; } });
  try {
    await app.worker.restore({
      schemaVersion: 2,
      intent: 'stop',
      startedAt: '2026-11-13T08:00:00.000Z',
      search: {
        profile: { trainerName: 'Albin123', trainerCode: '123456789012', level: 50, countryCode: 'se' },
        selection: { strategy: 'hybrid', ranks: ['5'], pokemon: ['Giratina'] },
        nextQueuePollAt: null,
        attemptedRaids: {}
      },
      queue: { state: 'unknown' },
      raid: { state: 'none', target: null, value: null },
      operation: null,
      wake: { kind: 'reconcileQueue', dueAt: new Date(Date.now() + 60_000).toISOString() },
      terminal: { target: 'stopped', error: null },
      lastContactAt: null,
      retryCount: 3,
      lastError: 'Raid NOW rejected the request.',
      opSequence: 12
    });
    const response = await fetch(`${app.baseUrl}/api/autojoin/abandon`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.state, 'idle');
    assert.equal(status.canAbandonLocal, false);
  } finally { await close(app); }
});

test('maps lifecycle conflicts and unavailable operations to stable HTTP statuses', async () => {
  const adapter = {
    async listRaids() { return []; },
    async listRaidsForSelection() { return []; },
    async joinRaidFast() { return { status: 'error', text: 'No direct candidate expected.' }; },
    async createMatching() { return { status: 'success' }; },
    async pollMatching() { return { status: 'success', rpllm_status: 1 }; }
  };
  const app = await startTestApp(adapter);
  try {
    const profile = { trainerName: 'Albin123', trainerCode: '123456789012', level: 50, countryCode: 'se' };
    await fetch(`${app.baseUrl}/api/profile`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(profile) });

    const noRaid = await fetch(`${app.baseUrl}/api/active-raid/leave`, { method: 'POST' });
    assert.equal(noRaid.status, 409);
    assert.equal((await noRaid.json()).code, 'AUTOJOIN_CONFLICT');

    const selection = { ranks: ['5'], pokemon: ['Giratina'] };
    assert.equal((await fetch(`${app.baseUrl}/api/autojoin/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(selection) })).status, 200);
    assert.equal((await fetch(`${app.baseUrl}/api/autojoin/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(selection) })).status, 409);
  } finally { await close(app); }

  const unavailable = await startTestApp({ async listRaids() { return []; } });
  try {
    const profile = { trainerName: 'Albin123', trainerCode: '123456789012', level: 50, countryCode: 'se' };
    await fetch(`${unavailable.baseUrl}/api/profile`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(profile) });
    const response = await fetch(`${unavailable.baseUrl}/api/autojoin/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ strategy: 'fast', ranks: ['5'], pokemon: ['Giratina'] })
    });
    assert.equal(response.status, 501);
  } finally { await close(unavailable); }
});

test('maps invalid and oversized JSON bodies to 400 and 413', async () => {
  const app = await startTestApp({ async listRaids() { return []; } }, { maxBodyBytes: 32 });
  try {
    const invalid = await fetch(`${app.baseUrl}/api/profile`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{bad' });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { message: 'Invalid JSON body.' });
    const oversized = await fetch(`${app.baseUrl}/api/profile`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trainerName: 'x'.repeat(100) }) });
    assert.equal(oversized.status, 413);
  } finally { await close(app); }
});

test('unexpected failures return and log only sanitized generic diagnostics', async () => {
  const secret = 'secret-token-xyz trainer-code-123456789012';
  const logged = [];
  const app = await startTestApp({
    hasToken() { return true; },
    async listCurrentRaidBosses() {
      const error = new Error(secret);
      error.name = 'SecretUpstreamFailure';
      throw error;
    }
  }, { logger: { error(...args) { logged.push(args); } } });
  try {
    const response = await fetch(`${app.baseUrl}/api/raids`);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { message: 'Ett internt fel uppstod.' });
    assert.equal(logged.length, 1);
    const diagnostic = JSON.stringify(logged[0]);
    assert.match(diagnostic, /INTERNAL_ERROR/);
    assert.equal(diagnostic.includes(secret), false);
    assert.equal(diagnostic.includes('secret-token-xyz'), false);
    assert.equal(diagnostic.includes('123456789012'), false);
    assert.equal(diagnostic.includes('SecretUpstreamFailure'), false);
  } finally { await close(app); }
});

test('adds baseline security headers to static, API, and error responses', async () => {
  const app = await startTestApp({ async listRaids() { throw new Error('upstream failed'); } });
  try {
    for (const path of ['/', '/api/health', '/api/raids']) {
      const response = await fetch(`${app.baseUrl}${path}`);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
      assert.match(response.headers.get('content-security-policy'), /worker-src 'self'/);
      assert.match(response.headers.get('content-security-policy'), /manifest-src 'self'/);
      assert.match(response.headers.get('permissions-policy'), /camera=\(\)/);
      if (path.startsWith('/api/')) assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  } finally { await close(app); }
});

test('rate limits session mutations deterministically', async () => {
  let now = 1_000;
  const app = await startTestApp({ async listRaids() { return []; } }, { mutationLimit: 2, mutationWindowMs: 1_000, now: () => now });
  try {
    const options = { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trainerName: 'x' }) };
    assert.equal((await fetch(`${app.baseUrl}/api/profile`, options)).status, 400);
    assert.equal((await fetch(`${app.baseUrl}/api/profile`, options)).status, 400);
    assert.equal((await fetch(`${app.baseUrl}/api/profile`, options)).status, 429);
    now += 1_001;
    assert.equal((await fetch(`${app.baseUrl}/api/profile`, options)).status, 400);
  } finally { await close(app); }
});
