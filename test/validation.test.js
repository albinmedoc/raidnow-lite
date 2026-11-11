import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProfile, validateProfile } from '../src/core/validation.js';

test('normalizes a trainer code before validation', () => {
  const profile = normalizeProfile({ trainerName: 'Albin123', trainerCode: '1234 5678 9012', level: '50', countryCode: 'se' });
  assert.equal(profile.trainerCode, '123456789012');
  assert.equal(profile.level, 50);
});

test('accepts a complete Raid NOW profile', () => {
  assert.deepEqual(validateProfile({ trainerName: 'Albin123', trainerCode: '123456789012', level: 50, countryCode: 'se' }), {});
});

test('reports all invalid profile fields', () => {
  assert.deepEqual(validateProfile({ trainerName: 'å', trainerCode: '123', level: 0, countryCode: '' }), {
    trainerName: 'Use at least 3 letters or numbers (A-Z, 0-9).',
    trainerCode: 'Trainer code must contain exactly 12 digits.',
    level: 'Choose a trainer level.',
    countryCode: 'Choose a country.'
  });
});
