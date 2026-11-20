import test from 'node:test';
import assert from 'node:assert/strict';
import { CliCommandError } from '../src/adapters/cli-process-runner.js';
import { CliRaidNowAdapter } from '../src/adapters/cli-raidnow-adapter.js';

const tokenFile = '/run/raidnow/session.token';
const profile = {
  trainerName: 'Albin123',
  trainerCode: '123456789012',
  level: 50,
  countryCode: 'se'
};
const selection = {
  ranks: ['5', 'mega'],
  pokemon: ['150', '6_x'],
  guestScore: 4,
  hostRating: 3,
  hostCountry: 1,
  weatherBoost: 2,
  hostLevel: 70
};

function success(command, data, status = 'success') {
  return { schemaVersion: 1, ok: true, command, status, data, warnings: [] };
}

class FakeRunner {
  constructor(responses = []) {
    this.responses = [...responses];
    this.calls = [];
  }

  async run(call) {
    this.calls.push(call);
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return response;
  }
}

function createAdapter(responses = []) {
  const runner = new FakeRunner(responses);
  return { runner, adapter: new CliRaidNowAdapter({ runner, tokenFile, allowWrites: true }) };
}

function assertCall(call, tail, { stdin = null, signal } = {}) {
  assert.deepEqual(call.args, ['--json', '--token-file', tokenFile, ...tail]);
  assert.equal(call.stdin ?? null, stdin);
  assert.equal(call.signal, signal);
}

test('validates the token file and reports an available token', () => {
  const runner = new FakeRunner();
  for (const invalid of [undefined, null, '', '   ', 7]) {
    assert.throws(
      () => new CliRaidNowAdapter({ runner, tokenFile: invalid }),
      (error) => error.code === 'CLI_INVALID_INPUT' && error.message === 'Invalid CLI adapter input.'
    );
  }
  assert.equal(new CliRaidNowAdapter({ runner, tokenFile }).hasToken(), true);
});

test('blocks every write locally by default without invoking the runner', async () => {
  const runner = new FakeRunner();
  const adapter = new CliRaidNowAdapter({ runner, tokenFile });
  const writes = [
    () => adapter.updateProfile(profile),
    () => adapter.createMatching({ profile, selection }),
    () => adapter.joinRaidFast('raid-1', profile),
    () => adapter.cancelMatching(),
    () => adapter.leaveRaid('raid-1')
  ];
  for (const invoke of writes) {
    await assert.rejects(
      invoke,
      (error) => error.code === 'WRITES_DISABLED'
        && error.message === 'Live writes are disabled.'
        && !error.message.includes(profile.trainerCode)
    );
  }
  assert.equal(runner.calls.length, 0);
});

test('publishes a profile with the trainer code only on stdin', async () => {
  const controller = new AbortController();
  const { adapter, runner } = createAdapter([success('trainer publish', { published: true }, 'published')]);

  assert.deepEqual(await adapter.updateProfile(profile, { signal: controller.signal }), { status: 'success' });
  assertCall(runner.calls[0], [
    'trainer', 'publish',
    '--trainer-name', 'Albin123',
    '--trainer-level', '50',
    '--trainer-country', 'se',
    '--trainer-code-file', '-'
  ], { stdin: profile.trainerCode, signal: controller.signal });
  assert.equal(runner.calls[0].args.includes(profile.trainerCode), false);
});

test('translates the current boss catalog and forwards cancellation', async () => {
  const controller = new AbortController();
  const { adapter, runner } = createAdapter([success('bosses list', [{
    rank: '5', pokemonId: '150', pokemonName: 'Armored Mewtwo', imageUrl: 'image.png', waitingCount: 4
  }], 'listed')]);

  assert.deepEqual(await adapter.listCurrentRaidBosses({ signal: controller.signal }), [{
    rank: '5', pokemon: '150', displayName: 'Armored Mewtwo', image: 'image.png', waitingCount: 4
  }]);
  assertCall(runner.calls[0], ['bosses', 'list'], { signal: controller.signal });
});

test('maps every worker operation to the primitive CLI command', async () => {
  const signal = new AbortController().signal;
  const raid = {
    id: 'raid-9', rank: '5', pokemonId: '150', hostName: 'Host7', hostLevel: 48,
    country: 'jp', weather: 1, maxUsers: 10, count: 3, readyCount: 2,
    joinState: 1, deleted: false, isMe: true, minimumGuestLevel: 40,
    hostTrainerCode: '999988887777'
  };
  const players = {
    players: [{ id: 'p1', trainerName: 'Misty7', level: 44, country: 'jp', rating: 5, ready: true, isMe: false }],
    count: 1,
    readyCount: 1,
    raidDeleted: false
  };
  const { adapter, runner } = createAdapter([
    success('lobbies list', [{ ...raid, hostTrainerCode: 'must-not-leak' }], 'listed'),
    success('raid join', { joined: true, raidId: 'raid-9' }, 'joined'),
    success('queue join', { created: true }, 'created'),
    success('queue status', { state: 'waiting' }, 'waiting'),
    success('queue check', { present: true, id: 'queue-1', priority: 2, waiting: [{ id: 'w1' }] }, 'present'),
    success('queue cancel', { requested: true, verified: false }, 'requested'),
    success('raid get', raid, 'found'),
    success('raid players', players, 'listed'),
    success('raid leave', { requested: true, verified: false, raidId: 'raid-9' }, 'requested')
  ]);

  const listed = await adapter.listRaids({ page: 2, filter: ['25', '6_x'], rank: '5', hostLevel: 50, hostEvaluate: [-1, 0, 1, 2] }, { signal });
  assert.equal(listed[0].rpl_id, 'raid-9');
  assert.equal(Object.hasOwn(listed[0], 'rpl_code'), false);
  assert.deepEqual(await adapter.joinRaidFast('raid-9', profile, { signal }), { status: 'success' });
  assert.deepEqual(await adapter.createMatching({ profile, selection }, { signal }), { status: 'success' });
  assert.deepEqual(await adapter.pollMatching({ selection }, { signal }), { status: 'success', rpllm_status: 1 });
  assert.deepEqual(await adapter.checkMatching({ selection }, { signal }), {
    status: 'success', id: 'queue-1', priority: 2, list: [{ id: 'w1' }]
  });
  assert.deepEqual(await adapter.cancelMatching({ signal }), { status: 'success' });
  const found = await adapter.findRaid('raid-9', { signal });
  assert.equal(found.rpl_code, '999988887777');
  assert.deepEqual(await adapter.listRaidPlayers('raid-9', { signal }), {
    players: [{ id: 'p1', trainerName: 'Misty7', level: 44, countryCode: 'jp', rating: 5, ready: 1, isMe: false }],
    count: 1,
    readyCount: 1,
    raidDeleted: false
  });
  assert.deepEqual(await adapter.leaveRaid('raid-9', { signal }), { status: 'success' });

  const expected = [
    ['lobbies', 'list', '--page', '2', '--rank', '5', '--host-level', '50', '--min-host-rating', '3', '--include-metadata=false', '--exclude-pokemon', '25', '--exclude-pokemon', '6_x'],
    ['raid', 'join', '--raid-id', 'raid-9', '--trainer-name', 'Albin123', '--trainer-level', '50', '--trainer-country', 'se'],
    ['queue', 'join', '--rank', '5', '--rank', 'mega', '--pokemon', '150', '--pokemon', '6_x', '--trainer-name', 'Albin123', '--trainer-level', '50', '--trainer-country', 'se', '--trainer-code-file', '-', '--guest-score', '4', '--min-host-rating', '3', '--host-country', '1', '--weather-boost', '2', '--host-level', '70'],
    ['queue', 'status', '--rank', '5', '--rank', 'mega', '--pokemon', '150', '--pokemon', '6_x'],
    ['queue', 'check', '--pokemon', '150', '--pokemon', '6_x'],
    ['queue', 'cancel', '--verify=false'],
    ['raid', 'get', '--raid-id', 'raid-9'],
    ['raid', 'players', '--raid-id', 'raid-9'],
    ['raid', 'leave', '--raid-id', 'raid-9', '--verify=false']
  ];
  expected.forEach((tail, index) => assertCall(runner.calls[index], tail, {
    stdin: index === 2 ? profile.trainerCode : null,
    signal
  }));
  assert.equal(runner.calls.flatMap((call) => call.args).includes(profile.trainerCode), false);
});

test('translates normalized raids into the complete legacy worker shape', async () => {
  const source = {
    id: 'raid-1', rank: 'mega', pokemonId: '6_x', hostName: 'Host', hostLevel: 47,
    country: 'se', weather: 2, maxUsers: 8, count: 5, readyCount: 3,
    joinState: 0, deleted: true, isMe: false, minimumGuestLevel: 41
  };
  const { adapter } = createAdapter([success('lobbies list', [source], 'listed')]);
  assert.deepEqual(await adapter.listRaids(), [{
    rpl_id: 'raid-1', rpl_rank: 'mega', rpl_pokemon: '6_x', rpl_tid: 'Host', rpl_level: 47,
    rpl_country_code: 'se', rpl_weather: 2, maxusers: 8, count: 5, readycount: 3,
    join: 0, rpl_deleted: 1, my: 0, rpl_glevel: 41
  }]);
});

test('refreshes and caches the boss catalog for lobby exclusion filters', async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const catalog = [
      { rank: '5', pokemonId: '150', pokemonName: 'Mewtwo', imageUrl: '', waitingCount: 1 },
      { rank: '5', pokemonId: '25', pokemonName: 'Pikachu', imageUrl: '', waitingCount: 2 },
      { rank: 'mega', pokemonId: '6_x', pokemonName: 'Charizard', imageUrl: '', waitingCount: 3 }
    ];
    const { adapter, runner } = createAdapter([
      success('bosses list', catalog, 'listed'),
      success('lobbies list', [], 'listed'),
      success('lobbies list', [], 'listed'),
      success('bosses list', catalog, 'listed'),
      success('lobbies list', [], 'listed')
    ]);
    const selected = { ranks: ['5'], pokemon: ['150'], hostLevel: 50, hostRating: 4 };

    await adapter.listRaidsForSelection(selected);
    now += 60_000;
    await adapter.listRaidsForSelection(selected);
    now += 1;
    await adapter.listRaidsForSelection(selected);

    assert.equal(runner.calls.filter((call) => call.args.includes('bosses')).length, 2);
    for (const call of runner.calls.filter((entry) => entry.args.includes('lobbies'))) {
      assertCall(call, ['lobbies', 'list', '--page', '1', '--rank', '5', '--host-level', '50', '--min-host-rating', '4', '--include-metadata=false', '--exclude-pokemon', '25', '--exclude-pokemon', '6_x']);
    }
  } finally {
    Date.now = originalNow;
  }
});

test('uses rank zero when a selection has anything other than one rank', async () => {
  const { adapter, runner } = createAdapter([
    success('bosses list', [], 'listed'),
    success('lobbies list', [], 'listed')
  ]);
  await adapter.listRaidsForSelection({ ranks: ['5', 'mega'], pokemon: [], hostLevel: 0, hostRating: -1 });
  assert.ok(runner.calls[1].args.includes('0'));
  assertCall(runner.calls[1], ['lobbies', 'list', '--page', '1', '--rank', '0', '--host-level', '0', '--min-host-rating', '-1', '--include-metadata=false']);
});

test('converts only canonical HostEvaluate compatibility arrays', async () => {
  const canonical = [
    { input: [], minimum: -1 },
    { input: [-1], minimum: 0 },
    { input: [-1, 0, 1], minimum: 2 },
    { input: [-1, 0, 1, 2, 3, 4], minimum: 5 }
  ];
  const { adapter, runner } = createAdapter(canonical.map(() => success('lobbies list', [], 'listed')));
  for (const item of canonical) await adapter.listRaids({ hostEvaluate: item.input });
  canonical.forEach((item, index) => {
    const flag = runner.calls[index].args.indexOf('--min-host-rating');
    assert.equal(runner.calls[index].args[flag + 1], String(item.minimum));
  });

  for (const malformed of [null, [-1, 1], [0], [-1, 0, 1, 2, 3, 4, 5], [-1, '0']]) {
    await assert.rejects(
      () => adapter.listRaids({ hostEvaluate: malformed }),
      (error) => error.code === 'CLI_INVALID_INPUT' && error.message === 'Invalid CLI adapter input.'
    );
  }
  assert.equal(runner.calls.length, canonical.length);
});

test('maps matched and absent queue states to the legacy contract', async () => {
  const { adapter } = createAdapter([
    success('queue status', { state: 'matched', raidId: 'raid-7' }, 'matched'),
    success('queue check', { present: false, waiting: [] }, 'absent')
  ]);
  assert.deepEqual(await adapter.pollMatching({ selection }), {
    status: 'success', rpllm_status: 2, rpllm_rpl_id: 'raid-7'
  });
  assert.deepEqual(await adapter.checkMatching({ selection }), {
    status: 'success', id: '', priority: undefined, list: []
  });
});

test('maps NOT_FOUND to null and authentication failures to HTTP 401 without wrapping', async () => {
  const notFound = new CliCommandError({ code: 'NOT_FOUND', exitCode: 6, command: 'raid get', status: 'not_found', message: 'Not found.' });
  const auth = new CliCommandError({ code: 'AUTHENTICATION_UNSUPPORTED', exitCode: 4, command: 'lobbies list', status: 'authentication_unsupported', message: 'Session expired.' });
  const unknownWrite = new CliCommandError({ code: 'WRITE_OUTCOME_UNKNOWN', exitCode: 9, command: 'queue cancel', status: 'uncertain', message: 'Unknown outcome.' });
  const { adapter } = createAdapter([notFound, auth, unknownWrite]);

  assert.equal(await adapter.findRaid('missing'), null);
  await assert.rejects(() => adapter.listRaids(), (error) => error === auth && error.status === 401);
  await assert.rejects(() => adapter.cancelMatching(), (error) => error === unknownWrite && error.writeOutcomeUnknown === true);
});

test('rejects malformed array entries without exposing their contents', async () => {
  const secret = profile.trainerCode;
  const cases = [
    { invoke: (adapter) => adapter.listCurrentRaidBosses(), data: [secret] },
    { invoke: (adapter) => adapter.listRaids(), data: [secret] },
    { invoke: (adapter) => adapter.listRaidPlayers('raid-1'), data: {
      players: [secret], count: 1, readyCount: 0, raidDeleted: false
    } }
  ];
  for (const item of cases) {
    const { adapter } = createAdapter([success('test command', item.data)]);
    await assert.rejects(
      () => item.invoke(adapter),
      (error) => error.code === 'CLI_PROTOCOL_ERROR' && !error.message.includes(secret)
    );
  }
});

test('rejects malformed CLI data with one sanitized protocol error', async () => {
  const secret = profile.trainerCode;
  const cases = [
    { invoke: (adapter) => adapter.listCurrentRaidBosses(), data: { secret } },
    { invoke: (adapter) => adapter.listRaids(), data: { secret } },
    { invoke: (adapter) => adapter.pollMatching({ selection }), data: [secret] },
    { invoke: (adapter) => adapter.checkMatching({ selection }), data: [secret] },
    { invoke: (adapter) => adapter.findRaid('raid-1'), data: [secret] },
    { invoke: (adapter) => adapter.listRaidPlayers('raid-1'), data: [secret] },
    { invoke: (adapter) => adapter.updateProfile(profile), data: [secret] }
  ];
  for (const item of cases) {
    const { adapter } = createAdapter([success('test command', item.data)]);
    await assert.rejects(
      () => item.invoke(adapter),
      (error) => error.code === 'CLI_PROTOCOL_ERROR'
        && error.message === 'The CLI returned an invalid response.'
        && !error.message.includes(secret)
    );
  }
});
