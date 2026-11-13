import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRaidBossCatalog, enrichRaids, groupRaidBosses } from '../src/core/raid-catalog.js';

test('uses display metadata supplied by Raid NOW while preserving upstream Pokemon IDs', () => {
  const raids = enrichRaids([{
    rpl_id: '1', rpl_rank: '11', rpl_pokemon: 'キョダイマックスリザードン',
    displayName: 'Gigantamax Charizard', image: 'https://example.test/charizard.png'
  }]);
  assert.equal(raids[0].rpl_pokemon, 'キョダイマックスリザードン');
  assert.equal(raids[0].display_name, 'Gigantamax Charizard');
  assert.equal(raids[0].image, 'https://example.test/charizard.png');
});

test('groups duplicate live raids into one selectable Pokemon boss', () => {
  const bosses = groupRaidBosses(enrichRaids([
    { rpl_id: '1', rpl_rank: '5', rpl_pokemon: 'ザシアン(けんのおう)', displayName: 'Zacian' },
    { rpl_id: '2', rpl_rank: '5', rpl_pokemon: 'ザシアン(けんのおう)', displayName: 'Zacian' },
    { rpl_id: '3', rpl_rank: '5', rpl_pokemon: 'ザマゼンタ(たてのおう)', displayName: 'Zamazenta' }
  ]));
  assert.equal(bosses.length, 2);
  assert.equal(bosses[0].activeRaids, 2);
  assert.deepEqual(bosses[0].pokemon, ['ザシアン(けんのおう)']);
});

test('builds selectable bosses from the current schedule with Auto Join waiting counts', () => {
  const bosses = buildRaidBossCatalog([
    { rank: '5', pokemon: 'ザシアン(けんのおう)', displayName: 'Zacian (Crowned Sword)', image: 'https://example.test/zacian.png', waitingCount: 28 },
    { rank: '5', pokemon: 'ザマゼンタ(たてのおう)', displayName: 'Zamazenta (Crowned Shield)', image: 'https://example.test/zamazenta.png' },
    { rank: '3', pokemon: 'ピカチュウ', displayName: 'Pikachu', image: 'https://example.test/pikachu.png' }
  ]);
  assert.equal(bosses.length, 3);
  assert.equal(bosses[0].displayName, 'Zacian (Crowned Sword)');
  assert.equal(bosses[0].image, 'https://example.test/zacian.png');
  assert.equal(bosses[0].waitingCount, 28);
  assert.deepEqual(bosses[0].pokemon, ['ザシアン(けんのおう)']);
  assert.equal('activeRaids' in bosses[0], false);
});
