import test from 'node:test';
import assert from 'node:assert/strict';
import { RaidNowAdapter } from '../src/adapters/raidnow-adapter.js';

function fakeFetch(responses, calls) {
  return async (url, options = {}) => {
    if (options.method === 'GET') {
      return { ok: true, status: 200, async text() { return '<script>var aryPokemon = {}; var aryPokeRaid = {};</script>'; } };
    }
    calls.push({ url, options, body: new URLSearchParams(options.body) });
    const value = responses.shift();
    return { ok: true, status: 200, headers: { get() { return null; } }, async json() { return value; }, async text() { return JSON.stringify(value); } };
  };
}

const profile = { trainerName: 'Albin123', trainerCode: '123456789012', level: 50, countryCode: 'se' };
const selection = { ranks: ['5', '4'], pokemon: ['Giratina'], hostCountry: 0, weatherBoost: 0, guest6: 0, hostEvaluate: [-1, 0, 1, 2], hostLevel: 0 };

test('serializes Auto Join create like the original jQuery client', async () => {
  const calls = [];
  const adapter = new RaidNowAdapter({ fetchImpl: fakeFetch([{ status: 'success', list: [] }], calls), allowWrites: true });
  await adapter.createMatching({ profile, selection });

  const body = calls[0].body;
  assert.equal(body.get('type'), 'line_matching_create');
  assert.deepEqual(body.getAll('rank[]'), ['5', '4']);
  assert.deepEqual(body.getAll('pokemon[]'), ['Giratina']);
  assert.equal(body.get('code'), '123456789012');
  assert.equal(body.get('tid'), 'Albin123');
  assert.equal(body.get('level'), '50');
  assert.equal(body.get('country_code'), 'se');
  assert.equal(calls[0].options.headers.origin, 'https://raidnow.leekduck.com');
  assert.equal(calls[0].options.headers.referer, 'https://raidnow.leekduck.com/');
});

test('times out a hung Auto Join create with an abort signal', async () => {
  let receivedSignal = null;
  const fetchImpl = async (_url, options) => {
    receivedSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  };
  const adapter = new RaidNowAdapter({
    fetchImpl,
    allowWrites: true,
    operationTimeouts: { line_matching_create: 5 }
  });

  await assert.rejects(
    () => adapter.createMatching({ profile, selection }),
    /Auto Join create timed out/i
  );
  assert.equal(receivedSignal.aborted, true);
});

test('times out while reading a response body that ignores abort', async () => {
  let receivedSignal = null;
  const fetchImpl = async (_url, options) => {
    receivedSignal = options.signal;
    return {
      ok: true,
      status: 200,
      text() { return new Promise(() => {}); }
    };
  };
  const adapter = new RaidNowAdapter({
    fetchImpl,
    allowWrites: true,
    operationTimeouts: { line_matching_create: 5 }
  });

  await assert.rejects(
    () => adapter.createMatching({ profile, selection }),
    /Auto Join create timed out/i
  );
  assert.equal(receivedSignal.aborted, true);
});

test('aborts an Auto Join create when its caller cancels the operation', async () => {
  const controller = new AbortController();
  let receivedSignal = null;
  const fetchImpl = async (_url, options) => {
    receivedSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  };
  const adapter = new RaidNowAdapter({ fetchImpl, allowWrites: true });
  const pending = adapter.createMatching({ profile, selection }, { signal: controller.signal });
  controller.abort(new Error('worker stopped'));

  await assert.rejects(() => pending, /worker stopped/i);
  assert.equal(receivedSignal.aborted, true);
});

test('caller cancellation is not relabeled as a later timeout when the body ignores abort', async () => {
  const controller = new AbortController();
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text() { return new Promise(() => {}); }
  });
  const adapter = new RaidNowAdapter({
    fetchImpl,
    allowWrites: true,
    operationTimeouts: { line_matching_create: 10 }
  });
  const pending = adapter.createMatching({ profile, selection }, { signal: controller.signal });
  controller.abort(new Error('worker stopped'));

  await assert.rejects(() => pending, /worker stopped/i);
  await new Promise((resolve) => setTimeout(resolve, 15));
});

test('uses the raid-list timeout and label for a hung list request', async () => {
  const fetchImpl = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });
  const adapter = new RaidNowAdapter({
    fetchImpl,
    operationTimeouts: { par_list: 5 }
  });

  await assert.rejects(() => adapter.listRaids(), /Raid list timed out/i);
});

test('forwards caller cancellation to an Auto Join poll', async () => {
  const controller = new AbortController();
  const fetchImpl = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });
  const adapter = new RaidNowAdapter({ fetchImpl });
  const pending = adapter.pollMatching({ selection }, { signal: controller.signal });
  controller.abort(new Error('poll cancelled'));

  await assert.rejects(() => pending, /poll cancelled/i);
});

test('posts the trainer profile using the upstream user_info_post contract', async () => {
  const calls = [];
  const adapter = new RaidNowAdapter({ fetchImpl: fakeFetch([{}], calls), allowWrites: true });
  await adapter.updateProfile(profile);
  const body = calls[0].body;
  assert.equal(body.get('type'), 'user_info_post');
  assert.equal(body.get('input_tid'), 'Albin123');
  assert.equal(body.get('input_level'), '50');
  assert.equal(body.get('input_code'), '123456789012');
  assert.equal(body.get('input_country_code'), 'se');
});

test('accepts an empty HTTP 200 response when saving the upstream profile', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async text() { return ''; }
  });
  const adapter = new RaidNowAdapter({ fetchImpl, allowWrites: true });
  assert.deepEqual(await adapter.updateProfile(profile), {});
});

test('logs in through raidnow.leekduck.com and retains the returned token', async () => {
  const calls = [];
  const response = { status: 'success', token: 'account-token', rplu_tid: 'Albin123', rplu_level: 50, rplu_code: '123456789012' };
  const adapter = new RaidNowAdapter({ fetchImpl: fakeFetch([response, { list: [] }], calls) });
  const result = await adapter.login({ email: 'user@example.com', password: 'secret' });
  assert.equal(result.status, 'success');
  assert.equal(adapter.hasToken(), true);
  assert.equal(calls[0].url, 'https://raidnow.leekduck.com/');
  assert.equal(calls[0].body.get('type'), 'login');
  await adapter.listRaids();
  assert.equal(calls[1].body.get('token'), 'account-token');
});

test('surfaces upstream session errors while listing raids as recoverable authentication failures', async () => {
  const adapter = new RaidNowAdapter({ fetchImpl: fakeFetch([{ status: 'error', text: 'The session has expired. Please restart.' }], []) });
  await assert.rejects(
    () => adapter.listRaids(),
    (error) => error.status === 401 && /session has expired/i.test(error.message)
  );
});

test('blocks mutating upstream operations unless live writes are enabled', async () => {
  const adapter = new RaidNowAdapter({ fetchImpl: async () => { throw new Error('must not call fetch'); }, allowWrites: false });
  await assert.rejects(() => adapter.createMatching({ profile, selection }), /live writes are disabled/i);
});

test('finds the requested raid from the raw par_find_first array', async () => {
  const calls = [];
  const adapter = new RaidNowAdapter({ fetchImpl: fakeFetch([[{ rpl_id: 'a' }, { rpl_id: 'b', rpl_pokemon: 'Giratina' }]], calls) });
  const raid = await adapter.findRaid('b');
  assert.equal(raid.rpl_pokemon, 'Giratina');
  assert.equal(calls[0].body.get('type'), 'par_find_first');
  assert.equal(calls[0].body.get('firstaccess'), 'b');
});

test('loads the players in an active raid', async () => {
  const calls = [];
  const response = { list: [{ rplc_tid: 'PlayerOne', rplc_level: 50, my: 1 }], count: 1, readycount: 0 };
  const adapter = new RaidNowAdapter({ fetchImpl: fakeFetch([response], calls), token: 'token' });
  const result = await adapter.listRaidPlayers('raid-1');
  assert.equal(result.players[0].trainerName, 'PlayerOne');
  assert.equal(result.players[0].level, 50);
  assert.equal(result.players[0].isMe, true);
  assert.equal(calls[0].body.get('type'), 'child_list');
  assert.equal(calls[0].body.get('parid'), 'raid-1');
});

test('leaves an active raid using the original guest delete operation', async () => {
  const calls = [];
  const adapter = new RaidNowAdapter({ fetchImpl: fakeFetch([{ status: 'success' }], calls), allowWrites: true, token: 'token' });
  await adapter.leaveRaid('raid-1');
  assert.equal(calls[0].body.get('type'), 'guest_raid_del_post');
  assert.equal(calls[0].body.get('edit'), 'raid-1');
});

test('loads every selectable boss from the original Auto Join list', async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push({ body: new URLSearchParams(options.body) });
    return { ok: true, status: 200, async text() { return JSON.stringify({ list: [
      { rank: '1', pokemon: 'egg', offegg: '3' },
      { rank: '1', pokemon: 'ピカチュウ', offpokemon: '0' },
      { rank: '5', pokemon: 'ギラティナ', offpokemon: '5' },
      { rank: '5', pokemon: 'ザシアン(けんのおう)', offpokemon: '14' }
    ] }); } };
  };
  const adapter = new RaidNowAdapter({ fetchImpl, token: 'anonymous-token' });
  const bosses = await adapter.listCurrentRaidBosses();
  assert.deepEqual(bosses, [
    { rank: '1', pokemon: 'ピカチュウ', displayName: 'ピカチュウ', image: '', waitingCount: 0 },
    { rank: '5', pokemon: 'ギラティナ', displayName: 'ギラティナ', image: '', waitingCount: 5 },
    { rank: '5', pokemon: 'ザシアン(けんのおう)', displayName: 'ザシアン(けんのおう)', image: '', waitingCount: 14 }
  ]);
  assert.equal(calls[0].body.get('type'), 'line_matching_get_list');
  assert.equal(calls[0].body.get('token'), 'anonymous-token');
});

test('loads boss display names and images from Raid NOW metadata', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === 'POST') {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ list: [{ rank: '11', pokemon: 'キョダイマックスリザードン', offpokemon: '7' }] });
        }
      };
    }
    return {
      ok: true,
      status: 200,
      async text() {
        return '<script>var aryPokemon = {"キョダイマックスリザードン":{"en":"Gigantamax Charizard","image":"https://example.test/charizard.png"}}; var aryPokeRaid = {};</script>';
      }
    };
  };
  const adapter = new RaidNowAdapter({ fetchImpl, token: 'anonymous-token' });

  assert.deepEqual(await adapter.listCurrentRaidBosses(), [{
    rank: '11',
    pokemon: 'キョダイマックスリザードン',
    displayName: 'Gigantamax Charizard',
    image: 'https://example.test/charizard.png',
    waitingCount: 7
  }]);
  assert.equal(calls[1].url, 'https://raidnow.leekduck.com/');
  assert.equal(calls[1].options.method, 'GET');
});

test('times out the Raid NOW metadata fetch with its own abort signal', async () => {
  let metadataSignal = null;
  const fetchImpl = async (_url, options) => {
    if (options.method === 'POST') {
      return {
        ok: true,
        status: 200,
        async text() { return JSON.stringify({ list: [{ rank: '5', pokemon: 'Giratina' }] }); }
      };
    }
    metadataSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  };
  const adapter = new RaidNowAdapter({
    fetchImpl,
    operationTimeouts: { pokemon_metadata: 5 }
  });

  const bosses = await adapter.listCurrentRaidBosses();
  assert.equal(bosses[0].displayName, 'Giratina');
  assert.equal(metadataSignal.aborted, true);
});

test('propagates caller cancellation from the Raid NOW metadata fetch', async () => {
  const controller = new AbortController();
  let metadataStarted;
  let postCompleted;
  const started = new Promise((resolve) => { metadataStarted = resolve; });
  const completed = new Promise((resolve) => { postCompleted = resolve; });
  const fetchImpl = async (_url, options) => {
    if (options.method === 'POST') {
      return {
        ok: true,
        status: 200,
        async text() {
          postCompleted();
          return JSON.stringify({ list: [{ rank: '5', pokemon: 'Giratina' }] });
        }
      };
    }
    metadataStarted();
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  };
  const adapter = new RaidNowAdapter({ fetchImpl });
  const pending = adapter.listCurrentRaidBosses({ signal: controller.signal });
  await Promise.all([started, completed]);
  await new Promise((resolve) => setImmediate(resolve));
  const reason = new Error('boss list cancelled');
  controller.abort(reason);

  await assert.rejects(pending, (error) => error === reason);
});

test('fast joins a specific lobby using the original child_post_fast contract', async () => {
  const calls = [];
  const adapter = new RaidNowAdapter({ fetchImpl: fakeFetch([{ status: 'success', data: { rpl_id: 'raid-42' } }], calls), allowWrites: true, token: 'token-123' });
  const response = await adapter.joinRaidFast('raid-42', {
    trainerName: 'Albin123', level: 50, countryCode: 'se'
  });
  assert.equal(response.status, 'success');
  assert.equal(calls[0].body.get('type'), 'child_post_fast');
  assert.equal(calls[0].body.get('parid'), 'raid-42');
  assert.equal(calls[0].body.get('tid'), 'Albin123');
  assert.equal(calls[0].body.get('level'), '50');
  assert.equal(calls[0].body.get('country_code'), 'se');
  assert.equal(calls[0].body.get('token'), 'token-123');
});

test('filters the live lobby page down to the selected fast-search bosses', async () => {
  const calls = [];
  const adapter = new RaidNowAdapter({
    token: 'token-123',
    fetchImpl: fakeFetch([
      { list: [
        { rank: '5', pokemon: 'ギラティナ' },
        { rank: '5', pokemon: 'ザシアン(けんのおう)' },
        { rank: '10', pokemon: 'ダイマックスレジスチル' }
      ] },
      [{ rpl_id: 'raid-1', rpl_rank: '5', rpl_pokemon: 'ギラティナ' }]
    ], calls)
  });
  const raids = await adapter.listRaidsForSelection({ ranks: ['5'], pokemon: ['ギラティナ'] });
  assert.equal(raids[0].rpl_id, 'raid-1');
  assert.equal(calls[0].body.get('type'), 'line_matching_get_list');
  assert.equal(calls[1].body.get('type'), 'par_list');
  assert.deepEqual(calls[1].body.getAll('filter[]').sort(), ['ザシアン(けんのおう)', 'ダイマックスレジスチル'].sort());
  assert.equal(calls[1].body.get('searchrank'), '5');
});
