import test from 'node:test';
import assert from 'node:assert/strict';
import { CliCommandError } from '../src/adapters/cli-process-runner.js';
import { HostedLobbyController } from '../src/core/hosted-lobby-controller.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createController(adapter, saved = null) {
  let persisted = saved;
  const writes = [];
  const controller = new HostedLobbyController({
    adapter,
    persist: async (snapshot) => {
      persisted = structuredClone(snapshot);
      writes.push(structuredClone(snapshot));
    }
  });
  return { controller, writes, read: () => structuredClone(persisted) };
}

const profile = { trainerName: 'Albin123', trainerCode: '123456789012', level: 50, countryCode: 'se' };
const input = {
  startDate: '2026/11/27 16:23:35', pokemonId: 'ピカチュウ(太陽の冠)', currentWeather: 'cloudy',
  gymColor: 'mystic', passType: 'remote', maxUsers: 5, weatherBoosted: false,
  guestLevel: 5, guestRating: 'all', private: false, invitationOnly: false, hot: true, megaPokemonEntry: false
};

test('host create persists intent before dispatch and stores only non-secret summary', async () => {
  const gate = deferred();
  let calls = 0;
  const { controller, read } = createController({
    async createHostedLobby(receivedInput, receivedProfile) {
      calls += 1;
      assert.deepEqual(receivedInput, input);
      assert.deepEqual(receivedProfile, profile);
      await gate.promise;
      return { raidId: 'raid-9' };
    }
  });
  await controller.restore(null);

  const creating = controller.create({ profile, input });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(read().operation.kind, 'create');
  assert.equal(read().lobby.state, 'creating');
  assert.equal(JSON.stringify(read()).includes(profile.trainerCode), false);

  gate.resolve();
  const status = await creating;
  assert.equal(status.state, 'active');
  assert.equal(status.raidId, 'raid-9');
  assert.equal(status.canStart, true);
  assert.equal(read().operation, null);
});

test('unknown host create is never retried and requires explicit local abandonment', async () => {
  let calls = 0;
  const { controller, read } = createController({
    async createHostedLobby() {
      calls += 1;
      throw new CliCommandError({ code: 'WRITE_OUTCOME_UNKNOWN', exitCode: 9, command: 'host create', status: 'unknown', message: 'Unknown.' });
    }
  });
  await controller.restore(null);
  const status = await controller.create({ profile, input });
  assert.equal(calls, 1);
  assert.equal(status.state, 'unknown');
  assert.equal(status.uncertainOperation, 'create');
  assert.equal(status.canCreate, false);
  assert.equal(status.canAbandon, true);
  assert.equal(read().operation, null);

  const restored = createController({ async createHostedLobby() { calls += 1; } }, read());
  await restored.controller.restore(read());
  assert.equal(calls, 1);
  assert.equal(restored.controller.status().state, 'unknown');
  assert.equal(restored.controller.status().canAbandon, true);
});

test('restore converts an interrupted hosted-lobby write to uncertainty without dispatching it', async () => {
  let calls = 0;
  const saved = {
    schemaVersion: 1,
    lobby: { state: 'active', raidId: 'raid-9', summary: { pokemonId: '25' } },
    started: false,
    operation: { opId: 4, kind: 'close', raidId: 'raid-9', guestId: null, startedAt: '2026-11-27T12:00:00.000Z' },
    uncertain: null,
    lastError: null,
    opSequence: 4
  };
  const { controller } = createController({ async closeHostedLobby() { calls += 1; } }, saved);
  await controller.restore(saved);
  const status = controller.status();
  assert.equal(calls, 0);
  assert.equal(status.raidId, 'raid-9');
  assert.equal(status.uncertainOperation, 'close');
  assert.equal(status.canClose, false);
  assert.equal(status.canAbandon, true);
});

test('host status reconciles uncertain kick and close outcomes without repeating writes', async () => {
  const savedKick = {
    schemaVersion: 1,
    lobby: { state: 'active', raidId: 'raid-9', summary: { pokemonId: '25' } },
    started: false,
    operation: null,
    uncertain: { kind: 'kick', raidId: 'raid-9', guestId: 'guest-7', recordedAt: '2026-11-27T12:00:00.000Z' },
    lastError: 'Unknown.',
    opSequence: 2
  };
  let statusCalls = 0;
  const kick = createController({
    async getHostedLobbyStatus() {
      statusCalls += 1;
      return { players: [], count: 0, readyCount: 0, raidDeleted: false };
    }
  }, savedKick);
  await kick.controller.restore(savedKick);
  const kickStatus = await kick.controller.refresh();
  assert.equal(statusCalls, 1);
  assert.equal(kickStatus.uncertainOperation, null);
  assert.equal(kickStatus.canStart, true);

  const savedClose = {
    ...savedKick,
    uncertain: { kind: 'close', raidId: 'raid-9', guestId: null, recordedAt: '2026-11-27T12:00:00.000Z' }
  };
  const close = createController({
    async getHostedLobbyStatus() {
      return { players: [], count: 0, readyCount: 0, raidDeleted: true };
    }
  }, savedClose);
  await close.controller.restore(savedClose);
  const closeStatus = await close.controller.refresh();
  assert.equal(closeStatus.state, 'none');
  assert.equal(closeStatus.raidId, null);
  assert.equal(closeStatus.canCreate, true);
});

test('start, kick and close target only the persisted lobby and serialize writes', async () => {
  const calls = [];
  const saved = {
    schemaVersion: 1,
    lobby: { state: 'active', raidId: 'raid-9', summary: { pokemonId: '25' } },
    started: false,
    operation: null,
    uncertain: null,
    lastError: null,
    opSequence: 1
  };
  const { controller } = createController({
    async getHostedLobbyStatus(id) {
      calls.push(['status', id]);
      return { players: [{ id: 'guest-7', trainerName: 'Guest', level: 50, countryCode: 'se', rating: 4, ready: false }], count: 1, readyCount: 0, raidDeleted: false };
    },
    async kickHostedGuest(id, guestId) { calls.push(['kick', id, guestId]); return { kicked: true }; },
    async startHostedLobby(id) { calls.push(['start', id]); return { started: true }; },
    async closeHostedLobby(id) { calls.push(['close', id]); return { closed: true }; }
  }, saved);
  await controller.restore(saved);
  assert.equal((await controller.kick('guest-7')).state, 'active');
  assert.equal((await controller.start()).started, true);
  assert.equal((await controller.close()).state, 'none');
  assert.deepEqual(calls, [
    ['status', 'raid-9'], ['kick', 'raid-9', 'guest-7'], ['start', 'raid-9'], ['close', 'raid-9']
  ]);
});

test('synchronous hosted-lobby adapter failures settle without leaving an in-flight operation', async () => {
  const { controller, read } = createController({
    createHostedLobby() { throw new Error(`failed for ${profile.trainerCode}`); }
  });
  await controller.restore(null);
  const status = await controller.create({ profile, input });
  assert.equal(status.state, 'unknown');
  assert.equal(read().operation, null);
  assert.equal(JSON.stringify(read()).includes(profile.trainerCode), false);
});

test('host controller blocks invalid lifecycle actions and permits explicit abandonment only for uncertainty', async () => {
  const { controller } = createController({});
  await controller.restore(null);
  await assert.rejects(() => controller.start(), (error) => error.status === 409);
  await assert.rejects(() => controller.kick('guest-7'), (error) => error.status === 409);
  await assert.rejects(() => controller.close(), (error) => error.status === 409);
  await assert.rejects(() => controller.abandon(), (error) => error.status === 409);
});
