import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoJoinWorker } from '../src/core/autojoin-worker.js';
import { initialSnapshot } from '../src/core/autojoin-state-machine.js';
import { RaidNowAdapter } from '../src/adapters/raidnow-adapter.js';
import { CliCommandError } from '../src/adapters/cli-process-runner.js';

const profile = { trainerName: 'Albin123', trainerCode: '123456789012', level: 50, countryCode: 'se' };
const selection = { ranks: ['5'], pokemon: ['Giratina'] };

class FakeClock {
  nowMs = Date.parse('2026-11-11T10:00:00.000Z');
  timers = new Map();
  nextId = 1;
  now = () => this.nowMs;
  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { callback, due: this.nowMs + Math.max(0, delay) });
    return id;
  };
  clearTimeout = (id) => this.timers.delete(id);
  async tick(ms = 0) {
    this.nowMs += ms;
    for (;;) {
      const ready = [...this.timers.entries()].filter(([, timer]) => timer.due <= this.nowMs).sort((a, b) => a[1].due - b[1].due);
      if (!ready.length) break;
      const [id, timer] = ready[0];
      this.timers.delete(id);
      timer.callback();
      await flush();
    }
  }
}

async function flush(turns = 8) {
  for (let index = 0; index < turns; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(worker, predicate) {
  for (let index = 0; index < 100; index += 1) {
    const status = worker.status();
    if (predicate(status)) return status;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for status: ${JSON.stringify(worker.status())}`);
}

test('persists before publishing state, launching adapters, and arming the only timer', async () => {
  const order = [];
  const clock = new FakeClock();
  const adapter = {
    async createMatching() { order.push('adapter:create'); return { status: 'success' }; },
    async pollMatching() { order.push('adapter:poll'); return { status: 'success', rpllm_status: 1 }; }
  };
  const worker = new AutoJoinWorker({
    adapter,
    pollIntervalMs: 100,
    clock,
    persist: async (snapshot) => order.push(`persist:${snapshot.operation?.kind ?? snapshot.wake?.kind ?? 'state'}`)
  });
  worker.on('state', () => order.push('state'));

  await worker.start({ profile, selection });
  await flush();
  assert.deepEqual(order.slice(0, 3), ['persist:createQueue', 'state', 'adapter:create']);
  assert.equal(clock.timers.size, 1);
  assert.ok(order.indexOf('persist:pollQueue') < order.lastIndexOf('state'));
});

test('persistence failure prevents adapter calls and state publication', async () => {
  let calls = 0;
  let states = 0;
  const worker = new AutoJoinWorker({
    adapter: { async createMatching() { calls += 1; return { status: 'success' }; } },
    persist: async () => { throw new Error('disk full'); }
  });
  worker.on('state', () => { states += 1; });

  await assert.rejects(() => worker.start({ profile, selection }), /disk full/);
  assert.equal(calls, 0);
  assert.equal(states, 0);
  assert.equal(worker.status().state, 'idle');
});

test('runs at most one adapter operation and one timer', async () => {
  const clock = new FakeClock();
  let active = 0;
  let maxActive = 0;
  let resolveCreate;
  const adapter = {
    async createMatching() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => { resolveCreate = resolve; });
      active -= 1;
      return { status: 'success' };
    },
    async checkMatching() { active += 1; maxActive = Math.max(maxActive, active); active -= 1; return {}; },
    async cancelMatching() { active += 1; maxActive = Math.max(maxActive, active); active -= 1; return { status: 'success' }; }
  };
  const worker = new AutoJoinWorker({ adapter, pollIntervalMs: 100, clock });
  await worker.start({ profile, selection });
  await worker.stop();
  assert.equal(active, 1);
  assert.equal(clock.timers.size, 0);
  resolveCreate();
  await flush();
  assert.equal(maxActive, 1);
  assert.ok(clock.timers.size <= 1);
});

test('diagnostics report a rejected raid join without dumping its private input', async () => {
  const clock = new FakeClock();
  const diagnostics = [];
  const anonymousToken = 'AbCdEf0123456789_-AbCdEf0123456789_-AbCdEfGH';
  const rejection = new CliCommandError({
    message: `Lobby is full. token=${anonymousToken}`,
    code: 'UPSTREAM_REJECTION',
    exitCode: 7,
    command: 'raid join',
    status: 401
  });
  const worker = new AutoJoinWorker({
    adapter: {
      async createMatching() { return { status: 'success' }; },
      async listRaidsForSelection() { return [{ rpl_id: 'direct-1', rpl_rank: '5', rpl_pokemon: 'Giratina' }]; },
      async joinRaidFast() { throw rejection; },
      async findRaid() { return null; }
    },
    pollIntervalMs: 100,
    clock,
    diagnostics: (event) => diagnostics.push(event)
  });

  await worker.start({ profile, selection: { ...selection, strategy: 'hybrid' } });
  await waitFor(worker, (status) => status.nextPollAt !== null);
  await clock.tick(0);
  await waitFor(worker, () => diagnostics.some((event) => event.operation === 'joinRaid' && event.result === 'rejected'));

  const event = diagnostics.find((item) => item.operation === 'joinRaid' && item.result === 'rejected');
  assert.deepEqual(event, {
    event: 'raidnow_operation',
    operation: 'joinRaid',
    result: 'rejected',
    at: new Date(clock.now()).toISOString(),
    durationMs: 0,
    code: 'UPSTREAM_REJECTION',
    exitCode: 7,
    command: 'raid join',
    status: 401,
    message: 'Lobby is full. token=[REDACTED]',
    writeOutcome: 'definite',
    raidId: 'direct-1'
  });
  const serialized = JSON.stringify(diagnostics);
  assert.equal(serialized.includes(profile.trainerCode), false);
  assert.equal(serialized.includes(profile.trainerName), false);
  assert.equal(serialized.includes(profile.countryCode), false);
  assert.equal(serialized.includes(anonymousToken), false);
  worker.shutdown();
});

test('full lobby rejection silently resumes lobby scanning while Auto Join remains active', async () => {
  const clock = new FakeClock();
  let lobbyScans = 0;
  let joins = 0;
  const rejection = new CliCommandError({
    message: 'Upstream avvisade begäran: The maximum number of participants has been exceeded. Use Auto join.',
    code: 'UPSTREAM_REJECTION',
    exitCode: 7,
    command: 'raid join',
    status: 'rejected'
  });
  const worker = new AutoJoinWorker({
    adapter: {
      async createMatching() { return { status: 'success' }; },
      async listRaidsForSelection() {
        lobbyScans += 1;
        return [{ rpl_id: 'full-raid', rpl_rank: '5', rpl_pokemon: 'Giratina' }];
      },
      async joinRaidFast() {
        joins += 1;
        throw rejection;
      }
    },
    pollIntervalMs: 100,
    scanIntervalMs: 100,
    clock
  });

  await worker.start({ profile, selection: { ...selection, strategy: 'hybrid' } });
  await waitFor(worker, (status) => status.nextPollAt !== null);
  await clock.tick(0);
  await waitFor(worker, () => joins === 1 && worker.status().nextPollAt !== null);
  assert.equal(worker.status().state, 'searching');
  assert.equal(worker.status().error, null);
  await clock.tick(100);
  await waitFor(worker, () => lobbyScans === 2);
  assert.equal(joins, 1);
  worker.shutdown();
});

test('a host-started lobby is skipped so the next unseen lobby can be joined', async () => {
  const clock = new FakeClock();
  const joined = [];
  const rejection = new CliCommandError({
    message: 'Upstream avvisade begäran: The host has declared the start of the raid and you cannot participate. Use Auto join.',
    code: 'UPSTREAM_REJECTION', exitCode: 7, command: 'raid join', status: 'rejected'
  });
  const worker = new AutoJoinWorker({
    adapter: {
      async createMatching() { return { status: 'success' }; },
      async listRaidsForSelection() {
        return [
          { rpl_id: 'started', rpl_rank: '5', rpl_pokemon: 'Giratina' },
          { rpl_id: 'fresh', rpl_rank: '5', rpl_pokemon: 'Giratina' }
        ];
      },
      async joinRaidFast(raidId) {
        joined.push(raidId);
        if (raidId === 'started') throw rejection;
        return { status: 'success' };
      },
      async cancelMatching() { return { status: 'success' }; }
    },
    pollIntervalMs: 100,
    scanIntervalMs: 100,
    clock
  });

  await worker.start({ profile, selection: { ...selection, strategy: 'hybrid' } });
  await waitFor(worker, (status) => status.nextPollAt !== null);
  await clock.tick(0);
  await waitFor(worker, () => joined.length === 1 && worker.status().nextPollAt !== null);
  await clock.tick(100);
  await waitFor(worker, () => joined.length === 2);
  assert.deepEqual(joined, ['started', 'fresh']);
  worker.shutdown();
});

test('a not-dispatched queue write fails safely without reconciliation', async () => {
  const rejection = new CliCommandError({
    message: 'Request was not dispatched.',
    code: 'READ_NETWORK_ERROR',
    exitCode: 8,
    command: 'queue join',
    status: 'not-dispatched'
  });
  const worker = new AutoJoinWorker({
    adapter: {
      async createMatching() { throw rejection; }
    }
  });

  await worker.start({ profile, selection });
  await waitFor(worker, (status) => status.state === 'error');
  assert.equal(worker.status().nextRetryAt, null);
  assert.equal(worker.status().queueCancelPending, false);
  worker.shutdown();
});

test('diagnostics classify an untyped write failure as unknown', async () => {
  const diagnostics = [];
  const worker = new AutoJoinWorker({
    adapter: {
      async createMatching() { throw Object.assign(new Error('Operation aborted.'), { exitCode: 7 }); }
    },
    diagnostics: (event) => diagnostics.push(event)
  });

  await worker.start({ profile, selection });
  await waitFor(worker, () => diagnostics.some((event) => event.operation === 'createQueue' && event.result === 'rejected'));
  const event = diagnostics.find((item) => item.operation === 'createQueue' && item.result === 'rejected');
  assert.equal(event.writeOutcome, 'unknown');
  worker.shutdown();
});

test('hybrid match is published before queue cancellation and remains visible after cancel failure', async () => {
  const clock = new FakeClock();
  const order = [];
  const adapter = {
    async createMatching() { return { status: 'success' }; },
    async listRaidsForSelection() { return [{ rpl_id: 'direct-1', rpl_rank: '5', rpl_pokemon: 'Giratina' }]; },
    async joinRaidFast(id) { return { status: 'success', data: { rpl_id: id, rpl_pokemon: 'Giratina' } }; },
    async cancelMatching() { order.push('cancel'); throw new Error('cancel timeout'); },
    async checkMatching() { return { id: 'still-present' }; }
  };
  const worker = new AutoJoinWorker({ adapter, pollIntervalMs: 100, clock, persist: async () => order.push('persist') });
  worker.on('matched', () => order.push('matched'));

  await worker.start({ profile, selection: { ...selection, strategy: 'hybrid' } });
  await waitFor(worker, (status) => status.nextPollAt !== null);
  await clock.tick(0);
  await waitFor(worker, (status) => status.state === 'matched' && status.queueCancelPending);
  const matchedIndex = order.indexOf('matched');
  assert.ok(matchedIndex > 0);
  assert.equal(order[matchedIndex - 1], 'persist');
  assert.ok(matchedIndex < order.indexOf('cancel'));
  assert.equal(worker.status().raid.rpl_id, 'direct-1');
  assert.match(worker.status().lastError, /cancel timeout/);
});

test('leave proceeds to raid reconciliation after an in-flight queue cancellation succeeds', async () => {
  const clock = new FakeClock();
  let resolveCancel;
  let membershipChecks = 0;
  let queueChecks = 0;
  let leaves = 0;
  const order = [];
  const adapter = {
    async cancelMatching() { return new Promise((resolve) => { resolveCancel = resolve; }); },
    async checkMatching() { queueChecks += 1; order.push('queue'); return {}; },
    async findRaid() { membershipChecks += 1; order.push('raid'); return { rpl_id: 'raid-1', join: 1 }; },
    async leaveRaid() { leaves += 1; order.push('leave'); return { status: 'success' }; }
  };
  const worker = new AutoJoinWorker({ adapter, pollIntervalMs: 100, clock });
  await worker.restore({
    ...initialSnapshot(),
    intent: 'idle',
    search: { profile, selection: { ...selection, strategy: 'hybrid' }, nextQueuePollAt: null, attemptedRaids: {} },
    queue: { state: 'present' },
    raid: { state: 'matched', target: 'raid-1', value: { rpl_id: 'raid-1' } },
    terminal: { target: 'matched', error: null }
  });
  await worker.stop();
  const leaving = worker.leaveRaid();
  await flush();
  assert.equal(leaves, 0);
  resolveCancel({ status: 'success' });
  await flush();
  await clock.tick(0);
  const status = await leaving;
  assert.equal(membershipChecks, 1);
  assert.equal(queueChecks, 1);
  assert.equal(leaves, 1);
  assert.ok(order.indexOf('raid') < order.indexOf('queue'));
  assert.ok(order.indexOf('leave') < order.indexOf('queue'));
  assert.equal(status.raid, null);
  assert.equal(status.state, 'reconciling');
  assert.equal(status.queueCancelPending, true);
  worker.shutdown();
});

test('leave proceeds to raid reconciliation after an in-flight queue cancellation fails', async () => {
  const clock = new FakeClock();
  let rejectCancel;
  let cancelCalls = 0;
  let membershipChecks = 0;
  let queueChecks = 0;
  const order = [];
  const worker = new AutoJoinWorker({
    adapter: {
      async cancelMatching() {
        cancelCalls += 1;
        if (cancelCalls > 1) throw new Error('cancel still rejected');
        return new Promise((_resolve, reject) => { rejectCancel = reject; });
      },
      async checkMatching() { queueChecks += 1; order.push('queue'); return { id: 'still-present' }; },
      async findRaid() { membershipChecks += 1; order.push('raid'); return null; }
    },
    pollIntervalMs: 100,
    clock
  });
  await worker.restore({
    ...initialSnapshot(),
    intent: 'idle',
    search: { profile, selection: { ...selection, strategy: 'hybrid' }, nextQueuePollAt: null, attemptedRaids: {} },
    queue: { state: 'present' },
    raid: { state: 'matched', target: 'raid-1', value: { rpl_id: 'raid-1' } },
    terminal: { target: 'matched', error: null }
  });
  await worker.stop();
  const leaving = worker.leaveRaid();
  await flush();
  rejectCancel(new Error('cancel rejected'));
  await flush();
  await clock.tick(0);
  const status = await leaving;
  assert.equal(membershipChecks, 1);
  assert.equal(queueChecks, 1);
  assert.ok(order.indexOf('raid') < order.indexOf('queue'));
  assert.equal(status.raid, null);
  assert.equal(status.state, 'reconciling');
  assert.equal(status.queueCancelPending, true);
  worker.shutdown();
});

test('leave aborts an in-flight queue read before reconciling raid membership', async () => {
  const clock = new FakeClock();
  let queueSignal;
  let membershipChecks = 0;
  const worker = new AutoJoinWorker({
    adapter: {
      async checkMatching(_request, { signal }) {
        queueSignal = signal;
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      },
      async findRaid() { membershipChecks += 1; return null; }
    },
    pollIntervalMs: 100,
    clock
  });
  await worker.restore({
    ...initialSnapshot(),
    intent: 'idle',
    search: { profile, selection: { ...selection, strategy: 'hybrid' }, nextQueuePollAt: null, attemptedRaids: {} },
    queue: { state: 'unknown' },
    raid: { state: 'matched', target: 'raid-1', value: { rpl_id: 'raid-1' } },
    wake: { kind: 'reconcileQueue', dueAt: new Date(clock.now()).toISOString() },
    terminal: { target: 'matched', error: null },
    opSequence: 1
  });
  await clock.tick(0);
  await waitFor(worker, () => Boolean(queueSignal));

  const leaving = worker.leaveRaid();
  await flush();
  assert.equal(queueSignal.aborted, true);
  await clock.tick(0);
  const status = await leaving;
  assert.equal(membershipChecks, 1);
  assert.equal(status.raid, null);
  assert.equal(status.state, 'reconciling');
  assert.equal(status.queueCancelPending, true);
  worker.shutdown();
});

test('finished leave exposes stable local abandonment for an unremovable queue', async () => {
  const clock = new FakeClock();
  let queueChecks = 0;
  let cancellations = 0;
  const worker = new AutoJoinWorker({
    adapter: {
      async checkMatching() { queueChecks += 1; return { id: 'still-present' }; },
      async cancelMatching() { cancellations += 1; throw new Error('cancel rejected'); }
    },
    pollIntervalMs: 100,
    clock
  });
  await worker.restore({
    ...initialSnapshot(),
    intent: 'leave',
    search: { profile, selection, nextQueuePollAt: null, attemptedRaids: {} },
    queue: { state: 'unknown' },
    raid: { state: 'none', target: null, value: null },
    wake: { kind: 'reconcileQueue', dueAt: new Date(clock.now()).toISOString() },
    terminal: { target: 'idle', error: null },
    retryCount: 3,
    lastError: 'cancel rejected'
  });
  await clock.tick(0);
  const status = await waitFor(worker, (value) => value.canAbandonLocal);
  assert.equal(status.state, 'reconciling');
  assert.equal(status.raid, null);
  assert.equal(status.nextRetryAt, null);
  assert.equal(queueChecks, 1);
  assert.equal(cancellations, 1);
  await clock.tick(5_000);
  assert.equal(queueChecks, 1);
  assert.equal(cancellations, 1);
  await worker.abandonLocal();
  assert.equal(worker.status().state, 'idle');
  worker.shutdown();
});

test('leave confirms raid absence before retrying blocked queue cleanup', async () => {
  const clock = new FakeClock();
  let membershipChecks = 0;
  let queueChecks = 0;
  const order = [];
  const worker = new AutoJoinWorker({
    adapter: {
      async findRaid() { membershipChecks += 1; order.push('raid'); return null; },
      async checkMatching() { queueChecks += 1; order.push('queue'); return { id: 'still-present' }; },
      async cancelMatching() { throw new Error('cancel rejected'); }
    },
    pollIntervalMs: 100,
    clock
  });
  await worker.restore({
    ...initialSnapshot(),
    search: { profile, selection: { ...selection, strategy: 'hybrid' }, nextQueuePollAt: null, attemptedRaids: {} },
    queue: { state: 'unknown' },
    raid: { state: 'matched', target: 'raid-1', value: { rpl_id: 'raid-1' } },
    terminal: { target: 'matched', error: null }
  });

  const leaving = worker.leaveRaid();
  try {
    await flush();
    await clock.tick(0);
    await flush();
    assert.equal(membershipChecks, 1);
    assert.equal(queueChecks, 1);
    assert.equal(order[0], 'raid');
    const status = await leaving;
    assert.equal(status.raid, null);
    assert.equal(status.state, 'reconciling');
    assert.equal(status.queueCancelPending, true);
  } finally {
    worker.shutdown();
    await leaving.catch(() => {});
  }
});

test('leave remains pending through an uncertain timeout until absence is confirmed', async () => {
  const clock = new FakeClock();
  let membershipChecks = 0;
  const worker = new AutoJoinWorker({
    adapter: {
      async leaveRaid() { throw new Error('leave timeout'); },
      async findRaid() { membershipChecks += 1; return null; }
    },
    pollIntervalMs: 100,
    clock
  });
  await worker.restore({
    ...initialSnapshot(),
    raid: { state: 'matched', target: 'raid-1', value: { rpl_id: 'raid-1' } },
    terminal: { target: 'matched', error: null }
  });

  let settled = false;
  const leaving = worker.leaveRaid().finally(() => { settled = true; });
  await flush();
  assert.equal(settled, false);
  assert.equal(worker.status().state, 'matched');
  assert.equal(worker.status().nextRetryAt, new Date(clock.now() + 100).toISOString());

  await clock.tick(99);
  assert.equal(settled, false);
  assert.equal(membershipChecks, 0);
  await clock.tick(1);
  assert.equal((await leaving).state, 'idle');
  assert.equal(membershipChecks, 1);
});

test('leave rejects with a clear error after a definite upstream failure', async () => {
  const worker = new AutoJoinWorker({
    adapter: {
      async leaveRaid() { return { status: 'error', text: 'Raid membership cannot be removed.' }; }
    }
  });
  await worker.restore({
    ...initialSnapshot(),
    raid: { state: 'matched', target: 'raid-1', value: { rpl_id: 'raid-1' } },
    terminal: { target: 'matched', error: null }
  });

  await assert.rejects(() => worker.leaveRaid(), /Raid membership cannot be removed/);
  assert.equal(worker.status().state, 'matched');
});

test('shutdown rejects leave waiters and detaches their state listeners', async () => {
  const worker = new AutoJoinWorker({
    adapter: {
      async leaveRaid(_id, { signal }) {
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
    }
  });
  await worker.restore({
    ...initialSnapshot(),
    raid: { state: 'matched', target: 'raid-1', value: { rpl_id: 'raid-1' } },
    terminal: { target: 'matched', error: null }
  });

  const leaving = worker.leaveRaid();
  await flush();
  assert.equal(worker.listenerCount('state'), 1);
  worker.shutdown();
  const outcome = await Promise.race([
    leaving.then(() => 'resolved', (error) => error),
    new Promise((resolve) => setImmediate(() => resolve('pending')))
  ]);
  assert.notEqual(outcome, 'pending');
  assert.match(outcome.message, /shut down/i);
  assert.equal(worker.listenerCount('state'), 0);
});

test('cancel success stays locked until checkMatching confirms absence', async () => {
  const clock = new FakeClock();
  let resolveCheck;
  const adapter = {
    async createMatching() { return { status: 'success' }; },
    async pollMatching() { return { status: 'success', rpllm_status: 1 }; },
    async cancelMatching() { return { status: 'success' }; },
    async checkMatching() { return new Promise((resolve) => { resolveCheck = resolve; }); }
  };
  const worker = new AutoJoinWorker({ adapter, pollIntervalMs: 100, clock });
  await worker.start({ profile, selection });
  await flush();
  await worker.stop();
  await flush();
  assert.equal(worker.status().queueCancelPending, true);
  await assert.rejects(() => worker.start({ profile, selection }), /already active/i);
  resolveCheck({});
  await waitFor(worker, (status) => status.state === 'stopped');
  assert.equal(worker.status().queueCancelPending, false);
});

test('late fast join success after stop becomes matched', async () => {
  const clock = new FakeClock();
  let resolveJoin;
  const adapter = {
    async listRaidsForSelection() { return [{ rpl_id: 'late', rpl_rank: '5', rpl_pokemon: 'Giratina' }]; },
    async joinRaidFast(id) { return new Promise((resolve) => { resolveJoin = () => resolve({ status: 'success', data: { rpl_id: id } }); }); }
  };
  const worker = new AutoJoinWorker({ adapter, pollIntervalMs: 100, clock });
  await worker.start({ profile, selection: { ...selection, strategy: 'fast' } });
  await clock.tick(0);
  await waitFor(worker, (status) => status.state === 'joining');
  await worker.stop();
  assert.equal(worker.status().state, 'stopping');
  resolveJoin();
  await waitFor(worker, (status) => status.state === 'matched');
  assert.equal(worker.status().raid.rpl_id, 'late');
});

test('restore turns in-flight writes into uncertainty and resumes obligations', async () => {
  const clock = new FakeClock();
  let checks = 0;
  const adapter = {
    async checkMatching() { checks += 1; return {}; }
  };
  const worker = new AutoJoinWorker({ adapter, pollIntervalMs: 100, clock });
  const restored = await worker.restore({
    ...initialSnapshot(),
    intent: 'stop',
    search: { profile, selection, nextQueuePollAt: null, attemptedRaids: {} },
    queue: { state: 'creating' },
    operation: { opId: 'create-1', kind: 'createQueue', input: { profile, selection }, startedAt: new Date(clock.now()).toISOString(), attempt: 1 }
  });
  assert.equal(restored, true);
  assert.equal(worker.status().queueCancelPending, true);
  await clock.tick(0);
  await waitFor(worker, (status) => status.state === 'stopped');
  assert.equal(checks, 1);
});

test('shutdown aborts runtime only and a new worker restore resumes durable cleanup', async () => {
  const clock = new FakeClock();
  const persisted = [];
  let signal;
  const first = new AutoJoinWorker({
    adapter: {
      async cancelMatching(_options = {}) { return { status: 'success' }; },
      async checkMatching(_request, { signal: requestSignal } = {}) {
        signal = requestSignal;
        return new Promise((_resolve, reject) => requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true }));
      }
    },
    pollIntervalMs: 100,
    clock,
    persist: async (snapshot) => persisted.push(structuredClone(snapshot))
  });
  await first.restore({
    ...initialSnapshot(),
    intent: 'stop',
    search: { profile, selection, nextQueuePollAt: null, attemptedRaids: {} },
    queue: { state: 'unknown' },
    wake: { kind: 'reconcileQueue', dueAt: new Date(clock.now()).toISOString() },
    terminal: { target: 'stopped', error: null }
  });
  await clock.tick(0);
  await waitFor(first, () => Boolean(signal));
  first.shutdown();
  assert.equal(signal.aborted, true);

  const secondClock = new FakeClock();
  let resumedChecks = 0;
  const second = new AutoJoinWorker({ adapter: { async checkMatching() { resumedChecks += 1; return {}; } }, pollIntervalMs: 100, clock: secondClock });
  await second.restore(persisted.at(-1));
  await secondClock.tick(0);
  await waitFor(second, (status) => status.state === 'stopped');
  assert.equal(resumedChecks, 1);
});

test('reconcileRaid calls findRaid for the uncertain target', async () => {
  const clock = new FakeClock();
  const ids = [];
  const worker = new AutoJoinWorker({ adapter: { async findRaid(id) { ids.push(id); return { rpl_id: id, join: 1 }; } }, pollIntervalMs: 100, clock });
  await worker.restore({
    ...initialSnapshot(), intent: 'search',
    search: { profile, selection: { ...selection, strategy: 'fast' }, nextQueuePollAt: null, attemptedRaids: {} },
    raid: { state: 'unknown', target: 'raid-1', value: { rpl_id: 'raid-1' } },
    wake: { kind: 'reconcileRaid', dueAt: new Date(clock.now()).toISOString() }
  });
  await clock.tick(0);
  await waitFor(worker, (status) => status.state === 'matched');
  assert.deepEqual(ids, ['raid-1']);
});

test('matched validation executes findRaid and retries ambiguous membership until confirmed absent', async (t) => {
  const clock = new FakeClock();
  const responses = [
    { rpl_id: 'raid-1', join: null },
    {},
    { rpl_id: 'raid-1', join: 'invalid' },
    { rpl_id: 'raid-1', join: 0 }
  ];
  let calls = 0;
  const worker = new AutoJoinWorker({
    adapter: { async findRaid() { calls += 1; return responses.shift(); } },
    matchedValidationIntervalMs: 25,
    clock
  });
  t.after(() => worker.shutdown());
  await worker.restore({
    ...initialSnapshot(),
    raid: { state: 'matched', target: 'raid-1', value: { rpl_id: 'raid-1', join: 1 } },
    wake: { kind: 'revalidateMatched', dueAt: new Date(clock.now()).toISOString() },
    terminal: { target: 'matched', error: null }
  });

  await clock.tick(0);
  await waitFor(worker, () => calls === 1);
  assert.equal(worker.status().state, 'matched');
  for (let expected = 2; expected <= 4; expected += 1) {
    await clock.tick(expected === 2 ? 25 : expected === 3 ? 50 : 100);
    await waitFor(worker, () => calls === expected);
    if (expected < 4) assert.equal(worker.status().state, 'matched');
  }
  assert.equal(worker.status().state, 'idle');
});

test('matched validation retains the durable match through failed and malformed raid lists', async (t) => {
  const clock = new FakeClock();
  const responses = [
    { status: 'error', text: 'Raid lookup failed.', list: [] },
    [{ unexpected: 'shape' }],
    []
  ];
  let calls = 0;
  const adapter = new RaidNowAdapter({
    fetchImpl: async () => {
      calls += 1;
      const value = responses.shift();
      return {
        ok: true,
        status: 200,
        async text() { return JSON.stringify(value); }
      };
    }
  });
  const worker = new AutoJoinWorker({ adapter, matchedValidationIntervalMs: 25, clock });
  t.after(() => worker.shutdown());
  await worker.restore({
    ...initialSnapshot(),
    raid: { state: 'matched', target: 'raid-1', value: { rpl_id: 'raid-1', join: 1 } },
    wake: { kind: 'revalidateMatched', dueAt: new Date(clock.now()).toISOString() },
    terminal: { target: 'matched', error: null }
  });

  await clock.tick(0);
  await waitFor(worker, (status) => calls === 1 && /lookup failed/i.test(status.lastError || ''));
  assert.equal(worker.status().state, 'matched');
  assert.equal(worker.status().raid.rpl_id, 'raid-1');
  assert.match(worker.status().lastError, /lookup failed/i);

  await clock.tick(25);
  await waitFor(worker, (status) => calls === 2 && /malformed|raid list/i.test(status.lastError || ''));
  assert.equal(worker.status().state, 'matched');
  assert.equal(worker.status().raid.rpl_id, 'raid-1');
  assert.match(worker.status().lastError, /malformed|raid list/i);

  await clock.tick(50);
  await waitFor(worker, () => calls === 3);
  assert.equal(worker.status().state, 'idle');
});

test('leave requested during active matched validation wins after join=1 confirmation', async (t) => {
  const clock = new FakeClock();
  let resolveValidation;
  let validationStarted = false;
  const leaves = [];
  const worker = new AutoJoinWorker({
    adapter: {
      findRaid() {
        validationStarted = true;
        return new Promise((resolve) => { resolveValidation = resolve; });
      },
      async leaveRaid(id) { leaves.push(id); return { status: 'success' }; }
    },
    matchedValidationIntervalMs: 25,
    clock
  });
  t.after(() => worker.shutdown());
  await worker.restore({
    ...initialSnapshot(),
    raid: { state: 'matched', target: 'raid-1', value: { rpl_id: 'raid-1', join: 1 } },
    wake: { kind: 'revalidateMatched', dueAt: new Date(clock.now()).toISOString() },
    terminal: { target: 'matched', error: null }
  });
  await clock.tick(0);
  await waitFor(worker, () => validationStarted);

  const leaving = worker.leaveRaid();
  await flush();
  assert.deepEqual(leaves, []);
  resolveValidation({ rpl_id: 'raid-1', join: 1 });
  assert.equal((await leaving).state, 'idle');
  assert.deepEqual(leaves, ['raid-1']);
});

test('leave requested during active matched validation resolves without a write after confirmed absence', async (t) => {
  const clock = new FakeClock();
  let resolveValidation;
  let validationStarted = false;
  let leaves = 0;
  let queueChecks = 0;
  const worker = new AutoJoinWorker({
    adapter: {
      findRaid() {
        validationStarted = true;
        return new Promise((resolve) => { resolveValidation = resolve; });
      },
      async leaveRaid() { leaves += 1; return { status: 'success' }; },
      async checkMatching() { queueChecks += 1; return { id: 'still-present' }; },
      async cancelMatching() { throw new Error('cancel rejected'); }
    },
    matchedValidationIntervalMs: 25,
    clock
  });
  t.after(() => worker.shutdown());
  await worker.restore({
    ...initialSnapshot(),
    search: { profile, selection: { ...selection, strategy: 'hybrid' }, nextQueuePollAt: null, attemptedRaids: {} },
    queue: { state: 'unknown' },
    raid: { state: 'matched', target: 'raid-1', value: { rpl_id: 'raid-1', join: 1 } },
    wake: { kind: 'revalidateMatched', dueAt: new Date(clock.now()).toISOString() },
    terminal: { target: 'matched', error: null }
  });
  await clock.tick(0);
  await waitFor(worker, () => validationStarted);

  const leaving = worker.leaveRaid();
  await flush();
  resolveValidation(null);
  const status = await leaving;
  assert.equal(status.state, 'reconciling');
  assert.equal(status.raid, null);
  assert.equal(status.queueCancelPending, true);
  assert.equal(leaves, 0);
  assert.equal(queueChecks, 0);
});

test('missing findRaid remains locked and exposes the retry error', async () => {
  const clock = new FakeClock();
  const worker = new AutoJoinWorker({ adapter: {}, pollIntervalMs: 100, clock });
  await worker.restore({
    ...initialSnapshot(), intent: 'search',
    raid: { state: 'unknown', target: 'raid-1', value: { rpl_id: 'raid-1' } },
    wake: { kind: 'reconcileRaid', dueAt: new Date(clock.now()).toISOString() }
  });
  await clock.tick(0);
  const status = await waitFor(worker, (value) => Boolean(value.nextRetryAt));
  assert.equal(status.raid.rpl_id, 'raid-1');
  assert.match(status.error, /findRaid|reconciliation/i);
});

test('stop during membership verification keeps durable reconciliation running', async () => {
  const clock = new FakeClock();
  let firstSignal;
  let calls = 0;
  const persisted = [];
  const worker = new AutoJoinWorker({
    adapter: {
      async findRaid(id, { signal }) {
        calls += 1;
        if (calls === 1) {
          firstSignal = signal;
          return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        }
        return { rpl_id: id, join: 0 };
      }
    },
    pollIntervalMs: 100,
    clock,
    persist: async (snapshot) => persisted.push(structuredClone(snapshot))
  });
  await worker.restore({
    ...initialSnapshot(),
    intent: 'search',
    search: { profile, selection: { ...selection, strategy: 'fast' }, nextQueuePollAt: null, attemptedRaids: {} },
    raid: { state: 'unknown', target: 'raid-1', value: { rpl_id: 'raid-1' } },
    wake: { kind: 'reconcileRaid', dueAt: new Date(clock.now()).toISOString() }
  });
  await clock.tick(0);
  await waitFor(worker, () => Boolean(firstSignal));
  await worker.stop();
  assert.equal(firstSignal.aborted, true);
  const durable = persisted.at(-1);
  assert.equal(durable.intent, 'stop');
  assert.equal(durable.raid.state, 'unknown');
  assert.equal(durable.wake.kind, 'reconcileRaid');
  await clock.tick(0);
  await waitFor(worker, (status) => status.state === 'stopped');
  assert.equal(calls, 2);
});

test('stop aborts the tracked adapter operation after the snapshot changes', async () => {
  const clock = new FakeClock();
  let signal;
  const worker = new AutoJoinWorker({
    adapter: {
      async listRaidsForSelection(_selection, { signal: requestSignal }) {
        signal = requestSignal;
        return new Promise((_resolve, reject) => requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true }));
      },
      async joinRaidFast() { return { status: 'success' }; }
    },
    clock
  });
  await worker.start({ profile, selection: { ...selection, strategy: 'fast' } });
  await clock.tick(0);
  await waitFor(worker, () => Boolean(signal));
  await worker.stop();
  assert.equal(signal.aborted, true);
});

test('retrying status exposes lastError through error', async () => {
  const clock = new FakeClock();
  const worker = new AutoJoinWorker({
    adapter: {
      async listRaidsForSelection() { throw new Error('temporary scan failure'); },
      async joinRaidFast() { return { status: 'success' }; }
    },
    clock
  });
  await worker.start({ profile, selection: { ...selection, strategy: 'fast' } });
  await clock.tick(0);
  const status = await waitFor(worker, (value) => value.state === 'retrying');
  assert.equal(status.error, 'temporary scan failure');
});

test('hybrid session expiry falls back to the Auto Join queue', async () => {
  const clock = new FakeClock();
  let scans = 0;
  let polls = 0;
  const worker = new AutoJoinWorker({
    adapter: {
      async createMatching() { return { status: 'success' }; },
      async listRaidsForSelection() {
        scans += 1;
        const error = new Error('The session has expired. Please restart.');
        error.status = 401;
        throw error;
      },
      async joinRaidFast() { return { status: 'success' }; },
      async pollMatching() { polls += 1; return { status: 'success', rpllm_status: 1 }; }
    },
    pollIntervalMs: 2_000,
    scanIntervalMs: 1_000,
    clock
  });
  await worker.start({ profile, selection: { ...selection, strategy: 'hybrid' } });
  await flush();
  await clock.tick(0);
  await flush();
  await clock.tick(0);
  await flush();
  assert.equal(scans, 1);
  assert.equal(polls, 1);
  assert.equal(worker.status().state, 'searching');
  assert.equal(worker.status().directScanDisabled, true);
});

test('worker exposes and executes safe local abandonment', async () => {
  const clock = new FakeClock();
  const persisted = [];
  const worker = new AutoJoinWorker({
    adapter: { async checkMatching() { return { id: 'still-present' }; } },
    pollIntervalMs: 15_000,
    clock,
    persist: async (snapshot) => persisted.push(snapshot)
  });
  await worker.restore({
    ...initialSnapshot(), intent: 'stop', retryCount: 3, opSequence: 12,
    search: { profile, selection, nextQueuePollAt: null, attemptedRaids: {} },
    queue: { state: 'unknown' },
    wake: { kind: 'reconcileQueue', dueAt: new Date(clock.now()).toISOString() },
    lastError: 'Raid NOW rejected the request.'
  });
  assert.equal(worker.status().canAbandonLocal, true);
  await worker.abandonLocal();
  assert.equal(worker.status().state, 'idle');
  assert.equal(worker.status().canAbandonLocal, false);
  assert.equal(persisted.at(-1).queue.state, 'none');
});

test('local abandonment atomically aborts an active queue check and ignores its late result', async () => {
  const clock = new FakeClock();
  const persisted = [];
  let resolveCheck;
  let checkSignal;
  const worker = new AutoJoinWorker({
    adapter: {
      checkMatching(_input, { signal }) {
        checkSignal = signal;
        return new Promise((resolve) => { resolveCheck = resolve; });
      }
    },
    clock,
    persist: async (snapshot) => persisted.push(snapshot)
  });
  await worker.restore({
    ...initialSnapshot(), intent: 'stop', retryCount: 3, opSequence: 12,
    search: { profile, selection, nextQueuePollAt: null, attemptedRaids: {} },
    queue: { state: 'unknown' },
    operation: { opId: 'check-12', kind: 'checkQueue', input: { profile, selection }, startedAt: new Date(clock.now()).toISOString(), attempt: 3 },
    lastError: 'Raid NOW rejected the request.'
  });
  await clock.tick(0);
  await flush();
  assert.equal(worker.status().canAbandonLocal, true);
  assert.ok(checkSignal);
  await worker.abandonLocal();
  assert.equal(checkSignal.aborted, true);
  assert.equal(worker.status().state, 'idle');
  resolveCheck({});
  await flush();
  assert.equal(worker.status().state, 'idle');
  assert.equal(persisted.at(-1).queue.state, 'none');
});

test('unsafe local abandonment is a lifecycle conflict', async () => {
  const worker = new AutoJoinWorker({ adapter: {} });
  await assert.rejects(
    () => worker.abandonLocal(),
    (error) => error.status === 409 && error.code === 'AUTOJOIN_CONFLICT'
  );
});

test('hybrid failures retry scans each second without delaying queue polls', async () => {
  const clock = new FakeClock();
  let scans = 0;
  let polls = 0;
  const worker = new AutoJoinWorker({
    adapter: {
      async createMatching() { return { status: 'success' }; },
      async listRaidsForSelection() {
        scans += 1;
        if (scans <= 2) throw new Error('scan unavailable');
        return [];
      },
      async joinRaidFast() { return { status: 'success' }; },
      async pollMatching() { polls += 1; throw new Error('poll unavailable'); }
    },
    pollIntervalMs: 2_000,
    scanIntervalMs: 1_000,
    clock
  });
  await worker.start({ profile, selection: { ...selection, strategy: 'hybrid' } });
  await flush();
  await clock.tick(0);
  assert.equal(scans, 1);
  await clock.tick(999);
  assert.equal(scans, 1);
  await clock.tick(1);
  assert.equal(scans, 2);
  await clock.tick(1_000);
  await waitFor(worker, () => polls === 1);
  assert.equal(scans, 3);
  await clock.tick(999);
  assert.equal(scans, 3);
  await clock.tick(1);
  assert.equal(scans, 4);
});
