import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SELECTION_KEY,
  catalogForWorkerView,
  clearLocalSelection,
  filterBossCatalog,
  isWorkerLocked,
  loadLocalSelection,
  nextStaleWarningCount,
  popularBosses,
  reconcileSelection,
  saveLocalSelection
} from '../public/selection-storage.js';

function storageStub(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    dump(key) { return values.get(key); }
  };
}

const catalog = [
  { id: '5\u0000ザシアン', rank: '5', pokemon: ['ザシアン'], displayName: 'Zacian' },
  { id: '3\u0000ピカチュウ', rank: '3', pokemon: ['ピカチュウ'], displayName: 'Pikachu' },
  { id: '1\u0000Pikachu Libre', rank: '1', pokemon: ['Pikachu Libre'], displayName: 'Pikachu Libre' }
];

test('persists exact boss identities and search controls in versioned storage', () => {
  const storage = storageStub();
  const saved = saveLocalSelection(storage, {
    bossIds: ['5\u0000ザシアン', '3\u0000ピカチュウ'],
    hostLevel: 40,
    weatherBoost: 1,
    rankFilter: '5',
    textFilter: 'zaci'
  });

  assert.deepEqual(loadLocalSelection(storage), saved);
  assert.equal(SELECTION_KEY, 'raidnow_selection_v1');
  assert.match(storage.dump(SELECTION_KEY), /5\\u0000ザシアン/);
});

test('ignores malformed, old, and invalid selection storage safely', () => {
  assert.deepEqual(loadLocalSelection(storageStub({ [SELECTION_KEY]: '{bad' })), null);
  assert.deepEqual(loadLocalSelection(storageStub({ raidnow_selection: JSON.stringify({ bossIds: ['5\u0000ザシアン'] }) })), null);
  assert.deepEqual(loadLocalSelection(storageStub({ [SELECTION_KEY]: JSON.stringify({ version: 99, bossIds: [] }) })), null);
  assert.deepEqual(loadLocalSelection(storageStub({ [SELECTION_KEY]: JSON.stringify({ version: 1, bossIds: ['not-an-exact-id'] }) })), null);
});

test('reconciles local selection against the current catalog and reports stale IDs deterministically', () => {
  const result = reconcileSelection(catalog, {
    bossIds: ['missing\u0000Boss', '3\u0000ピカチュウ', '5\u0000ザシアン'],
    hostLevel: 20,
    weatherBoost: 2
  });

  assert.deepEqual(result.selected.map((boss) => boss.id), ['5\u0000ザシアン', '3\u0000ピカチュウ']);
  assert.deepEqual(result.staleIds, ['missing\u0000Boss']);
  assert.equal(result.source, 'local');
});

test('active server selection overrides local selection and reports missing server bosses', () => {
  const result = reconcileSelection(catalog, { bossIds: ['3\u0000ピカチュウ'] }, {
    ranks: ['5'],
    pokemon: ['ザシアン', 'Försvunnen']
  });

  assert.deepEqual(result.selected.map((boss) => boss.id), ['5\u0000ザシアン']);
  assert.deepEqual(result.missingServerPokemon, ['Försvunnen']);
  assert.equal(result.source, 'server');
});

test('filters the full catalog locally by rank, English name, or upstream ID', () => {
  assert.deepEqual(filterBossCatalog(catalog, '3', '').map((boss) => boss.id), ['3\u0000ピカチュウ']);
  assert.deepEqual(filterBossCatalog(catalog, '0', 'libre').map((boss) => boss.id), ['1\u0000Pikachu Libre']);
  assert.deepEqual(filterBossCatalog(catalog, '0', 'ピカ').map((boss) => boss.id), ['3\u0000ピカチュウ']);
});

test('active worker view shows selected catalog bosses regardless of saved filters', () => {
  const selectedIds = new Set(['5\u0000ザシアン']);
  assert.deepEqual(
    catalogForWorkerView(catalog, selectedIds, { active: true, rank: '3', text: 'pika' }).map((boss) => boss.id),
    ['5\u0000ザシアン']
  );
  assert.deepEqual(
    catalogForWorkerView(catalog, selectedIds, { active: false, rank: '3', text: 'pika' }).map((boss) => boss.id),
    ['3\u0000ピカチュウ']
  );
});

test('selects the five most popular bosses by Auto Join waiting count with stable tie ordering', () => {
  const bosses = [
    { id: 'a', displayName: 'A', waitingCount: 2 },
    { id: 'b', displayName: 'B', waitingCount: 12 },
    { id: 'c', displayName: 'C', waitingCount: 0 },
    { id: 'd', displayName: 'D', waitingCount: 7 },
    { id: 'e', displayName: 'E', waitingCount: 12 },
    { id: 'f', displayName: 'F', waitingCount: 4 }
  ];
  assert.deepEqual(popularBosses(bosses, 5).map((boss) => boss.id), ['b', 'e', 'd', 'f', 'a']);
});

test('stale selection warning survives rerenders until selection or catalog changes', () => {
  assert.equal(nextStaleWarningCount(0, { staleIds: ['missing'] }), 1);
  assert.equal(nextStaleWarningCount(1, { staleIds: [] }), 1);
  assert.equal(nextStaleWarningCount(1, { staleIds: [] }, { dismiss: true }), 0);
});

test('locks controls for every transitional worker state only', () => {
  for (const state of ['starting', 'searching', 'retrying', 'joining', 'stopping', 'reconciling']) assert.equal(isWorkerLocked(state), true, state);
  for (const state of ['idle', 'stopped', 'error', 'matched']) assert.equal(isWorkerLocked(state), false, state);
});

test('clears only the current versioned selection key', () => {
  const storage = storageStub({ [SELECTION_KEY]: '{}', raidnow_selection: 'legacy' });
  clearLocalSelection(storage);
  assert.equal(storage.dump(SELECTION_KEY), undefined);
  assert.equal(storage.dump('raidnow_selection'), 'legacy');
});
