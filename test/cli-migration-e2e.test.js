import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { CliProcessRunner } from '../src/adapters/cli-process-runner.js';
import { CliRaidNowAdapter } from '../src/adapters/cli-raidnow-adapter.js';
import { ensureSessionToken } from '../src/adapters/session-token.js';
import { AutoJoinWorker } from '../src/core/autojoin-worker.js';
import { SessionManager } from '../src/core/session-manager.js';

const fixturePath = fileURLToPath(new URL('./fixtures/fake-raidnow-cli.js', import.meta.url));
const profile = { trainerName: 'ProcessUser', trainerCode: '123456789012', level: 50, countryCode: 'se' };

function runServiceFixture(args, { stdin = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixturePath, 'service', ...args], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8')
    }));
    child.stdin.end(stdin);
  });
}

async function waitFor(check, { timeoutMs = 3_000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for condition.');
}

function request(baseUrl, cookie, path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {})
    }
  });
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-cli-migration-'));
  const sessionRoot = join(root, 'sessions');
  const runner = new CliProcessRunner({
    executable: process.execPath,
    baseArgs: [fixturePath, 'service'],
    defaultTimeoutMs: 2_000
  });
  const manager = new SessionManager({
    rootDir: sessionRoot,
    defaults: { profile: {}, account: null, autoJoin: null, pushSubscriptions: [], pushDeliveryJobs: [] },
    adapterFactory: async ({ sessionKey }) => {
      const tokenFile = join(sessionRoot, `${sessionKey}.token`);
      await ensureSessionToken({ runner, tokenFile });
      return new CliRaidNowAdapter({ runner, tokenFile, allowWrites: true });
    },
    workerFactory: ({ adapter, runOperation, persist }) => new AutoJoinWorker({
      adapter,
      runOperation,
      persist,
      pollIntervalMs: 10,
      scanIntervalMs: 1,
      matchedValidationIntervalMs: 60_000
    })
  });
  const app = createApp({
    sessionManager: manager,
    pollIntervalMs: 10,
    publicDir: new URL('../public/', import.meta.url),
    mode: 'live',
    liveWrites: true,
    anonymousOnly: true,
    logger: { error() {} }
  });
  await app.ready;
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return {
    app,
    manager,
    root,
    sessionRoot,
    baseUrl: `http://127.0.0.1:${app.server.address().port}`
  };
}

async function closeFixture(fixture) {
  await fixture.manager.shutdown();
  await new Promise((resolve) => fixture.app.server.close(resolve));
  await rm(fixture.root, { recursive: true, force: true });
}

function issuedCookie(response) {
  return response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
}

test('service fixture rejects incomplete or extra command arguments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-cli-contract-'));
  const tokenFile = join(root, 'session.token');
  await writeFile(tokenFile, 'fixture-token\n', { mode: 0o600 });
  try {
    const invalidCommands = [
      ['bosses', 'list', '--bogus', 'value'],
      ['queue', 'join'],
      ['queue', 'status'],
      ['raid', 'players']
    ];
    for (const command of invalidCommands) {
      const result = await runServiceFixture(['--json', '--token-file', tokenFile, ...command]);
      assert.equal(result.signal, null);
      assert.equal(result.code, 2);
      assert.equal(result.stderr, '');
      assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_ARGUMENTS');
    }
    const invalidInvocations = [
      ['--token-file', tokenFile, '--json', 'bosses', 'list'],
      ['--json', 'token', 'get', '--token-file', tokenFile],
      ['--json', '--token-file', tokenFile, 'queue', 'check', '487', '--pokemon'],
      ['--json', '--token-file', tokenFile, 'queue', 'check', '--pokemon', '487', '--extra']
    ];
    for (const argv of invalidInvocations) {
      const result = await runServiceFixture(argv);
      assert.equal(result.signal, null);
      assert.equal(result.code, 2);
      assert.equal(result.stderr, '');
      assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_ARGUMENTS');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('service fixture rejects queue join stdin that is not the exact trainer code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-cli-contract-'));
  const tokenFile = join(root, 'session.token');
  await writeFile(tokenFile, 'fixture-token\n', { mode: 0o600 });
  const command = [
    '--json', '--token-file', tokenFile,
    'queue', 'join', '--rank', '5', '--pokemon', '487',
    '--trainer-name', 'ProcessUser', '--trainer-level', '50', '--trainer-country', 'se',
    '--trainer-code-file', '-', '--guest-score', '', '--min-host-rating', '3',
    '--host-country', '0', '--weather-boost', '0', '--host-level', '0'
  ];
  try {
    for (const stdin of ['', '000000000000', `${profile.trainerCode}\n`, 'x'.repeat(65)]) {
      const result = await runServiceFixture(command, { stdin });
      assert.equal(result.signal, null);
      assert.equal(result.code, 2);
      assert.equal(result.stderr, '');
      assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_ARGUMENTS');
      if (stdin) assert.equal(result.stdout.includes(stdin), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runs the live migration path through a real CLI subprocess', { timeout: 10_000 }, async () => {
  const fixture = await createFixture();
  try {
    const health = await fetch(`${fixture.baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    assert.deepEqual(await readdir(fixture.sessionRoot), []);

    const configResponse = await fetch(`${fixture.baseUrl}/api/config`);
    assert.equal(configResponse.status, 200);
    const cookie = issuedCookie(configResponse);
    assert.match(cookie, /^raidnow_session=/);
    const config = await configResponse.json();
    assert.equal(config.mode, 'live');
    assert.equal(config.anonymousOnly, true);
    assert.equal(config.liveWrites, true);
    assert.equal(config.loggedIn, true);

    const initialFiles = await readdir(fixture.sessionRoot);
    assert.equal(initialFiles.filter((name) => name.endsWith('.json')).length, 1);
    assert.equal(initialFiles.filter((name) => name.endsWith('.token')).length, 1);
    const tokenFile = initialFiles.find((name) => name.endsWith('.token'));
    assert.equal((await stat(join(fixture.sessionRoot, tokenFile))).mode & 0o777, 0o600);

    const raidsResponse = await request(fixture.baseUrl, cookie, '/api/raids');
    assert.equal(raidsResponse.status, 200);
    const raids = await raidsResponse.json();
    assert.equal(raids.bosses.length, 1);
    assert.equal(raids.bosses[0].displayName, 'Giratina');
    assert.equal(raids.bosses[0].image, 'https://example.test/giratina.png');
    assert.equal(raids.bosses[0].shinyAvailable, true);
    assert.equal(raids.bosses[0].maxCP20, 2105);
    assert.equal(raids.bosses[0].maxCP25, 2631);
    assert.equal(raids.bosses[0].waitingCount, 7);

    const started = await request(fixture.baseUrl, cookie, '/api/autojoin/start', {
      method: 'POST',
      body: JSON.stringify({ profile, ranks: ['5'], pokemon: raids.bosses[0].pokemon })
    });
    assert.equal(started.status, 200);

    const matched = await waitFor(async () => {
      const response = await request(fixture.baseUrl, cookie, '/api/autojoin/status');
      const status = await response.json();
      return status.state === 'matched' && status.queueCancelPending === false ? status : null;
    });
    assert.equal(matched.raid.rpl_id, 'raid-process-1');
    assert.equal(matched.raid.rpl_tid, 'FixtureHost');
    assert.equal(matched.raid.rpl_country_code, 'se');
    assert.equal(matched.raid.rpl_weather, 2);
    assert.equal(matched.raid.maxusers, 10);
    assert.equal(matched.raid.count, 3);
    assert.equal(matched.raid.readycount, 2);
    assert.equal(matched.raid.join, 1);
    assert.equal(matched.raid.rpl_deleted, 0);
    assert.equal(matched.raid.my, 0);
    assert.equal(matched.raid.rpl_glevel, 40);
    assert.equal(Object.hasOwn(matched.raid, 'rpl_code'), false);

    const activeResponse = await request(fixture.baseUrl, cookie, '/api/active-raid');
    assert.equal(activeResponse.status, 200);
    const active = await activeResponse.json();
    assert.equal(active.raid.rpl_id, 'raid-process-1');
    assert.equal(Object.hasOwn(active.raid, 'rpl_code'), false);
    assert.equal(active.players[0].trainerName, 'ZeroRated');
    assert.equal(active.players[0].countryCode, 'se');
    assert.equal(active.players[0].rating, 0);
    assert.equal(active.count, 1);
    assert.equal(active.readyCount, 0);

    const leave = await request(fixture.baseUrl, cookie, '/api/active-raid/leave', { method: 'POST' });
    assert.equal(leave.status, 200);
    await waitFor(async () => {
      const status = await request(fixture.baseUrl, cookie, '/api/autojoin/status').then((response) => response.json());
      return ['idle', 'stopped'].includes(status.state) ? status : null;
    });

    const reset = await request(fixture.baseUrl, cookie, '/api/session/reset', { method: 'POST' });
    assert.equal(reset.status, 200);
    assert.deepEqual(await reset.json(), { reset: true });
    assert.match(reset.headers.get('set-cookie'), /^raidnow_session=;/);
    assert.match(reset.headers.get('set-cookie'), /Max-Age=0/);
    assert.deepEqual(await readdir(fixture.sessionRoot), []);
  } finally {
    await closeFixture(fixture);
  }
});

test('runs hosted lobby management through the real CLI subprocess contract', { timeout: 10_000 }, async () => {
  const fixture = await createFixture();
  try {
    const config = await fetch(`${fixture.baseUrl}/api/config`);
    const cookie = issuedCookie(config);
    await request(fixture.baseUrl, cookie, '/api/raids');
    const created = await request(fixture.baseUrl, cookie, '/api/hosted-lobby', {
      method: 'POST',
      body: JSON.stringify({
        profile,
        startDate: '2026/11/27 16:23:35',
        pokemonId: '487',
        currentWeather: 'cloudy',
        gymColor: 'mystic',
        passType: 'remote',
        maxUsers: 5,
        weatherBoosted: false,
        guestLevel: 5,
        guestRating: 'all',
        private: false,
        invitationOnly: false,
        hot: true,
        megaPokemonEntry: false
      })
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).raidId, 'host-process-1');

    const status = await request(fixture.baseUrl, cookie, '/api/hosted-lobby').then((response) => response.json());
    assert.equal(status.players[0].trainerName, 'HostedGuest');
    assert.equal(status.players[0].canKick, true);
    assert.equal(status.count, 1);
    const protectedReset = await request(fixture.baseUrl, cookie, '/api/session/reset', { method: 'POST' });
    assert.equal(protectedReset.status, 409);

    const kicked = await request(fixture.baseUrl, cookie, '/api/hosted-lobby/kick', {
      method: 'POST', body: JSON.stringify({ guestId: 'guest-process-1', raidId: 'browser-must-not-control-this' })
    });
    assert.equal(kicked.status, 200);
    const started = await request(fixture.baseUrl, cookie, '/api/hosted-lobby/start', { method: 'POST' });
    assert.equal(started.status, 200);
    const closed = await request(fixture.baseUrl, cookie, '/api/hosted-lobby/close', { method: 'POST' });
    assert.equal(closed.status, 200);
    assert.equal((await closed.json()).state, 'none');
  } finally {
    await closeFixture(fixture);
  }
});

test('isolates owner-only CLI token files for two browser cookies', { timeout: 10_000 }, async () => {
  const fixture = await createFixture();
  try {
    const firstConfig = await fetch(`${fixture.baseUrl}/api/config`);
    const secondConfig = await fetch(`${fixture.baseUrl}/api/config`);
    const firstCookie = issuedCookie(firstConfig);
    const secondCookie = issuedCookie(secondConfig);
    assert.notEqual(firstCookie, secondCookie);

    const files = await readdir(fixture.sessionRoot);
    const tokenFiles = files.filter((name) => name.endsWith('.token')).sort();
    assert.equal(tokenFiles.length, 2);
    for (const name of tokenFiles) {
      assert.equal((await stat(join(fixture.sessionRoot, name))).mode & 0o777, 0o600);
    }
    const firstBytes = await readFile(join(fixture.sessionRoot, tokenFiles[0]));
    const secondBytes = await readFile(join(fixture.sessionRoot, tokenFiles[1]));
    assert.notEqual(Buffer.compare(firstBytes, secondBytes), 0);

    for (const cookie of [firstCookie, secondCookie]) {
      const reset = await request(fixture.baseUrl, cookie, '/api/session/reset', { method: 'POST' });
      assert.equal(reset.status, 200);
    }
    assert.deepEqual(await readdir(fixture.sessionRoot), []);
  } finally {
    await closeFixture(fixture);
  }
});
