import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

async function startTestApp(adapter) {
  let state = { profile: {}, preferences: {}, autoJoin: null };
  const store = {
    get() { return structuredClone(state); },
    async update(patch) { state = { ...state, ...patch }; return this.get(); }
  };
  const app = createApp({ adapter, store, pollIntervalMs: 5, publicDir: new URL('../public/', import.meta.url) });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  return { ...app, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function close(app) {
  await app.worker.stop();
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
        { rank: '5', pokemon: 'ザシアン(けんのおう)' },
        { rank: '3', pokemon: 'ピカチュウ' }
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

test('starts server-owned Auto Join and reaches matched state', async () => {
  let polls = 0;
  const adapter = {
    async listRaids() { return [{ rpl_id: '1', rpl_rank: '5', rpl_pokemon: 'Giratina' }]; },
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

test('returns active raid players and lets the guest leave', async () => {
  let leftId = null;
  const adapter = {
    async listRaids() { return []; },
    async createMatching() { return { status: 'success' }; },
    async pollMatching() { return { status: 'success', rpllm_status: 2, rpllm_rpl_id: 'raid-1' }; },
    async findRaid() { return { rpl_id: 'raid-1', rpl_pokemon: 'Giratina', rpl_tid: 'HostOne', rpl_code: '999988887777' }; },
    async listRaidPlayers() { return { players: [{ trainerName: 'PlayerOne', level: 50, isMe: true }], count: 1, readyCount: 0 }; },
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

    const left = await fetch(`${app.baseUrl}/api/active-raid/leave`, { method: 'POST' });
    assert.equal(left.status, 200);
    assert.equal(leftId, 'raid-1');
    assert.equal((await left.json()).state, 'idle');
  } finally { await close(app); }
});
