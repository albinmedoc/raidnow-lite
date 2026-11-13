import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialSnapshot,
  migrateSnapshot,
  reduceAutoJoin
} from '../src/core/autojoin-state-machine.js';

const profile = { trainerName: 'Albin123', level: 50 };
const selection = { ranks: ['5'], pokemon: ['Giratina'] };
const now = '2026-11-11T10:00:00.000Z';

function reduce(snapshot, event) {
  return reduceAutoJoin(snapshot, event, { now, pollIntervalMs: 15_000, scanIntervalMs: 1_000 });
}

test('start creates one durable queue operation', () => {
  const { snapshot, effects } = reduce(initialSnapshot(), { type: 'start', profile, selection });
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.intent, 'search');
  assert.equal(snapshot.queue.state, 'creating');
  assert.equal(snapshot.operation.kind, 'createQueue');
  assert.equal(snapshot.operation.attempt, 1);
  assert.equal(effects.length, 1);
  assert.deepEqual(effects[0], { type: 'adapter', opId: snapshot.operation.opId });
});

test('definite create reject unlocks resources while timeout keeps queue unknown', () => {
  const started = reduce(initialSnapshot(), { type: 'start', profile, selection }).snapshot;
  const rejected = reduce(started, { type: 'operationRejected', opId: started.operation.opId, error: 'rejected', definite: true }).snapshot;
  assert.equal(rejected.queue.state, 'none');
  assert.equal(rejected.operation, null);
  assert.equal(rejected.terminal.target, 'error');

  const uncertain = reduce(started, { type: 'operationRejected', opId: started.operation.opId, error: 'timeout', definite: false }).snapshot;
  assert.equal(uncertain.queue.state, 'unknown');
  assert.equal(uncertain.operation, null);
  assert.equal(uncertain.wake.kind, 'reconcileQueue');
});

test('wrong and late operation ids cannot mutate the snapshot', () => {
  const started = reduce(initialSnapshot(), { type: 'start', profile, selection }).snapshot;
  const wrong = reduce(started, { type: 'operationSucceeded', opId: 'wrong', value: { status: 'success' } });
  assert.deepEqual(wrong.snapshot, started);
  assert.deepEqual(wrong.effects, []);

  const completed = reduce(started, { type: 'operationSucceeded', opId: started.operation.opId, value: { status: 'success' } }).snapshot;
  const late = reduce(completed, { type: 'operationRejected', opId: started.operation.opId, error: 'late', definite: false });
  assert.deepEqual(late.snapshot, completed);
});

test('late join success after stop becomes matched', () => {
  let snapshot = reduce(initialSnapshot(), { type: 'start', profile, selection: { ...selection, strategy: 'fast' } }).snapshot;
  snapshot = reduce(snapshot, { type: 'wake', kind: 'scan' }).snapshot;
  snapshot = reduce(snapshot, { type: 'operationSucceeded', opId: snapshot.operation.opId, value: [{ rpl_id: 'raid-1', rpl_rank: '5', rpl_pokemon: 'Giratina' }] }).snapshot;
  assert.equal(snapshot.operation.kind, 'joinRaid');
  snapshot = reduce(snapshot, { type: 'stop' }).snapshot;
  assert.equal(snapshot.raid.state, 'unknown');
  const joined = reduce(snapshot, { type: 'operationSucceeded', opId: snapshot.operation.opId, value: { status: 'success', data: { rpl_id: 'raid-1' } } }).snapshot;
  assert.equal(joined.raid.state, 'matched');
  assert.equal(joined.raid.value.rpl_id, 'raid-1');
});

test('cancel success requires a subsequent absence check before queue unlocks', () => {
  let snapshot = initialSnapshot();
  snapshot = {
    ...snapshot,
    intent: 'stop',
    search: { profile, selection, nextQueuePollAt: null, attemptedRaids: {} },
    queue: { state: 'canceling' },
    operation: { opId: 'cancel-1', kind: 'cancelQueue', input: {}, startedAt: now, attempt: 1 }
  };
  snapshot = reduce(snapshot, { type: 'operationSucceeded', opId: 'cancel-1', value: { status: 'success' } }).snapshot;
  assert.equal(snapshot.queue.state, 'unknown');
  assert.equal(snapshot.operation.kind, 'checkQueue');
  snapshot = reduce(snapshot, { type: 'operationSucceeded', opId: snapshot.operation.opId, value: {} }).snapshot;
  assert.equal(snapshot.queue.state, 'none');
  assert.equal(snapshot.operation, null);
});

test('restore converts each in-flight write to conservative uncertainty', () => {
  for (const [kind, expected] of [
    ['createQueue', ['unknown', 'none']],
    ['cancelQueue', ['unknown', 'none']],
    ['joinRaid', ['none', 'unknown']],
    ['leaveRaid', ['none', 'unknown']]
  ]) {
    const saved = {
      ...initialSnapshot(),
      search: { profile, selection, nextQueuePollAt: null, attemptedRaids: {} },
      queue: { state: kind === 'createQueue' ? 'creating' : kind === 'cancelQueue' ? 'canceling' : 'none' },
      raid: { state: kind === 'joinRaid' ? 'joining' : kind === 'leaveRaid' ? 'leaving' : 'none', target: 'raid-1', value: kind === 'leaveRaid' ? { rpl_id: 'raid-1' } : null },
      operation: { opId: `${kind}-1`, kind, input: { raid: { rpl_id: 'raid-1' }, raidId: 'raid-1' }, startedAt: now, attempt: 1 }
    };
    const restored = migrateSnapshot(saved, { now, pollIntervalMs: 15_000 });
    assert.equal(restored.queue.state, expected[0], kind);
    assert.equal(restored.raid.state, expected[1], kind);
    assert.equal(restored.operation, null, kind);
    assert.ok(restored.wake, kind);
  }
});

test('restore resumes an in-flight queue check as queue reconciliation', () => {
  const saved = {
    ...initialSnapshot(),
    intent: 'stop',
    search: { profile, selection, nextQueuePollAt: null, attemptedRaids: {} },
    queue: { state: 'unknown' },
    operation: { opId: 'check-1', kind: 'checkQueue', input: { profile, selection }, startedAt: now, attempt: 1 }
  };
  const restored = migrateSnapshot(saved, { now, pollIntervalMs: 15_000 });
  assert.equal(restored.queue.state, 'unknown');
  assert.equal(restored.wake.kind, 'reconcileQueue');
});

test('restore resumes in-flight membership verification as raid reconciliation', () => {
  const saved = {
    ...initialSnapshot(),
    intent: 'search',
    search: { profile, selection: { ...selection, strategy: 'fast' }, nextQueuePollAt: null, attemptedRaids: {} },
    raid: { state: 'unknown', target: 'raid-1', value: { rpl_id: 'raid-1' } },
    operation: { opId: 'verify-1', kind: 'verifyMembership', input: { raidId: 'raid-1' }, startedAt: now, attempt: 1 }
  };
  const restored = migrateSnapshot(saved, { now, pollIntervalMs: 15_000 });
  assert.equal(restored.raid.state, 'unknown');
  assert.equal(restored.wake.kind, 'reconcileRaid');
});

test('restore canonicalizes durable filters before resumed upstream work', () => {
  const saved = {
    ...initialSnapshot(),
    intent: 'search',
    search: {
      profile,
      selection: {
        strategy: 'fast', ranks: ['5'], pokemon: ['Giratina'], hostRating: false, hostCountry: [1],
        weatherBoost: true, hostLevel: ['70'], hostEvaluate: Array.from({ length: 10_000 }, (_, index) => index)
      },
      nextQueuePollAt: null,
      attemptedRaids: {}
    },
    queue: { state: 'present' },
    wake: { kind: 'scan', dueAt: now }
  };
  const restored = migrateSnapshot(saved, { now, pollIntervalMs: 15_000 });
  assert.deepEqual(restored.search.selection, {
    strategy: 'hybrid', ranks: ['5'], pokemon: ['Giratina'], hostRating: 3, hostCountry: 0,
    weatherBoost: 0, hostLevel: 0, hostEvaluate: [-1, 0, 1, 2], guest6: 0
  });
});

test('schema v1 migration preserves matched raid and pending queue cancellation', () => {
  const migrated = migrateSnapshot({
    state: 'matched',
    startedAt: now,
    profile,
    selection,
    raid: { rpl_id: 'raid-42' },
    queueCancelPending: true,
    retryCount: 3,
    lastError: 'cancel failed'
  }, { now, pollIntervalMs: 15_000 });
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.raid.state, 'matched');
  assert.equal(migrated.raid.value.rpl_id, 'raid-42');
  assert.equal(migrated.queue.state, 'unknown');
  assert.equal(migrated.wake.kind, 'reconcileQueue');
  assert.equal(migrated.terminal.error, 'cancel failed');
});

test('schema v1 active states migrate conservatively', () => {
  for (const state of ['searching', 'retrying', 'stopping', 'reconciling']) {
    const migrated = migrateSnapshot({ state, profile, selection }, { now, pollIntervalMs: 15_000 });
    assert.equal(migrated.queue.state, 'unknown', state);
    assert.equal(migrated.wake.kind, 'reconcileQueue', state);
  }
});

test('schema v1 restore defaults malformed filter scalar types', () => {
  const migrated = migrateSnapshot({
    state: 'searching',
    profile,
    selection: {
      ranks: ['5'], pokemon: ['Giratina'], hostRating: {}, hostCountry: [1],
      weatherBoost: false, hostLevel: ['70'], hostEvaluate: Array.from({ length: 10_000 }, (_, index) => index)
    }
  }, { now, pollIntervalMs: 15_000 });
  assert.deepEqual(migrated.search.selection, {
    strategy: 'hybrid', ranks: ['5'], pokemon: ['Giratina'], hostRating: 3, hostCountry: 0,
    weatherBoost: 0, hostLevel: 0, hostEvaluate: [-1, 0, 1, 2], guest6: 0
  });
});

test('raid reconciliation verifies membership and adopts a joined raid', () => {
  const uncertain = {
    ...initialSnapshot(), intent: 'search',
    search: { profile, selection: { ...selection, strategy: 'fast' }, nextQueuePollAt: null, attemptedRaids: {} },
    raid: { state: 'unknown', target: 'raid-1', value: { rpl_id: 'raid-1', rpl_pokemon: 'Giratina' } },
    wake: { kind: 'reconcileRaid', dueAt: now }
  };
  const verifying = reduce(uncertain, { type: 'wake', kind: 'reconcileRaid' });
  assert.equal(verifying.snapshot.operation.kind, 'verifyMembership');
  assert.equal(verifying.snapshot.operation.input.raidId, 'raid-1');
  const matched = reduce(verifying.snapshot, {
    type: 'operationSucceeded', opId: verifying.snapshot.operation.opId,
    value: { rpl_id: 'raid-1', rpl_pokemon: 'Giratina', join: 1 }
  }).snapshot;
  assert.equal(matched.raid.state, 'matched');
  assert.equal(matched.raid.value.rpl_id, 'raid-1');
});

test('raid reconciliation clears confirmed absence and resumes direct scans', () => {
  const uncertain = {
    ...initialSnapshot(), intent: 'search',
    search: { profile, selection: { ...selection, strategy: 'fast' }, nextQueuePollAt: null, attemptedRaids: {} },
    raid: { state: 'unknown', target: 'raid-1', value: { rpl_id: 'raid-1' } },
    operation: { opId: 'find-1', kind: 'verifyMembership', input: { raidId: 'raid-1' }, startedAt: now, attempt: 1 }
  };
  const cleared = reduce(uncertain, { type: 'operationSucceeded', opId: 'find-1', value: null }).snapshot;
  assert.equal(cleared.raid.state, 'none');
  assert.equal(cleared.wake.kind, 'scan');
});

test('leave reconciliation keeps the raid visible until absence is confirmed', () => {
  const uncertain = {
    ...initialSnapshot(), intent: 'leave',
    raid: { state: 'unknown', target: 'raid-1', value: { rpl_id: 'raid-1', rpl_pokemon: 'Giratina' } },
    operation: { opId: 'find-1', kind: 'verifyMembership', input: { raidId: 'raid-1' }, startedAt: now, attempt: 1 }
  };
  const stillJoined = reduce(uncertain, { type: 'operationSucceeded', opId: 'find-1', value: { rpl_id: 'raid-1', join: 1 } }).snapshot;
  assert.equal(stillJoined.raid.value.rpl_id, 'raid-1');
  assert.equal(stillJoined.operation.kind, 'leaveRaid');
  const absentCheck = { ...uncertain, operation: { ...uncertain.operation, opId: 'find-2' } };
  const absent = reduce(absentCheck, { type: 'operationSucceeded', opId: 'find-2', value: null }).snapshot;
  assert.equal(absent.raid.state, 'none');
  assert.equal(absent.intent, 'idle');
});

test('raid reconciliation failure stays locked and retries', () => {
  const uncertain = {
    ...initialSnapshot(), intent: 'search',
    raid: { state: 'unknown', target: 'raid-1', value: { rpl_id: 'raid-1' } },
    operation: { opId: 'find-1', kind: 'verifyMembership', input: { raidId: 'raid-1' }, startedAt: now, attempt: 1 }
  };
  const failed = reduce(uncertain, { type: 'operationRejected', opId: 'find-1', error: 'lookup unavailable', definite: true }).snapshot;
  assert.equal(failed.raid.state, 'unknown');
  assert.equal(failed.raid.value.rpl_id, 'raid-1');
  assert.equal(failed.wake.kind, 'reconcileRaid');
  assert.equal(failed.lastError, 'lookup unavailable');
});

test('local abandonment clears only repeated stop uncertainty without a raid', () => {
  const safe = {
    ...initialSnapshot(), intent: 'stop', retryCount: 3, opSequence: 12,
    search: { profile, selection, nextQueuePollAt: null, attemptedRaids: {} },
    queue: { state: 'unknown' },
    raid: { state: 'none', target: null, value: null },
    wake: { kind: 'reconcileQueue', dueAt: now },
    lastError: 'Raid NOW rejected the request.'
  };
  const abandoned = reduce(safe, { type: 'abandonLocal' });
  assert.equal(abandoned.snapshot.intent, 'idle');
  assert.equal(abandoned.snapshot.queue.state, 'none');
  assert.equal(abandoned.snapshot.search, null);
  assert.equal(abandoned.snapshot.opSequence, 12);

  const unsafe = { ...safe, raid: { state: 'unknown', target: 'raid-1', value: null } };
  const rejected = reduce(unsafe, { type: 'abandonLocal' });
  assert.deepEqual(rejected.snapshot, unsafe);
  assert.match(rejected.effects[0].error, /cannot be forgotten locally/i);
});

test('stop preserves raid reconciliation when membership is unknown', () => {
  const uncertain = {
    ...initialSnapshot(),
    intent: 'search',
    search: { profile, selection: { ...selection, strategy: 'fast' }, nextQueuePollAt: null, attemptedRaids: {} },
    raid: { state: 'unknown', target: 'raid-1', value: { rpl_id: 'raid-1' } },
    wake: { kind: 'reconcileRaid', dueAt: '2026-11-11T10:00:15.000Z' }
  };
  const stopped = reduce(uncertain, { type: 'stop' });
  assert.equal(stopped.snapshot.intent, 'stop');
  assert.equal(stopped.snapshot.raid.state, 'unknown');
  assert.equal(stopped.snapshot.operation, null);
  assert.equal(stopped.snapshot.wake.kind, 'reconcileRaid');
  assert.ok(stopped.effects.some((effect) => effect.type === 'timer' && effect.kind === 'reconcileRaid'));
});

test('stop aborts active membership verification and durably reschedules it', () => {
  const verifying = {
    ...initialSnapshot(),
    intent: 'search',
    search: { profile, selection: { ...selection, strategy: 'fast' }, nextQueuePollAt: null, attemptedRaids: {} },
    raid: { state: 'unknown', target: 'raid-1', value: { rpl_id: 'raid-1' } },
    operation: { opId: 'verify-1', kind: 'verifyMembership', input: { raidId: 'raid-1' }, startedAt: now, attempt: 1 }
  };
  const stopped = reduce(verifying, { type: 'stop' });
  assert.equal(stopped.snapshot.intent, 'stop');
  assert.equal(stopped.snapshot.operation, null);
  assert.equal(stopped.snapshot.wake.kind, 'reconcileRaid');
  assert.deepEqual(stopped.effects.map((effect) => effect.type), ['abort', 'timer']);
  assert.equal(stopped.effects[0].opId, 'verify-1');
});

test('queue reconciliation cannot strand a stopped actor with an unknown raid', () => {
  const checking = {
    ...initialSnapshot(),
    intent: 'stop',
    search: { profile, selection, nextQueuePollAt: null, attemptedRaids: {} },
    queue: { state: 'unknown' },
    raid: { state: 'unknown', target: 'raid-1', value: { rpl_id: 'raid-1' } },
    operation: { opId: 'check-1', kind: 'checkQueue', input: { profile, selection }, startedAt: now, attempt: 1 },
    terminal: { target: 'stopped', error: null }
  };
  const reconciled = reduce(checking, { type: 'operationSucceeded', opId: 'check-1', value: {} }).snapshot;
  assert.equal(reconciled.intent, 'stop');
  assert.equal(reconciled.queue.state, 'none');
  assert.equal(reconciled.raid.state, 'unknown');
  assert.equal(reconciled.wake.kind, 'reconcileRaid');
});

test('anonymous session expiry disables direct scans and continues queue polling', () => {
  const scanning = {
    ...initialSnapshot(), intent: 'search',
    search: { profile, selection: { ...selection, strategy: 'hybrid' }, nextQueuePollAt: now, attemptedRaids: {} },
    queue: { state: 'present' },
    operation: { opId: 'scan-auth', kind: 'scanLobbies', input: {}, startedAt: now, attempt: 1 }
  };
  let next = reduce(scanning, {
    type: 'operationRejected', opId: 'scan-auth', error: 'The session has expired. Please restart.', status: 401, definite: true
  }).snapshot;
  assert.equal(next.search.directScanDisabled, true);
  assert.equal(next.wake.kind, 'pollQueue');
  assert.equal(next.retryCount, 0);
  assert.equal(next.lastError, null);

  next = reduce(next, { type: 'wake', kind: 'pollQueue' }).snapshot;
  assert.equal(next.operation.kind, 'pollQueue');
  next = reduce(next, {
    type: 'operationSucceeded', opId: next.operation.opId, value: { status: 'success', rpllm_status: 1 }
  }).snapshot;
  assert.equal(next.wake.kind, 'pollQueue');
});

test('restored direct-scan fallback never resumes lobby scanning', () => {
  const saved = {
    ...initialSnapshot(), intent: 'search',
    search: { profile, selection: { ...selection, strategy: 'hybrid' }, nextQueuePollAt: now, attemptedRaids: {}, directScanDisabled: true },
    queue: { state: 'present' },
    wake: { kind: 'scan', dueAt: now }
  };
  let restored = migrateSnapshot(saved, { now, pollIntervalMs: 15_000, scanIntervalMs: 1_000 });
  assert.equal(restored.search.directScanDisabled, true);
  let resumed = reduce(restored, { type: 'wake', kind: 'scan' }).snapshot;
  assert.equal(resumed.operation.kind, 'pollQueue');

  restored = migrateSnapshot({
    ...saved,
    wake: null,
    operation: { opId: 'scan-before-restart', kind: 'scanLobbies', input: { selection }, startedAt: now, attempt: 2 }
  }, { now, pollIntervalMs: 15_000, scanIntervalMs: 1_000 });
  assert.equal(restored.search.directScanDisabled, true);
  assert.equal(restored.wake.kind, 'scan');
  resumed = reduce(restored, { type: 'wake', kind: 'scan' }).snapshot;
  assert.equal(resumed.operation.kind, 'pollQueue');
});

test('hybrid read failures keep direct scan cadence and queue due time', () => {
  const queueDue = '2026-11-11T10:00:15.000Z';
  const scanning = {
    ...initialSnapshot(), intent: 'search',
    search: { profile, selection: { ...selection, strategy: 'hybrid' }, nextQueuePollAt: queueDue, attemptedRaids: {} },
    queue: { state: 'present' },
    operation: { opId: 'scan-1', kind: 'scanLobbies', input: {}, startedAt: now, attempt: 1 }
  };
  const scanFailed = reduce(scanning, { type: 'operationRejected', opId: 'scan-1', error: 'scan failed', definite: true }).snapshot;
  assert.equal(scanFailed.wake.kind, 'scan');
  assert.equal(scanFailed.wake.dueAt, '2026-11-11T10:00:01.000Z');
  assert.equal(scanFailed.search.nextQueuePollAt, queueDue);
  const polling = { ...scanning, operation: { ...scanning.operation, opId: 'poll-1', kind: 'pollQueue' } };
  const pollFailed = reduce(polling, { type: 'operationRejected', opId: 'poll-1', error: 'poll failed', definite: true }).snapshot;
  assert.equal(pollFailed.wake.kind, 'scan');
  assert.equal(pollFailed.wake.dueAt, '2026-11-11T10:00:01.000Z');
});

test('attempted direct raid candidates expire after ten seconds', () => {
  const candidate = { rpl_id: 'raid-1', rpl_rank: '5', rpl_pokemon: 'Giratina' };
  const scanning = {
    ...initialSnapshot(), intent: 'search',
    search: { profile, selection: { ...selection, strategy: 'fast' }, nextQueuePollAt: null, attemptedRaids: { 'raid-1': '2026-11-11T09:59:49.999Z' } },
    operation: { opId: 'scan-1', kind: 'scanLobbies', input: {}, startedAt: now, attempt: 1 }
  };
  const retried = reduce(scanning, { type: 'operationSucceeded', opId: 'scan-1', value: [candidate] }).snapshot;
  assert.equal(retried.operation.kind, 'joinRaid');
  assert.equal(retried.operation.input.raidId, 'raid-1');
});

test('direct scanning respects the different-country filter', () => {
  const scanning = {
    ...initialSnapshot(), intent: 'search',
    search: {
      profile: { ...profile, countryCode: 'se' },
      selection: { ...selection, strategy: 'fast', hostCountry: 1 },
      nextQueuePollAt: null,
      attemptedRaids: {}
    },
    operation: { opId: 'scan-country', kind: 'scanLobbies', input: {}, startedAt: now, attempt: 1 }
  };
  const result = reduce(scanning, {
    type: 'operationSucceeded',
    opId: 'scan-country',
    value: [
      { rpl_id: 'same', rpl_rank: '5', rpl_pokemon: 'Giratina', rpl_country_code: 'se' },
      { rpl_id: 'different', rpl_rank: '5', rpl_pokemon: 'Giratina', rpl_country_code: 'us' }
    ]
  }).snapshot;
  assert.equal(result.operation.kind, 'joinRaid');
  assert.equal(result.operation.input.raidId, 'different');
});

test('definite join rejection removes the candidate attempt immediately', () => {
  const joining = {
    ...initialSnapshot(), intent: 'search',
    search: { profile, selection: { ...selection, strategy: 'fast' }, nextQueuePollAt: null, attemptedRaids: { 'raid-1': now } },
    raid: { state: 'joining', target: 'raid-1', value: { rpl_id: 'raid-1' } },
    operation: { opId: 'join-1', kind: 'joinRaid', input: { raidId: 'raid-1' }, startedAt: now, attempt: 1 }
  };
  const rejected = reduce(joining, { type: 'operationRejected', opId: 'join-1', error: 'full', definite: true }).snapshot;
  assert.equal(rejected.search.attemptedRaids['raid-1'], undefined);
});
