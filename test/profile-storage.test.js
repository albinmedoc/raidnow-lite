import test from 'node:test';
import assert from 'node:assert/strict';
import { clearLocalProfile, loadLocalProfile, saveLocalProfile } from '../public/profile-storage.js';

function storageStub(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    dump(key) { return values.get(key); }
  };
}

test('saves and loads the trainer profile in browser storage', () => {
  const storage = storageStub();
  const profile = { trainerName: 'LocalUser', trainerCode: '123456789012', level: 50, countryCode: 'se' };

  saveLocalProfile(storage, profile);

  assert.deepEqual(loadLocalProfile(storage), profile);
  assert.match(storage.dump('raidnow_profile_v2'), /LocalUser/);
});

test('invalid browser storage does not break startup', () => {
  const storage = storageStub({ raidnow_profile_v2: '{not-json' });
  assert.deepEqual(loadLocalProfile(storage), {});
});

test('ignores profiles stored before the multi-user reset', () => {
  const storage = storageStub({ raidnow_profile: JSON.stringify({ trainerName: 'OldUser' }) });
  assert.deepEqual(loadLocalProfile(storage), {});
});

test('clears only the current versioned trainer profile', () => {
  const storage = storageStub({ raidnow_profile_v2: '{}', raidnow_profile: 'legacy' });
  clearLocalProfile(storage);
  assert.equal(storage.dump('raidnow_profile_v2'), undefined);
  assert.equal(storage.dump('raidnow_profile'), 'legacy');
});
