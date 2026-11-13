import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRestoredSearchSelection, normalizeSearchSelection } from '../src/core/search-selection.js';

test('canonicalizes all supported search filters and derives bounded upstream values', () => {
  assert.deepEqual(normalizeSearchSelection({
    strategy: 'fast',
    ranks: ['10', '10'],
    pokemon: ['ダイマックスラティアス', 'ダイマックスラティアス'],
    hostRating: 5,
    hostCountry: 1,
    weatherBoost: 2,
    hostLevel: 70,
    hostEvaluate: Array.from({ length: 10_000 }, (_, index) => index),
    guest6: 1
  }), {
    strategy: 'hybrid',
    ranks: ['10'],
    pokemon: ['ダイマックスラティアス'],
    hostRating: 5,
    hostCountry: 1,
    weatherBoost: 2,
    hostLevel: 70,
    hostEvaluate: [-1, 0, 1, 2, 3, 4],
    guest6: 0
  });
});

test('maps Raid NOW host level zero to TL 5+ and supports only upstream values', () => {
  assert.equal(normalizeSearchSelection({ ranks: ['5'], pokemon: ['Giratina'] }).hostLevel, 0);
  for (const hostLevel of [0, 40, 50, 60, 70]) {
    assert.equal(normalizeSearchSelection({ ranks: ['5'], pokemon: ['Giratina'], hostLevel }).hostLevel, hostLevel);
  }
  assert.throws(() => normalizeSearchSelection({ ranks: ['5'], pokemon: ['Giratina'], hostLevel: 5 }), /host level/i);
});

test('rejects malformed filter scalars and oversized boss arrays', () => {
  assert.throws(() => normalizeSearchSelection({ ranks: ['5'], pokemon: ['Giratina'], hostRating: 6 }), /host rating/i);
  assert.throws(() => normalizeSearchSelection({ ranks: ['5'], pokemon: ['Giratina'], hostCountry: 2 }), /host country/i);
  assert.throws(() => normalizeSearchSelection({ ranks: ['5'], pokemon: ['Giratina'], weatherBoost: 3 }), /weather boost/i);
  assert.throws(() => normalizeSearchSelection({ ranks: ['5'], pokemon: Array.from({ length: 101 }, (_, index) => `boss-${index}`) }), /bosses/i);
});

test('restore drops untrusted derived arrays and defaults invalid filter scalars', () => {
  const restored = normalizeRestoredSearchSelection({
    ranks: ['5'], pokemon: ['Giratina'], hostRating: false, hostCountry: [1], weatherBoost: true, hostLevel: ['70'],
    hostEvaluate: Array.from({ length: 10_000 }, (_, index) => index)
  });
  assert.deepEqual(restored.hostEvaluate, [-1, 0, 1, 2]);
  assert.deepEqual(
    { hostRating: restored.hostRating, hostCountry: restored.hostCountry, weatherBoost: restored.weatherBoost, hostLevel: restored.hostLevel },
    { hostRating: 3, hostCountry: 0, weatherBoost: 0, hostLevel: 0 }
  );
});
