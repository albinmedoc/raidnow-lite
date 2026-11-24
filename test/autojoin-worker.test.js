import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoJoinWorker, leaveRaidRejection } from '../src/core/autojoin-worker.js';
import { initialSnapshot } from '../src/core/autojoin-state-machine.js';
import { RaidNowAdapter } from '../src/adapters/raidnow-adapter.js';
import { CliRaidNowAdapter } from '../src/adapters/cli-raidnow-adapter.js';
import { CliCommandError } from '../src/adapters/cli-process-runner.js';
import {
  AdapterCapabilityError,
  diagnosticFieldsFromOutcome,
  normalizeAdapterSettlement,
  reducerEventFromOutcome,
  sanitizeDiagnosticEvent
} from '../src/core/adapter-outcome.js';

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

function cliMembershipAdapter({ raid, players, onLeave = () => {} }) {
  const runner = {
    async run({ args }) {
      const command = args.slice(3, 5).join(' ');
      if (command === 'raid get') return { data: raid };
      if (command === 'raid players') return { data: players };
      if (command === 'raid leave') {
        onLeave();
        return { data: { requested: true, verified: false, raidId: 'raid-1' } };
      }
      throw new Error(`Unexpected CLI command: ${command}`);
    }
  };
  return new CliRaidNowAdapter({ runner, tokenFile: '/run/raidnow/session.token', allowWrites: true });
}

test('malformed CLI queue presence cannot cancel or block recovered queue recreation', async () => {
  const clock = new FakeClock();
  const commands = [];
  let checks = 0;
  const runner = {
    async run({ args }) {
      const command = args.slice(3, 5).join(' ');
      commands.push(command);
      if (command === 'queue check') {
        checks += 1;
        return {
          data: checks === 1
            ? { present: 'false', id: 'queue-ghost', waiting: [] }
            : { present: false, waiting: [] }
        };
      }
      if (command === 'queue join') return { data: { created: true } };
      throw new Error(`Unexpected CLI command: ${command}`);
    }
  };
  const adapter = new CliRaidNowAdapter({ runner, tokenFile: '/run/raidnow/session.token', allowWrites: true });
  const worker = new AutoJoinWorker({ adapter, pollIntervalMs: 100, clock });

  await worker.restore({
    ...initialSnapshot(),
    intent: 'search',
    search: { profile, selection, recovering: true, nextQueuePollAt: null, attemptedRaids: {} },
    queue: { state: 'checking' },
    operation: { opId: 'check:restored', kind: 'checkQueue', input: { profile, selection }, attempt: 1 },
    terminal: { target: 'searching', error: null }
  });
  await clock.tick(0);
  await waitFor(worker, (status) => commands.length === 1 && status.lastError !== null);

  assert.match(worker.status().lastError, /invalid response/i);
  assert.equal(worker.status().queueCancelPending, false);
  assert.deepEqual(commands, ['queue check']);

  await clock.tick(100);
  await waitFor(worker, () => commands.includes('queue join'));

  assert.deepEqual(commands.slice(0, 3), ['queue check', 'queue check', 'queue join']);
  assert.equal(commands.includes('queue cancel'), false);
  worker.shutdown();
});

test('direct and CLI raid-started leave rejections share one semantic outcome', () => {
  const operation = { opId: 'leave:1', kind: 'leaveRaid', input: { raidId: 'raid-1' } };
  const text = 'The raid has been declared started and you cannot leave.';
  const direct = normalizeAdapterSettlement(operation, {
    status: 'fulfilled',
    value: { status: 'error', text }
  });
  const cli = normalizeAdapterSettlement(operation, {
    status: 'rejected',
    reason: new CliCommandError({
      message: `Upstream avvisade begäran: ${text}`,
      code: 'UPSTREAM_REJECTION',
      exitCode: 7,
      command: 'raid leave',
      status: 'rejected'
    })
  });

  assert.deepEqual(
    { message: direct.message, certainty: direct.certainty, reason: direct.reason },
    { message: cli.message, certainty: cli.certainty, reason: cli.reason }
  );
  assert.deepEqual(
    { result: diagnosticFieldsFromOutcome(direct).result, reason: diagnosticFieldsFromOutcome(direct).reason },
    { result: diagnosticFieldsFromOutcome(cli).result, reason: diagnosticFieldsFromOutcome(cli).reason }
  );
  assert.deepEqual(
    { definite: reducerEventFromOutcome(operation, direct).definite, raidAlreadyStarted: reducerEventFromOutcome(operation, direct).raidAlreadyStarted },
    { definite: reducerEventFromOutcome(operation, cli).definite, raidAlreadyStarted: reducerEventFromOutcome(operation, cli).raidAlreadyStarted }
  );
});

test('direct and CLI lobby contention map to identical cooldown and block semantics', () => {
  const operation = { opId: 'join:1', kind: 'joinRaid', input: { raidId: 'raid-1' } };
  const cases = [
    {
      text: 'The maximum number of participants has been exceeded. Use Auto join.',
      reason: 'lobbyFull',
      retryableLobbyJoin: true,
      blockLobbyJoin: false
    },
    {
      text: 'The host has declared the start of the raid and you cannot participate. Use Auto join.',
      reason: 'lobbyStarted',
      retryableLobbyJoin: true,
      blockLobbyJoin: true
    }
  ];

  for (const item of cases) {
    const direct = normalizeAdapterSettlement(operation, { status: 'fulfilled', value: { status: 'error', text: item.text } });
    const cli = normalizeAdapterSettlement(operation, {
      status: 'rejected',
      reason: new CliCommandError({
        message: `Upstream avvisade begäran: ${item.text}`,
        code: 'UPSTREAM_REJECTION', exitCode: 7, command: 'raid join', status: 'rejected'
      })
    });
    const directEvent = reducerEventFromOutcome(operation, direct);
    const cliEvent = reducerEventFromOutcome(operation, cli);
    assert.equal(direct.reason, item.reason);
    assert.equal(cli.reason, item.reason);
    assert.deepEqual(
      { retryableLobbyJoin: directEvent.retryableLobbyJoin, blockLobbyJoin: directEvent.blockLobbyJoin },
      { retryableLobbyJoin: cliEvent.retryableLobbyJoin, blockLobbyJoin: cliEvent.blockLobbyJoin }
    );
    assert.deepEqual(
      { retryableLobbyJoin: directEvent.retryableLobbyJoin, blockLobbyJoin: directEvent.blockLobbyJoin },
      { retryableLobbyJoin: item.retryableLobbyJoin, blockLobbyJoin: item.blockLobbyJoin }
    );
  }

  const longer = normalizeAdapterSettlement(operation, {
    status: 'fulfilled',
    value: { status: 'error', text: 'Validation failed because lobby is full.' }
  });
  assert.equal(longer.reason, undefined);
});

test('current trainer-code redaction preserves embedded ID digits and redacts standalone credentials', () => {
  const operation = { opId: 'create:1', kind: 'createQueue', input: { profile } };
  const embedded = normalizeAdapterSettlement(operation, {
    status: 'rejected',
    reason: new Error('Failed ID raid123456789012prod.')
  });
  const standalone = normalizeAdapterSettlement(operation, {
    status: 'rejected',
    reason: new Error('Trainer code 123456789012 rejected.')
  });

  assert.equal(embedded.message, 'Failed ID raid123456789012prod.');
  assert.equal(standalone.message, 'Trainer code [REDACTED] rejected.');
});

test('canonical outcomes are immutable and capability failures are not dispatched', () => {
  const operation = { opId: 'create:1', kind: 'createQueue', input: {} };
  const success = normalizeAdapterSettlement(operation, { status: 'fulfilled', value: { status: 'success', data: { id: 'queue-1' } } });
  const missing = normalizeAdapterSettlement(operation, { status: 'rejected', reason: new AdapterCapabilityError('Unavailable.') });

  assert.equal(Object.isFrozen(success), true);
  assert.equal(Object.isFrozen(success.value), true);
  assert.equal(Object.isFrozen(success.value.data), true);
  assert.equal(Object.isFrozen(missing), true);
  assert.equal(missing.certainty, 'not-dispatched');
  assert.equal(reducerEventFromOutcome(operation, missing).definite, true);
});

test('diagnostics and reducer projections share the canonical certainty for every write kind', () => {
  for (const kind of ['createQueue', 'cancelQueue', 'joinRaid', 'leaveRaid']) {
    const operation = { opId: `${kind}:1`, kind, input: {} };
    const outcome = normalizeAdapterSettlement(operation, {
      status: 'rejected',
      reason: Object.assign(new Error(`${kind} failed.`), { exitCode: 7 })
    });
    const diagnostic = diagnosticFieldsFromOutcome(outcome);
    const event = reducerEventFromOutcome(operation, outcome);

    assert.equal(outcome.certainty, 'unknown', kind);
    assert.equal(diagnostic.result, 'rejected', kind);
    assert.equal(diagnostic.writeOutcome, outcome.certainty, kind);
    assert.equal(event.definite, false, kind);
    assert.equal(event.error, outcome.message, kind);
  }
});

test('missing adapter write capabilities are typed not-dispatched failures without unknown reconciliation', async (t) => {
  await t.test('create', async () => {
    const diagnostics = [];
    const worker = new AutoJoinWorker({ adapter: {}, diagnostics: (event) => diagnostics.push(event) });

    await worker.start({ profile, selection });
    const status = await waitFor(worker, (value) => value.state === 'error');

    assert.equal(status.raidMembership, 'none');
    assert.equal(status.queueCancelPending, false);
    assert.equal(status.nextRetryAt, null);
    assert.match(status.error, /unavailable/i);
    assert.deepEqual(
      { code: diagnostics.at(-1).code, status: diagnostics.at(-1).status, writeOutcome: diagnostics.at(-1).writeOutcome },
      { code: 'AUTOJOIN_UNAVAILABLE', status: 501, writeOutcome: 'not-dispatched' }
    );
    worker.shutdown();
  });

  await t.test('restored cancel', async () => {
    const diagnostics = [];
    const worker = new AutoJoinWorker({
      adapter: { async checkMatching() { return { id: 'queue-1' }; } },
      diagnostics: (event) => diagnostics.push(event)
    });
    await worker.restore({
      ...initialSnapshot(),
      intent: 'stop',
      search: { profile, selection, nextQueuePollAt: null, attemptedRaids: {} },
      queue: { state: 'canceling' },
      operation: { opId: 'cancel:restored', kind: 'cancelQueue', input: {}, attempt: 1 },
      workflowNotice: {
        kind: 'leave-cleanup',
        severity: 'info',
        message: 'Raiden är avslutad i Lite. Raid NOW-kön städas innan du kan söka igen.'
      }
    });

    await waitFor(worker, (value) => diagnostics.some((event) => event.operation === 'cancelQueue') && value.state === 'stopped');
    const status = worker.status();
    assert.equal(status.queueCancelPending, true);
    assert.equal(status.nextRetryAt, null);
    assert.match(status.error, /unavailable/i);
    assert.equal(status.workflowNotice, null);
    assert.deepEqual(
      { code: diagnostics.at(-1).code, status: diagnostics.at(-1).status, writeOutcome: diagnostics.at(-1).writeOutcome },
      { code: 'AUTOJOIN_UNAVAILABLE', status: 501, writeOutcome: 'not-dispatched' }
    );
    worker.shutdown();
  });

  await t.test('restored join', async () => {
    const clock = new FakeClock();
    const diagnostics = [];
    const worker = new AutoJoinWorker({
      adapter: {
        async findRaid() { return { rpl_id: 'raid-restored', join: 0 }; },
        async listRaidPlayers() { return { players: [] }; },
        async listRaidsForSelection() { return [{ rpl_id: 'raid-restored', rpl_rank: '5', rpl_pokemon: 'Giratina' }]; }
      },
      pollIntervalMs: 100,
      scanIntervalMs: 100,
      clock,
      diagnostics: (event) => diagnostics.push(event)
    });
    await worker.restore({
      ...initialSnapshot(),
      intent: 'search',
      search: { profile, selection: { ...selection, strategy: 'hybrid' }, nextQueuePollAt: null, attemptedRaids: {} },
      queue: { state: 'none' },
      raid: { state: 'joining', target: 'raid-restored', value: { rpl_id: 'raid-restored' } },
      operation: { opId: 'join:restored', kind: 'joinRaid', input: { raidId: 'raid-restored' }, attempt: 1 }
    });

    await flush();
    await clock.tick(100);
    await waitFor(worker, (value) => value.nextPollAt !== null);
    await clock.tick(100);
    await waitFor(worker, () => diagnostics.some((event) => event.operation === 'joinRaid'));
    const status = worker.status();
    assert.notEqual(status.raidMembership, 'unknown');
    assert.equal(status.nextRetryAt, null);
    assert.match(status.error, /unavailable/i);
    assert.deepEqual(
      { code: diagnostics.at(-1).code, status: diagnostics.at(-1).status, writeOutcome: diagnostics.at(-1).writeOutcome },
      { code: 'AUTOJOIN_UNAVAILABLE', status: 501, writeOutcome: 'not-dispatched' }
    );
    worker.shutdown();
  });
});

test('missing adapter read capabilities fail as typed unavailable errors without write diagnostics', async () => {
  const diagnostics = [];
  let rejection;
  const worker = new AutoJoinWorker({
    adapter: {},
    pollIntervalMs: 100,
    diagnostics: (event) => diagnostics.push(event),
    runOperation: async (operation) => {
      try {
        return await operation();
      } catch (error) {
        rejection = error;
        throw error;
      }
    }
  });
  await worker.restore({
    ...initialSnapshot(),
    intent: 'stop',
    search: { profile, selection, nextQueuePollAt: null, attemptedRaids: {} },
    queue: { state: 'checking' },
    operation: { opId: 'check:restored', kind: 'checkQueue', input: {}, attempt: 1 }
  });

  const status = await waitFor(worker, (value) => value.lastError !== null);
  assert.ok(rejection instanceof AdapterCapabilityError);
  assert.equal(rejection.status, 501);
  assert.equal(rejection.code, 'AUTOJOIN_UNAVAILABLE');
  assert.match(status.lastError, /unavailable/i);
  assert.doesNotMatch(status.lastError, /is not a function|TypeError/);
  assert.deepEqual(diagnostics, []);
  worker.shutdown();
});

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

test('final diagnostic boundary fully redacts labeled formatted trainer codes without changing alphanumeric IDs', () => {
  const cases = {
    message: 'trainer code: 1234 5678 9012',
    raidId: 'trainer_code=123456789012',
    command: 'trainer-code: 1234-5678-9012',
    code: 'failure trainer code=1234 5678 9012 suffix',
    status: 'trainer code: 1234-5678-9012'
  };
  const ordinaryIds = {
    message: 'raid123456789012x',
    raidId: 'abc1234-5678-9012xyz',
    command: 'join raid123456789012x',
    code: 'ERR123456789012X',
    status: 'status1234-5678-9012ok'
  };

  const sanitized = sanitizeDiagnosticEvent({ ...cases });
  for (const field of Object.keys(cases)) {
    assert.match(sanitized[field], /\[REDACTED\]/, field);
    assert.doesNotMatch(sanitized[field], /1234|5678|9012/, field);
  }
  assert.deepEqual(sanitizeDiagnosticEvent({ ...ordinaryIds }), ordinaryIds);
});

test('final diagnostic boundary redacts formatted trainer codes before truncation', () => {
  const message = `${'x '.repeat(240)}trainer code: 1234 5678 9012`;
  const sanitized = sanitizeDiagnosticEvent({ message });

  assert.ok(sanitized.message.length <= 512);
  assert.doesNotMatch(sanitized.message, /1234|5678|9012/);
});

test('final diagnostic boundary sanitizes and bounds every string field after raid metadata is appended', async () => {
  const clock = new FakeClock();
  const diagnostics = [];
  const longSecret = `token=${'A'.repeat(600)}`;
  const rejection = Object.assign(new Error(`message ${longSecret}`), {
    code: `code authorization=Bearer-${'B'.repeat(80)}`,
    command: `raid join gofriend_token=${'C'.repeat(80)}`,
    status: `status token:${'D'.repeat(80)}`,
    writeOutcome: 'not-dispatched'
  });
  const worker = new AutoJoinWorker({
    adapter: {
      async createMatching() { return { status: 'success' }; },
      async listRaidsForSelection() { return [{ rpl_id: '123456789012', rpl_rank: '5', rpl_pokemon: 'Giratina' }]; },
      async joinRaidFast() { throw rejection; }
    },
    pollIntervalMs: 100,
    clock,
    diagnostics: (event) => diagnostics.push(event)
  });

  await worker.start({ profile, selection: { ...selection, strategy: 'hybrid' } });
  await waitFor(worker, (status) => status.nextPollAt !== null);
  await clock.tick(0);
  await waitFor(worker, () => diagnostics.some((event) => event.operation === 'joinRaid'));

  const event = diagnostics.find((item) => item.operation === 'joinRaid');
  for (const field of ['message', 'raidId', 'command', 'code', 'status']) {
    assert.equal(typeof event[field], 'string', field);
    assert.match(event[field], /\[REDACTED\]/, field);
    assert.ok(event[field].length <= 512, `${field} was not bounded`);
  }
  const serialized = JSON.stringify(event);
  assert.equal(serialized.includes('123456789012'), false);
  for (const marker of ['A'.repeat(40), 'B'.repeat(40), 'C'.repeat(40), 'D'.repeat(40)]) {
    assert.equal(serialized.includes(marker), false);
  }
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
  assert.equal(worker.status().queueCancelPending, true);
  assert.notEqual(worker.status().nextRetryAt, null);
  worker.shutdown();
});

test('fulfilled direct create and cancel rejections are definite and never confirmed', async (t) => {
  await t.test('create', async () => {
    const diagnostics = [];
    const worker = new AutoJoinWorker({
      adapter: {
        async createMatching() { return { status: 'error', text: 'Queue create rejected.' }; }
      },
      diagnostics: (event) => diagnostics.push(event)
    });

    await worker.start({ profile, selection });
    const status = await waitFor(worker, (value) => value.state === 'error');
    assert.equal(status.queueCancelPending, false);
    assert.equal(status.error, 'Queue create rejected.');
    assert.deepEqual(
      { result: diagnostics.at(-1).result, writeOutcome: diagnostics.at(-1).writeOutcome },
      { result: 'rejected', writeOutcome: 'definite' }
    );
    worker.shutdown();
  });

  await t.test('cancel', async () => {
    const diagnostics = [];
    const worker = new AutoJoinWorker({
      adapter: {
        async cancelMatching() { return { status: 'error', text: 'Queue cancel rejected.' }; }
      },
      diagnostics: (event) => diagnostics.push(event)
    });
    await worker.restore({
      ...initialSnapshot(),
      intent: 'idle',
      search: { profile, selection, nextQueuePollAt: null, attemptedRaids: {} },
      queue: { state: 'present' }
    });

    await worker.stop();
    await waitFor(worker, () => diagnostics.some((event) => event.operation === 'cancelQueue'));
    assert.equal(worker.status().queueCancelPending, true);
    assert.equal(worker.status().lastError, 'Queue cancel rejected.');
    assert.deepEqual(
      { result: diagnostics.at(-1).result, writeOutcome: diagnostics.at(-1).writeOutcome },
      { result: 'rejected', writeOutcome: 'definite' }
    );
    worker.shutdown();
  });
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
    async listRaidPlayers() { return { players: [] }; },
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

test('a started raid that cannot be left is dismissed locally so a new search can be configured', async () => {
  const clock = new FakeClock();
  const rejection = new CliCommandError({
    message: 'Upstream avvisade begäran: The raid has been declared started and you cannot leave.',
    code: 'UPSTREAM_REJECTION', exitCode: 7, command: 'raid leave', status: 'rejected'
  });
  const worker = new AutoJoinWorker({
    adapter: { async leaveRaid() { throw rejection; } },
    clock,
    pollIntervalMs: 100,
    persist: async () => {}
  });
  await worker.restore({
    ...initialSnapshot(),
    intent: 'idle',
    search: { profile, selection: { ...selection, strategy: 'hybrid' }, nextQueuePollAt: null, attemptedRaids: {} },
    queue: { state: 'none' },
    raid: { state: 'matched', target: 'raid-started', value: { rpl_id: 'raid-started' } },
    terminal: { target: 'matched', error: null },
    wake: { kind: 'revalidateMatched', dueAt: new Date(clock.now() + 60_000).toISOString() }
  });

  const status = await worker.leaveRaid();
  assert.equal(status.state, 'idle');
  assert.equal(status.raid, null);
  assert.equal(status.selection, null);
  worker.shutdown();
});

test('the direct adapter completes an exact started-raid leave rejection locally and continues queue cleanup', async () => {
  const clock = new FakeClock();
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const type = new URLSearchParams(options.body).get('type');
    calls.push(type);
    if (type === 'par_find_first') {
      return { ok: true, status: 200, async text() { return JSON.stringify([{ rpl_id: 'raid-started', join: 1 }]); } };
    }
    if (type === 'guest_raid_del_post') {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ status: 'error', text: 'The raid has been declared started and you cannot leave' });
        }
      };
    }
    if (type === 'child_list') {
      return { ok: true, status: 200, async text() { return JSON.stringify({ list: [], rpl_delete: 0 }); } };
    }
    if (type === 'line_matching_cancel') {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    }
    throw new Error(`Unexpected operation: ${type}`);
  };
  const worker = new AutoJoinWorker({
    adapter: new RaidNowAdapter({ fetchImpl, allowWrites: true }),
    clock,
    pollIntervalMs: 100,
    persist: async () => {}
  });
  await worker.restore({
    ...initialSnapshot(),
    intent: 'idle',
    search: { profile, selection: { ...selection, strategy: 'hybrid' }, nextQueuePollAt: null, attemptedRaids: {} },
    queue: { state: 'present' },
    raid: { state: 'matched', target: 'raid-started', value: { rpl_id: 'raid-started' } },
    terminal: { target: 'matched', error: null },
    wake: { kind: 'revalidateMatched', dueAt: new Date(clock.now() + 60_000).toISOString() }
  });

  const leaving = worker.leaveRaid();
  await flush();
  await clock.tick(0);
  const status = await leaving;
  await waitFor(worker, () => calls.includes('line_matching_cancel'));
  assert.deepEqual(calls, ['par_find_first', 'child_list', 'guest_raid_del_post', 'line_matching_cancel']);
  assert.equal(status.state, 'reconciling');
  assert.equal(status.raid, null);
  assert.equal(status.queueCancelPending, true);
  worker.shutdown();
});

test('a longer leave rejection containing the started phrase is not treated as local completion', async () => {
  const clock = new FakeClock();
  const rejection = new CliCommandError({
    message: 'Upstream avvisade begäran: Temporary validation failed after The raid has been declared started and you cannot leave.',
    code: 'UPSTREAM_REJECTION', exitCode: 7, command: 'raid leave', status: 'rejected'
  });
  const worker = new AutoJoinWorker({
    adapter: { async leaveRaid() { throw rejection; }, async findRaid() { return { rpl_id: 'raid-started', join: 1 }; } },
    clock,
    matchedValidationIntervalMs: 100,
    persist: async () => {}
  });
  await worker.restore({
    ...initialSnapshot(),
    intent: 'idle',
    search: { profile, selection: { ...selection, strategy: 'hybrid' }, nextQueuePollAt: null, attemptedRaids: {} },
    queue: { state: 'none' },
    raid: { state: 'matched', target: 'raid-started', value: { rpl_id: 'raid-started' } },
    terminal: { target: 'matched', error: null },
    wake: { kind: 'revalidateMatched', dueAt: new Date(clock.now() + 60_000).toISOString() }
  });

  await assert.rejects(() => worker.leaveRaid(), /Temporary validation failed/);
  assert.equal(worker.status().state, 'matched');
  assert.equal(worker.status().raid.rpl_id, 'raid-started');
  worker.shutdown();
});

test('started-raid local completion requires the exact typed rejection boundary', () => {
  const cases = [
    {
      name: 'altered punctuation',
      error: new CliCommandError({
        message: 'Upstream avvisade begäran: The raid has been declared started and you cannot leave!',
        code: 'UPSTREAM_REJECTION', exitCode: 7, command: 'raid leave', status: 'rejected'
      })
    },
    {
      name: 'wrong stable code',
      error: new CliCommandError({
        message: 'Upstream avvisade begäran: The raid has been declared started and you cannot leave.',
        code: 'UNKNOWN_WRITE_RESULT', exitCode: 7, command: 'raid leave', status: 'unknown'
      })
    },
    {
      name: 'wrong exit code',
      error: new CliCommandError({
        message: 'Upstream avvisade begäran: The raid has been declared started and you cannot leave.',
        code: 'UPSTREAM_REJECTION', exitCode: 9, command: 'raid leave', status: 'rejected'
      })
    },
    {
      name: 'untyped error',
      error: new Error('Upstream avvisade begäran: The raid has been declared started and you cannot leave.')
    },
    {
      name: 'fulfilled success shape',
      error: { status: 'success', text: 'The raid has been declared started and you cannot leave' }
    },
    {
      name: 'non-string rejection text',
      error: { status: 'error', text: { message: 'The raid has been declared started and you cannot leave' } }
    }
  ];

  for (const item of cases) assert.equal(leaveRaidRejection(item.error), null, item.name);
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
      async findRaid() { membershipChecks += 1; order.push('raid'); return null; },
      async listRaidPlayers() { return { players: [], raidDeleted: true }; }
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
      async findRaid() { membershipChecks += 1; return null; },
      async listRaidPlayers() { return { players: [], raidDeleted: true }; }
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
      async listRaidPlayers() { return { players: [], raidDeleted: true }; },
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
      async findRaid() { membershipChecks += 1; return null; },
      async listRaidPlayers() { return { players: [], raidDeleted: true }; }
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
  assert.equal(worker.status().state, 'reconciling');
  assert.equal(worker.status().raidMembership, 'unknown');
  assert.equal(worker.status().nextRetryAt, new Date(clock.now() + 100).toISOString());

  await clock.tick(99);
  assert.equal(settled, false);
  assert.equal(membershipChecks, 0);
  await clock.tick(1);
  assert.equal((await leaving).state, 'idle');
  assert.equal(membershipChecks, 1);
});

test('recovery leave after an interrupted leave probes membership before any second write', async (t) => {
  const cases = [
    {
      name: 'present membership permits exactly one new leave write',
      exact: async () => ({ rpl_id: 'raid-1', join: 1 }),
      players: async () => { throw new Error('players failed'); },
      expectedLeaves: 1,
      expectedState: 'idle'
    },
    {
      name: 'confirmed absence completes locally without a leave write',
      exact: async () => null,
      players: async () => ({ players: [], raidDeleted: true }),
      expectedLeaves: 0,
      expectedState: 'idle'
    },
    {
      name: 'ambiguous membership remains reconciling without a leave write',
      exact: async () => ({ rpl_id: 'raid-1', join: null }),
      players: async () => ({ players: [], raidDeleted: false }),
      expectedLeaves: 0,
      expectedState: 'reconciling',
      pending: true
    },
    {
      name: 'membership read failure remains reconciling without a leave write',
      exact: async () => { throw new Error('exact read failed'); },
      players: async () => { throw new Error('players read failed'); },
      expectedLeaves: 0,
      expectedState: 'reconciling',
      pending: true
    }
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const clock = new FakeClock();
      const order = [];
      let leaves = 0;
      const worker = new AutoJoinWorker({
        adapter: {
          async findRaid() { order.push('exact'); return item.exact(); },
          async listRaidPlayers() { order.push('players'); return item.players(); },
          async leaveRaid() { leaves += 1; order.push('leave'); return { status: 'success' }; }
        },
        pollIntervalMs: 100,
        clock
      });
      await worker.restore({
        ...initialSnapshot(),
        intent: 'leave',
        raid: { state: 'leaving', target: 'raid-1', value: { rpl_id: 'raid-1' } },
        operation: { opId: 'leave-before-restart', kind: 'leaveRaid', input: { raidId: 'raid-1' }, startedAt: new Date(clock.now()).toISOString(), attempt: 1 }
      });

      const leaving = worker.leaveRaid();
      try {
        await flush();
        assert.deepEqual(order.slice(0, 2).sort(), ['exact', 'players']);
        assert.equal(leaves, item.expectedLeaves);
        assert.equal(worker.status().state, item.expectedState);
        if (item.pending) {
          const outcome = await Promise.race([
            leaving.then(() => 'settled', () => 'settled'),
            new Promise((resolve) => setImmediate(() => resolve('pending')))
          ]);
          assert.equal(outcome, 'pending');
        } else {
          assert.equal((await leaving).state, 'idle');
        }
      } finally {
        worker.shutdown();
        await leaving.catch(() => {});
      }
    });
  }
});

test('read-only recovery completes locally when membership is already absent', async () => {
  const clock = new FakeClock();
  const reads = [];
  const worker = new AutoJoinWorker({
    adapter: {
      async findRaid(id) { reads.push(`exact:${id}`); return { rpl_id: id, join: 0 }; },
      async listRaidPlayers(id) { reads.push(`players:${id}`); return { players: [], raidDeleted: false }; }
    },
    pollIntervalMs: 100,
    clock
  });
  await worker.restore({
    ...initialSnapshot(),
    raid: { state: 'unknown', target: 'raid-1', value: { rpl_id: 'raid-1', rpl_pokemon: 'Giratina' } },
    wake: { kind: 'reconcileRaid', dueAt: new Date(clock.now() + 60_000).toISOString() }
  });

  const status = await worker.leaveRaid();
  assert.deepEqual(reads.sort(), ['exact:raid-1', 'players:raid-1']);
  assert.equal(status.state, 'idle');
  assert.equal(status.raid, null);
  worker.shutdown();
});

test('read-only recovery returns a typed not-dispatched 501 only after presence is confirmed', async () => {
  const clock = new FakeClock();
  const reads = [];
  const diagnostics = [];
  const worker = new AutoJoinWorker({
    adapter: {
      async findRaid(id) { reads.push(`exact:${id}`); return { rpl_id: id, join: 1 }; },
      async listRaidPlayers(id) { reads.push(`players:${id}`); return { players: [], raidDeleted: false }; }
    },
    pollIntervalMs: 100,
    matchedValidationIntervalMs: 100,
    clock,
    diagnostics: (event) => diagnostics.push(event)
  });
  await worker.restore({
    ...initialSnapshot(),
    raid: { state: 'unknown', target: 'raid-1', value: { rpl_id: 'raid-1', rpl_pokemon: 'Giratina' } },
    wake: { kind: 'reconcileRaid', dueAt: new Date(clock.now() + 60_000).toISOString() }
  });

  await assert.rejects(
    () => worker.leaveRaid(),
    (error) => error.status === 501 && error.code === 'AUTOJOIN_UNAVAILABLE'
  );
  assert.deepEqual(reads.sort(), ['exact:raid-1', 'players:raid-1']);
  assert.equal(worker.status().state, 'matched');
  assert.equal(worker.status().raid.rpl_id, 'raid-1');
  assert.equal(worker.status().nextRetryAt, null);
  assert.deepEqual(worker.status().workflowNotice, {
    kind: 'leave-unavailable',
    severity: 'error',
    message: 'Raiden kunde inte lämnas eftersom funktionen inte är tillgänglig.'
  });
  await clock.tick(100);
  await waitFor(worker, (status) => status.nextPollAt !== null);
  assert.equal(worker.status().workflowNotice.kind, 'leave-unavailable');
  const leaveDiagnostic = diagnostics.find((event) => event.operation === 'leaveRaid');
  assert.equal(leaveDiagnostic.writeOutcome, 'not-dispatched');
  worker.shutdown();
});

test('unknown recovery failures expose an authoritative workflow issue', async () => {
  const clock = new FakeClock();
  const worker = new AutoJoinWorker({
    adapter: {
      async findRaid() { throw new Error('exact read failed'); },
      async listRaidPlayers() { throw new Error('players read failed'); }
    },
    pollIntervalMs: 100,
    clock
  });
  await worker.restore({
    ...initialSnapshot(),
    intent: 'leave',
    raid: { state: 'unknown', target: 'raid-1', value: { rpl_id: 'raid-1' } },
    wake: { kind: 'reconcileRaid', dueAt: new Date(clock.now()).toISOString() }
  });

  await clock.tick(0);
  const status = await waitFor(worker, (value) => value.nextRetryAt !== null);
  assert.deepEqual(status.workflowNotice, {
    kind: 'raid-reconciliation-failed',
    severity: 'error',
    message: 'Raid-medlemskapet kunde inte bekräftas. Lite försöker igen.'
  });
  worker.shutdown();
});

test('confirmed leave projects cleanup and durable terminal completion notices', async () => {
  const clock = new FakeClock();
  let resolveCancel;
  const worker = new AutoJoinWorker({
    adapter: {
      async findRaid() { return { rpl_id: 'raid-1', join: 1 }; },
      async listRaidPlayers() { return { players: [] }; },
      async leaveRaid() { return { status: 'success' }; },
      async cancelMatching() { return new Promise((resolve) => { resolveCancel = resolve; }); },
      async checkMatching() { return {}; }
    },
    pollIntervalMs: 100,
    clock
  });
  await worker.restore({
    ...initialSnapshot(),
    search: { profile, selection, nextQueuePollAt: null, attemptedRaids: {} },
    queue: { state: 'present' },
    raid: { state: 'matched', target: 'raid-1', value: { rpl_id: 'raid-1' } },
    terminal: { target: 'matched', error: null }
  });

  const leaving = worker.leaveRaid();
  await flush();
  await clock.tick(0);
  const cleanup = await leaving;
  assert.deepEqual(cleanup.workflowNotice, {
    kind: 'leave-cleanup',
    severity: 'info',
    message: 'Raiden är avslutad i Lite. Raid NOW-kön städas innan du kan söka igen.'
  });
  resolveCancel({ status: 'success' });
  await flush();
  const complete = await waitFor(worker, (value) => value.state === 'idle');
  assert.deepEqual(complete.workflowNotice, {
    kind: 'leave-complete',
    severity: 'success',
    message: 'Raiden är avslutad i Lite. Du kan ändra valen och söka igen.'
  });

  const restored = new AutoJoinWorker({ adapter: {}, clock });
  await restored.restore({ ...initialSnapshot(), workflowNotice: complete.workflowNotice });
  assert.deepEqual(restored.status().workflowNotice, complete.workflowNotice);
  worker.shutdown();
  restored.shutdown();
});

test('durable raid target overrides a stale saved raid ID in status and reconciliation', async () => {
  const clock = new FakeClock();
  const probed = [];
  const worker = new AutoJoinWorker({
    adapter: {
      async findRaid(id) { probed.push(id); return { rpl_id: id, join: null }; },
      async listRaidPlayers(id) { probed.push(id); return { players: [], raidDeleted: false }; }
    },
    pollIntervalMs: 100,
    clock
  });
  await worker.restore({
    ...initialSnapshot(),
    intent: 'search',
    raid: { state: 'unknown', target: 'raid-durable-target', value: { rpl_id: 'raid-stale', rpl_pokemon: 'Giratina' } },
    wake: { kind: 'reconcileRaid', dueAt: new Date(clock.now()).toISOString() },
    terminal: { target: 'searching', error: null }
  });

  assert.equal(worker.status().raid.rpl_id, 'raid-durable-target');
  assert.equal(worker.status().canRequestLeave, true);
  await clock.tick(0);
  await waitFor(worker, (status) => status.nextRetryAt !== null);
  assert.deepEqual(probed, ['raid-durable-target', 'raid-durable-target']);
  assert.equal(worker.status().raid.rpl_id, 'raid-durable-target');
  worker.shutdown();
});

test('mismatched exact raid evidence never retargets or authorizes a leave write', async () => {
  const clock = new FakeClock();
  const probed = [];
  const leaves = [];
  const worker = new AutoJoinWorker({
    adapter: {
      async findRaid(id) { probed.push(id); return { rpl_id: 'raid-b', join: 1, rpl_pokemon: 'Wrong boss' }; },
      async listRaidPlayers(id) { probed.push(id); return { players: [], raidDeleted: false }; },
      async leaveRaid(id) { leaves.push(id); return { status: 'success' }; }
    },
    pollIntervalMs: 100,
    clock
  });
  await worker.restore({
    ...initialSnapshot(),
    intent: 'leave',
    raid: { state: 'unknown', target: 'raid-a', value: { rpl_id: 'raid-b', rpl_pokemon: 'Saved boss' } },
    wake: { kind: 'reconcileRaid', dueAt: new Date(clock.now()).toISOString() }
  });

  await clock.tick(0);
  await waitFor(worker, (status) => status.nextRetryAt !== null);
  assert.deepEqual(probed, ['raid-a', 'raid-a']);
  assert.deepEqual(leaves, []);
  assert.equal(worker.status().raid.rpl_id, 'raid-a');
  assert.equal(worker.status().raid.rpl_pokemon, 'Saved boss');
  assert.equal(worker.status().raidMembership, 'unknown');
  worker.shutdown();
});

test('unknown durable raid membership exposes an explicit leave capability', async () => {
  const worker = new AutoJoinWorker({ adapter: {} });
  await worker.restore({
    ...initialSnapshot(),
    intent: 'search',
    raid: { state: 'unknown', target: 'raid-durable-target', value: { rpl_id: 'raid-1', rpl_pokemon: 'Giratina' } },
    wake: { kind: 'reconcileRaid', dueAt: '2026-11-11T10:01:00.000Z' },
    terminal: { target: 'searching', error: null }
  });

  const status = worker.status();
  assert.equal(status.state, 'reconciling');
  assert.equal(status.raidMembership, 'unknown');
  assert.equal(status.raid.rpl_id, 'raid-durable-target');
  assert.equal(status.canRequestLeave, true);
  worker.shutdown();
});

test('unknown durable raid target completes a partial projected raid value', async () => {
  const worker = new AutoJoinWorker({ adapter: {} });
  await worker.restore({
    ...initialSnapshot(),
    intent: 'search',
    raid: { state: 'unknown', target: 'raid-known', value: { rpl_pokemon: 'Giratina' } },
    wake: { kind: 'reconcileRaid', dueAt: '2026-11-11T10:01:00.000Z' },
    terminal: { target: 'searching', error: null }
  });

  const status = worker.status();
  assert.deepEqual(status.raid, { rpl_pokemon: 'Giratina', rpl_id: 'raid-known' });
  assert.equal(status.canRequestLeave, true);
  worker.shutdown();
});

test('direct adapter longer and different leave rejections keep the raid matched with an error', async () => {
  for (const text of [
    'Validation failed: The raid has been declared started and you cannot leave',
    'Raid membership cannot be removed.'
  ]) {
    const diagnostics = [];
    const worker = new AutoJoinWorker({
      adapter: {
        async leaveRaid() { return { status: 'error', text }; }
      },
      diagnostics: (event) => diagnostics.push(event)
    });
    await worker.restore({
      ...initialSnapshot(),
      raid: { state: 'matched', target: 'raid-1', value: { rpl_id: 'raid-1' } },
      terminal: { target: 'matched', error: null }
    });

    await assert.rejects(() => worker.leaveRaid(), (error) => error.message === text);
    assert.equal(worker.status().state, 'matched');
    assert.equal(worker.status().raid.rpl_id, 'raid-1');
    assert.equal(worker.status().error, text);
    assert.equal(diagnostics.at(-1).result, 'rejected');
    assert.equal(diagnostics.at(-1).writeOutcome, 'definite');
    worker.shutdown();
  }
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

test('reconcileRaid calls both membership readers for the uncertain target', async () => {
  const clock = new FakeClock();
  const ids = [];
  const worker = new AutoJoinWorker({
    adapter: {
      async findRaid(id) { ids.push(`exact:${id}`); return { rpl_id: id, join: 1 }; },
      async listRaidPlayers(id) { ids.push(`players:${id}`); return { players: [] }; }
    },
    pollIntervalMs: 100,
    clock
  });
  await worker.restore({
    ...initialSnapshot(), intent: 'search',
    search: { profile, selection: { ...selection, strategy: 'fast' }, nextQueuePollAt: null, attemptedRaids: {} },
    raid: { state: 'unknown', target: 'raid-1', value: { rpl_id: 'raid-1' } },
    wake: { kind: 'reconcileRaid', dueAt: new Date(clock.now()).toISOString() }
  });
  await clock.tick(0);
  await waitFor(worker, (status) => status.state === 'matched');
  assert.deepEqual(ids.sort(), ['exact:raid-1', 'players:raid-1']);
});

test('membership probe clears an ended raid when players report deletion even if exact raid exists', async () => {
  const clock = new FakeClock();
  let leaves = 0;
  const worker = new AutoJoinWorker({
    adapter: {
      async findRaid() { return { rpl_id: 'raid-1', join: 1, rpl_pokemon: 'Giratina' }; },
      async listRaidPlayers() { return { players: [], raidDeleted: true }; },
      async leaveRaid() { leaves += 1; return { status: 'success' }; }
    },
    pollIntervalMs: 100,
    clock
  });
  await worker.restore({
    ...initialSnapshot(),
    intent: 'leave',
    raid: { state: 'unknown', target: 'raid-1', value: { rpl_id: 'raid-1', rpl_pokemon: 'Saved Giratina' } },
    wake: { kind: 'reconcileRaid', dueAt: new Date(clock.now()).toISOString() }
  });

  await clock.tick(0);
  await waitFor(worker, (status) => status.state === 'idle');
  assert.equal(worker.status().raid, null);
  assert.equal(leaves, 0);
  worker.shutdown();
});

test('membership probe combines exact and player evidence conservatively before leave writes', async (t) => {
  const cases = [
    {
      name: 'exact deletion wins when players fail',
      exact: async () => ({ rpl_id: 'raid-1', deleted: true }),
      players: async () => { throw new Error('players failed'); },
      expectedLeaves: 0,
      expectedMembership: 'none'
    },
    {
      name: 'player isMe proves presence when exact lookup is null',
      exact: async () => null,
      players: async () => ({ players: [{ isMe: true }], raidDeleted: false }),
      expectedLeaves: 1,
      expectedMembership: 'none'
    },
    {
      name: 'player isMe proves presence when exact lookup fails',
      exact: () => { throw new Error('exact failed'); },
      players: async () => ({ players: [{ isMe: true }], raidDeleted: false }),
      expectedLeaves: 1,
      expectedMembership: 'none'
    },
    {
      name: 'exact my proves presence when players fail',
      exact: async () => ({ rpl_id: 'raid-1', my: 1 }),
      players: async () => { throw new Error('players failed'); },
      expectedLeaves: 1,
      expectedMembership: 'none'
    },
    {
      name: 'exact join zero proves absence',
      exact: async () => ({ rpl_id: 'raid-1', join: 0 }),
      players: async () => ({ players: [], raidDeleted: false }),
      expectedLeaves: 0,
      expectedMembership: 'none'
    },
    {
      name: 'exact null and players without me remain unknown',
      exact: async () => null,
      players: async () => ({ players: [{ isMe: false }], raidDeleted: false }),
      expectedLeaves: 0,
      expectedMembership: 'unknown'
    },
    {
      name: 'both read failures remain unknown',
      exact: async () => { throw new Error('exact failed'); },
      players: async () => { throw new Error('players failed'); },
      expectedLeaves: 0,
      expectedMembership: 'unknown'
    }
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const clock = new FakeClock();
      let leaves = 0;
      const worker = new AutoJoinWorker({
        adapter: {
          findRaid: item.exact,
          listRaidPlayers: item.players,
          async leaveRaid() { leaves += 1; return { status: 'success' }; }
        },
        pollIntervalMs: 100,
        clock
      });
      await worker.restore({
        ...initialSnapshot(),
        intent: 'leave',
        raid: { state: 'unknown', target: 'raid-1', value: { rpl_id: 'raid-1', rpl_pokemon: 'Saved boss' } },
        wake: { kind: 'reconcileRaid', dueAt: new Date(clock.now()).toISOString() }
      });
      await clock.tick(0);
      await flush();
      assert.equal(leaves, item.expectedLeaves);
      assert.equal(worker.status().raidMembership, item.expectedMembership);
      if (item.expectedMembership === 'unknown') {
        assert.equal(worker.status().raid.rpl_pokemon, 'Saved boss');
        assert.equal(worker.status().nextRetryAt, new Date(clock.now() + 100).toISOString());
      }
      worker.shutdown();
    });
  }
});

test('malformed membership markers never authorize leave regardless of read completion order', async (t) => {
  for (const first of ['exact', 'players']) {
    await t.test(`${first} read completes first`, async () => {
      const clock = new FakeClock();
      let resolveExact;
      let resolvePlayers;
      let leaves = 0;
      const worker = new AutoJoinWorker({
        adapter: {
          findRaid() {
            return new Promise((resolve) => { resolveExact = resolve; });
          },
          listRaidPlayers() {
            return new Promise((resolve) => { resolvePlayers = resolve; });
          },
          async leaveRaid() { leaves += 1; return { status: 'success' }; }
        },
        pollIntervalMs: 100,
        clock
      });
      await worker.restore({
        ...initialSnapshot(),
        intent: 'leave',
        raid: { state: 'unknown', target: 'raid-1', value: { rpl_id: 'raid-1', rpl_pokemon: 'Saved boss' } },
        wake: { kind: 'reconcileRaid', dueAt: new Date(clock.now()).toISOString() }
      });
      await clock.tick(0);
      await waitFor(worker, () => Boolean(resolveExact) && Boolean(resolvePlayers));

      const resolve = {
        exact: () => resolveExact({ rpl_id: 'raid-1', join: true, my: true }),
        players: () => resolvePlayers({ players: [{ isMe: 1 }, { isMe: '1' }], raidDeleted: false })
      };
      resolve[first]();
      await flush();
      assert.equal(leaves, 0);
      resolve[first === 'exact' ? 'players' : 'exact']();
      await flush();

      assert.equal(leaves, 0);
      assert.equal(worker.status().raidMembership, 'unknown');
      assert.equal(worker.status().raid.rpl_pokemon, 'Saved boss');
      worker.shutdown();
    });
  }
});

test('malformed CLI deletion booleans cannot clear a durable matched raid', async (t) => {
  const cases = [
    { name: 'string false raid deletion', raidDeleted: false, deleted: 'false' },
    { name: 'numeric zero player deletion', raidDeleted: 0, deleted: false },
    { name: 'numeric one player deletion', raidDeleted: 1, deleted: false },
    { name: 'object raid deletion', raidDeleted: false, deleted: {} }
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const clock = new FakeClock();
      const adapter = cliMembershipAdapter({
        raid: {
          id: 'raid-1', rank: '5', pokemonId: '150', hostName: 'Host', hostLevel: 50,
          country: 'se', weather: 0, maxUsers: 10, count: 1, readyCount: 0,
          joinState: null, deleted: item.deleted, isMe: false, minimumGuestLevel: 0
        },
        players: { players: [], count: 0, readyCount: 0, raidDeleted: item.raidDeleted }
      });
      const worker = new AutoJoinWorker({ adapter, matchedValidationIntervalMs: 25, clock });
      await worker.restore({
        ...initialSnapshot(),
        intent: 'search',
        search: { profile, selection, attemptedRaids: {} },
        raid: { state: 'matched', target: 'raid-1', value: { rpl_id: 'raid-1', rpl_pokemon: 'Saved boss' } },
        wake: { kind: 'revalidateMatched', dueAt: new Date(clock.now()).toISOString() },
        terminal: { target: 'matched', error: null }
      });

      await clock.tick(0);
      await waitFor(worker, (status) => Boolean(status.lastError));
      assert.equal(worker.status().state, 'matched');
      assert.equal(worker.status().raid.rpl_pokemon, 'Saved boss');
      worker.shutdown();
    });
  }
});

test('malformed CLI identity booleans cannot authorize a leave write', async (t) => {
  const cases = [
    { name: 'string false raid identity', raidIsMe: 'false', playerIsMe: false },
    { name: 'numeric zero player identity', raidIsMe: false, playerIsMe: 0 },
    { name: 'numeric one player identity', raidIsMe: false, playerIsMe: 1 },
    { name: 'object raid identity', raidIsMe: {}, playerIsMe: false }
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const clock = new FakeClock();
      let leaves = 0;
      const adapter = cliMembershipAdapter({
        raid: {
          id: 'raid-1', rank: '5', pokemonId: '150', hostName: 'Host', hostLevel: 50,
          country: 'se', weather: 0, maxUsers: 10, count: 1, readyCount: 0,
          joinState: null, deleted: false, isMe: item.raidIsMe, minimumGuestLevel: 0
        },
        players: {
          players: [{ id: 'p1', trainerName: 'Guest', level: 50, country: 'se', rating: 5, ready: false, isMe: item.playerIsMe }],
          count: 1, readyCount: 0, raidDeleted: false
        },
        onLeave: () => { leaves += 1; }
      });
      const worker = new AutoJoinWorker({ adapter, pollIntervalMs: 100, clock });
      await worker.restore({
        ...initialSnapshot(),
        intent: 'leave',
        raid: { state: 'unknown', target: 'raid-1', value: { rpl_id: 'raid-1', rpl_pokemon: 'Saved boss' } },
        wake: { kind: 'reconcileRaid', dueAt: new Date(clock.now()).toISOString() }
      });

      await clock.tick(0);
      await waitFor(worker, (status) => Boolean(status.lastError));
      assert.equal(leaves, 0);
      assert.equal(worker.status().raidMembership, 'unknown');
      assert.equal(worker.status().raid.rpl_pokemon, 'Saved boss');
      worker.shutdown();
    });
  }
});

test('player-only presence preserves saved raid details during matched reconciliation', async () => {
  const clock = new FakeClock();
  const worker = new AutoJoinWorker({
    adapter: {
      async findRaid() { return null; },
      async listRaidPlayers() { return { players: [{ isMe: true }], raidDeleted: false }; }
    },
    pollIntervalMs: 100,
    clock
  });
  await worker.restore({
    ...initialSnapshot(),
    intent: 'search',
    raid: { state: 'unknown', target: 'raid-1', value: { rpl_id: 'raid-1', rpl_pokemon: 'Saved boss', rpl_tid: 'Saved host' } },
    wake: { kind: 'reconcileRaid', dueAt: new Date(clock.now()).toISOString() }
  });

  await clock.tick(0);
  await waitFor(worker, (status) => status.state === 'matched');
  assert.equal(worker.status().raid.rpl_pokemon, 'Saved boss');
  assert.equal(worker.status().raid.rpl_tid, 'Saved host');
  worker.shutdown();
});

test('matched validation executes both reads and retries unknown membership until confirmed absent', async (t) => {
  const clock = new FakeClock();
  const responses = [
    { rpl_id: 'raid-1', join: null },
    {},
    { rpl_id: 'raid-1', join: 'invalid' },
    { rpl_id: 'raid-1', join: 0 }
  ];
  let exactCalls = 0;
  let playerCalls = 0;
  const worker = new AutoJoinWorker({
    adapter: {
      async findRaid() { exactCalls += 1; return responses.shift(); },
      async listRaidPlayers() { playerCalls += 1; return { players: [{ isMe: false }], raidDeleted: false }; }
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
  await waitFor(worker, () => exactCalls === 1 && playerCalls === 1);
  assert.equal(worker.status().state, 'matched');
  for (let expected = 2; expected <= 4; expected += 1) {
    await clock.tick(expected === 2 ? 25 : expected === 3 ? 50 : 100);
    await waitFor(worker, () => exactCalls === expected && playerCalls === expected);
    if (expected < 4) assert.equal(worker.status().state, 'matched');
  }
  assert.equal(worker.status().state, 'idle');
});

test('matched validation retains and retries on unknown evidence, then clears on ended evidence', async (t) => {
  const clock = new FakeClock();
  let exactCalls = 0;
  let playerCalls = 0;
  const worker = new AutoJoinWorker({
    adapter: {
      async findRaid() {
        exactCalls += 1;
        if (exactCalls === 1) throw new Error('exact lookup failed');
        return { rpl_id: 'raid-1' };
      },
      async listRaidPlayers() {
        playerCalls += 1;
        if (playerCalls === 1) return { players: [{ isMe: false }], raidDeleted: false };
        return { players: [], raidDeleted: true };
      }
    },
    matchedValidationIntervalMs: 25,
    clock
  });
  t.after(() => worker.shutdown());
  await worker.restore({
    ...initialSnapshot(),
    raid: { state: 'matched', target: 'raid-1', value: { rpl_id: 'raid-1', join: 1, rpl_pokemon: 'Saved boss' } },
    wake: { kind: 'revalidateMatched', dueAt: new Date(clock.now()).toISOString() },
    terminal: { target: 'matched', error: null }
  });

  await clock.tick(0);
  await waitFor(worker, (status) => exactCalls === 1 && playerCalls === 1 && Boolean(status.lastError));
  assert.equal(worker.status().state, 'matched');
  assert.equal(worker.status().raid.rpl_pokemon, 'Saved boss');
  assert.match(worker.status().lastError, /could not be confirmed/i);

  await clock.tick(25);
  await waitFor(worker, (status) => exactCalls === 2 && playerCalls === 2 && status.state === 'idle');
  assert.equal(worker.status().raid, null);
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
      async listRaidPlayers() { return { players: [] }; },
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
      async listRaidPlayers() { return { players: [], raidDeleted: true }; },
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

test('missing membership readers remain locked and expose typed unavailability', async () => {
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
  assert.match(status.error, /unavailable/i);
  assert.doesNotMatch(status.error, /is not a function|TypeError/);
  worker.shutdown();
});

test('stop during membership verification keeps durable reconciliation running', async () => {
  const clock = new FakeClock();
  let firstSignal;
  let firstPlayersSignal;
  let calls = 0;
  let playerCalls = 0;
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
      },
      async listRaidPlayers(_id, { signal }) {
        playerCalls += 1;
        if (playerCalls === 1) {
          firstPlayersSignal = signal;
          return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        }
        return { players: [], raidDeleted: false };
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
  await waitFor(worker, () => Boolean(firstSignal) && Boolean(firstPlayersSignal));
  await worker.stop();
  assert.equal(firstSignal.aborted, true);
  assert.equal(firstPlayersSignal.aborted, true);
  const durable = persisted.at(-1);
  assert.equal(durable.intent, 'stop');
  assert.equal(durable.raid.state, 'unknown');
  assert.equal(durable.wake.kind, 'reconcileRaid');
  await clock.tick(0);
  await waitFor(worker, (status) => status.state === 'stopped');
  assert.equal(calls, 2);
  assert.equal(playerCalls, 2);
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
