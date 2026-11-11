import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../src/core/json-store.js';

test('persists merged state atomically as JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'raidnow-lite-'));
  const path = join(dir, 'state.json');
  const store = await JsonStore.open(path, { profile: {}, preferences: {} });
  await store.update({ profile: { trainerName: 'Albin123' } });
  await store.update({ preferences: { rank: '5' } });
  assert.equal(store.get().profile.trainerName, 'Albin123');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).preferences.rank, '5');
});
