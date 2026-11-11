import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRaidBossCatalog, enrichRaids, groupRaidBosses } from '../src/core/raid-catalog.js';

test('adds English display names and images while preserving upstream Pokemon IDs', () => {
  const raids = enrichRaids([{ rpl_id: '1', rpl_rank: '5', rpl_pokemon: 'ザシアン(けんのおう)' }]);
  assert.equal(raids[0].rpl_pokemon, 'ザシアン(けんのおう)');
  assert.equal(raids[0].display_name, 'Zacian (Crowned Sword)');
  assert.match(raids[0].image, /888-1\.png/);
});

test('groups duplicate live raids into one selectable Pokemon boss', () => {
  const bosses = groupRaidBosses(enrichRaids([
    { rpl_id: '1', rpl_rank: '5', rpl_pokemon: 'ザシアン(けんのおう)' },
    { rpl_id: '2', rpl_rank: '5', rpl_pokemon: 'ザシアン(けんのおう)' },
    { rpl_id: '3', rpl_rank: '5', rpl_pokemon: 'ザマゼンタ(たてのおう)' }
  ]));
  assert.equal(bosses.length, 2);
  assert.equal(bosses[0].activeRaids, 2);
  assert.deepEqual(bosses[0].pokemon, ['ザシアン(けんのおう)']);
});

test('builds selectable bosses from the current schedule without homepage activity counts', () => {
  const bosses = buildRaidBossCatalog([
    { rank: '5', pokemon: 'ザシアン(けんのおう)' },
    { rank: '5', pokemon: 'ザマゼンタ(たてのおう)' },
    { rank: '3', pokemon: 'ピカチュウ' }
  ]);
  assert.equal(bosses.length, 3);
  assert.equal(bosses[0].displayName, 'Zacian (Crowned Sword)');
  assert.deepEqual(bosses[0].pokemon, ['ザシアン(けんのおう)']);
  assert.equal('activeRaids' in bosses[0], false);
});
