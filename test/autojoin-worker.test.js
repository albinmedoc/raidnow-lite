import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { AutoJoinWorker } from '../src/core/autojoin-worker.js';

const profile = { trainerName: 'Albin123', trainerCode: '123456789012', level: 50, countryCode: 'se' };
const selection = { ranks: ['5'], pokemon: ['Giratina'] };

test('keeps polling without any browser connection and emits a match', async () => {
  let polls = 0;
  const adapter = {
    async createMatching() { return { status: 'success', list: [] }; },
    async pollMatching() {
      polls += 1;
      return polls < 2
        ? { status: 'success', rpllm_status: 1, list: [] }
        : { status: 'success', rpllm_status: 2, rpllm_rpl_id: 'raid-42', pokemon: 'Giratina', list: [] };
    },
    async findRaid(id) { return { rpl_id: id, rpl_pokemon: 'Giratina', rpl_code: '999988887777' }; }
  };
  const worker = new AutoJoinWorker({ adapter, pollIntervalMs: 5 });
  const matched = once(worker, 'matched');

  await worker.start({ profile, selection });
  const [raid] = await matched;

  assert.equal(raid.rpl_id, 'raid-42');
  assert.equal(worker.status().state, 'matched');
  assert.equal(worker.status().profile, null);
  assert.ok(polls >= 2);
});

test('fast search scans live lobbies and joins the first selected boss', async () => {
  const joined = [];
  let scannedSelection = null;
  const adapter = {
    async createMatching() { throw new Error('queue matching must not be used'); },
    async listRaidsForSelection(selection) {
      scannedSelection = selection;
      return [
        { rpl_id: 'wrong', rpl_rank: '5', rpl_pokemon: 'Zamazenta' },
        { rpl_id: 'low-host', rpl_rank: '5', rpl_pokemon: 'Giratina', rpl_level: 40, rpl_weather: 1 },
        { rpl_id: 'no-boost', rpl_rank: '5', rpl_pokemon: 'Giratina', rpl_level: 60, rpl_weather: 0 },
        { rpl_id: 'target', rpl_rank: '5', rpl_pokemon: 'Giratina', rpl_level: 60, rpl_weather: 1 }
      ];
    },
    async joinRaidFast(id) {
      joined.push(id);
      return { status: 'success', data: { rpl_id: id, rpl_rank: '5', rpl_pokemon: 'Giratina' } };
    }
  };
  const worker = new AutoJoinWorker({ adapter, pollIntervalMs: 5 });
  const matched = once(worker, 'matched');
  await worker.start({ profile, selection: { ...selection, strategy: 'fast', hostLevel: 50, weatherBoost: 1 } });
  const [raid] = await matched;
  assert.deepEqual(joined, ['target']);
  assert.deepEqual(scannedSelection.pokemon, ['Giratina']);
  assert.equal(raid.rpl_id, 'target');
  assert.equal(worker.status().state, 'matched');
});

test('hybrid search queues and simultaneously fast joins a live lobby', async () => {
  let queued = 0;
  let cancelled = 0;
  const adapter = {
    async createMatching() { queued += 1; return { status: 'success' }; },
    async listRaidsForSelection() {
      return [{ rpl_id: 'direct-1', rpl_rank: '5', rpl_pokemon: 'Giratina' }];
    },
    async joinRaidFast(id) { return { status: 'success', data: { rpl_id: id, rpl_rank: '5', rpl_pokemon: 'Giratina' } }; },
    async pollMatching() { throw new Error('queue poll should not win after direct join'); },
    async cancelMatching() { cancelled += 1; return { status: 'success' }; }
  };
  const worker = new AutoJoinWorker({ adapter, pollIntervalMs: 5 });
  const matched = once(worker, 'matched');
  await worker.start({ profile, selection: { ...selection, strategy: 'hybrid' } });
  const [raid] = await matched;
  assert.equal(queued, 1);
  assert.equal(cancelled, 1);
  assert.equal(raid.rpl_id, 'direct-1');
});

test('hybrid search keeps the queue active when no direct lobby is available', async () => {
  let queuePolls = 0;
  const adapter = {
    async createMatching() { return { status: 'success' }; },
    async listRaidsForSelection() { return []; },
    async joinRaidFast() { throw new Error('there is no direct lobby'); },
    async pollMatching() {
      queuePolls += 1;
      return { status: 'success', rpllm_status: 2, rpllm_rpl_id: 'queue-1' };
    },
    async findRaid(id) { return { rpl_id: id, rpl_rank: '5', rpl_pokemon: 'Giratina' }; }
  };
  const worker = new AutoJoinWorker({ adapter, pollIntervalMs: 5 });
  const matched = once(worker, 'matched');
  await worker.start({ profile, selection: { ...selection, strategy: 'hybrid' } });
  const [raid] = await matched;
  assert.ok(queuePolls >= 1);
  assert.equal(raid.rpl_id, 'queue-1');
});

test('rejects starting a second concurrent search', async () => {
  const adapter = {
    async createMatching() { return { status: 'success' }; },
    async pollMatching() { return { status: 'success', rpllm_status: 1 }; },
    async cancelMatching() { return { status: 'success' }; }
  };
  const worker = new AutoJoinWorker({ adapter, pollIntervalMs: 1000 });
  await worker.start({ profile, selection });
  await assert.rejects(() => worker.start({ profile, selection }), /already active/i);
  await worker.stop();
  assert.equal(worker.status().state, 'stopped');
});

test('recovers an upstream search after a process restart', async () => {
  const adapter = {
    async checkMatching() { return { id: 'match-row', priority: 0, list: [] }; },
    async pollMatching() { return { status: 'success', rpllm_status: 1 }; },
    async cancelMatching() { return { status: 'success' }; }
  };
  const worker = new AutoJoinWorker({ adapter, pollIntervalMs: 1000 });
  const recovered = await worker.recover({ profile, selection });
  assert.equal(recovered, true);
  assert.equal(worker.status().state, 'searching');
  await worker.stop();
});

test('leaves a matched raid and clears the active raid state', async () => {
  let leftId = null;
  const adapter = {
    async createMatching() { return { status: 'success' }; },
    async pollMatching() { return { status: 'success', rpllm_status: 2, rpllm_rpl_id: 'raid-42' }; },
    async findRaid(id) { return { rpl_id: id, rpl_pokemon: 'Giratina' }; },
    async leaveRaid(id) { leftId = id; return { status: 'success' }; }
  };
  const worker = new AutoJoinWorker({ adapter, pollIntervalMs: 5 });
  const matched = once(worker, 'matched');
  await worker.start({ profile, selection });
  await matched;
  const status = await worker.leaveRaid();
  assert.equal(leftId, 'raid-42');
  assert.equal(status.state, 'idle');
  assert.equal(status.raid, null);
});

test('restores a matched raid after the service restarts', () => {
  const worker = new AutoJoinWorker({ adapter: {}, pollIntervalMs: 1000 });
  const restored = worker.restore({
    state: 'matched',
    startedAt: '2026-11-10T18:37:14.420Z',
    raid: { rpl_id: 'raid-42', rpl_pokemon: 'Giratina' },
    selection
  });
  assert.equal(restored, true);
  assert.equal(worker.status().state, 'matched');
  assert.equal(worker.status().raid.rpl_id, 'raid-42');
});

test('shuts down locally without leaving or clearing a matched raid', () => {
  const worker = new AutoJoinWorker({ adapter: {}, pollIntervalMs: 1000 });
  worker.restore({ state: 'matched', raid: { rpl_id: 'raid-42' }, selection });
  worker.shutdown();
  assert.equal(worker.status().state, 'matched');
  assert.equal(worker.status().raid.rpl_id, 'raid-42');
});
