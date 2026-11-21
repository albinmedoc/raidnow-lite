import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countryFlag,
  createBrowserResetController,
  applyStatusIfUnchanged,
  formatRaidRating,
  formatTrainerCode,
  isCurrentMatchedRaid,
  searchStatusDisplay,
  shouldShowEndedRaidNotice,
  leaveCompletionDisplay,
  mutationStatusDecision
} from '../public/ui-helpers.js';

test('formats a trainer code into selectable four-digit groups', () => {
  assert.equal(formatTrainerCode('999988887777'), '9999 8888 7777');
  assert.equal(formatTrainerCode(' 9999-8888-7777 '), '9999 8888 7777');
  assert.equal(formatTrainerCode(''), '—');
});

test('formats zero-star and missing Raid NOW ratings explicitly', () => {
  assert.deepEqual(formatRaidRating(0), {
    text: '★ 0/5',
    title: 'Raid NOW-rating: 0 av 5'
  });
  assert.deepEqual(formatRaidRating(5), {
    text: '★ 5/5',
    title: 'Raid NOW-rating: 5 av 5'
  });
  assert.deepEqual(formatRaidRating(null), {
    text: '★ —',
    title: 'Raid NOW-rating saknas'
  });
});

test('renders country and worldwide flags from normalized player countries', () => {
  assert.equal(countryFlag('se'), '🇸🇪');
  assert.equal(countryFlag('world'), '🌐');
  assert.equal(countryFlag(''), '');
  assert.equal(countryFlag('invalid'), '');
});

test('rejects stale raid details after leaving or changing raids', () => {
  const raid = { rpl_id: 'raid-1' };
  assert.equal(isCurrentMatchedRaid({ state: 'matched', raid }, raid), true);
  assert.equal(isCurrentMatchedRaid({ state: 'idle', raid }, raid), false);
  assert.equal(isCurrentMatchedRaid({ state: 'matched', raid: { rpl_id: 'raid-2' } }, raid), false);
  assert.equal(isCurrentMatchedRaid({ state: 'matched', raid }, { rpl_id: '' }), false);
});

test('leave completion waits for residual queue cleanup before unlocking choices', () => {
  assert.deepEqual(leaveCompletionDisplay({ state: 'reconciling' }), {
    complete: false,
    text: 'Raiden är avslutad i Lite. Raid NOW-kön städas innan du kan söka igen.'
  });
  assert.deepEqual(leaveCompletionDisplay({ state: 'idle' }), {
    complete: true,
    text: 'Raiden är avslutad i Lite. Du kan ändra valen och söka igen.'
  });
});

test('mutation completion invalidates older polls without overwriting a newer SSE status', () => {
  assert.deepEqual(mutationStatusDecision(4, 4), { apply: true, nextRevision: 5 });
  assert.deepEqual(mutationStatusDecision(4, 5), { apply: false, nextRevision: 6 });
});

test('ended raid notice survives recovered SSE state but not leave or a newer match', () => {
  assert.equal(shouldShowEndedRaidNotice('raid-old', null, 4, 4), true);
  assert.equal(shouldShowEndedRaidNotice('raid-old', 'raid-old', 4, 4), true);
  assert.equal(shouldShowEndedRaidNotice('raid-old', 'raid-new', 4, 4), false);
  assert.equal(shouldShowEndedRaidNotice('raid-old', null, 4, 5), false);
});

test('discard delayed status polls after a newer status render', () => {
  const applied = [];
  assert.equal(applyStatusIfUnchanged(4, 5, { state: 'reconciling' }, (status) => applied.push(status)), false);
  assert.deepEqual(applied, []);
  assert.equal(applyStatusIfUnchanged(5, 5, { state: 'idle' }, (status) => applied.push(status)), true);
  assert.deepEqual(applied, [{ state: 'idle' }]);
});

test('keeps the visible search status stable while internal work changes', () => {
  const expected = {
    title: 'Söker i bakgrunden',
    text: 'Du står i kö samtidigt som nya lobbyer bevakas.',
    displayState: 'searching'
  };
  for (const state of ['starting', 'searching', 'joining', 'retrying']) {
    assert.deepEqual(searchStatusDisplay({ state, error: 'Upstream error', directScanDisabled: true }), expected, state);
  }
});

test('browser reset suspends resources before the request and deduplicates clicks', async () => {
  const order = [];
  let resolveRequest;
  const controller = createBrowserResetController({
    suspend() { order.push('suspend'); },
    requestReset() { order.push('request'); return new Promise((resolve) => { resolveRequest = resolve; }); },
    resume() { order.push('resume'); },
    clearLocalData() { order.push('clear'); },
    reload() { order.push('reload'); }
  });

  const first = controller.run();
  const second = controller.run();
  assert.equal(first, second);
  assert.deepEqual(order, ['suspend', 'request']);
  resolveRequest();
  await first;
  assert.deepEqual(order, ['suspend', 'request', 'clear', 'reload']);
});

test('failed browser reset resumes resources and retains local data', async () => {
  const order = [];
  const failure = Object.assign(new Error('conflict'), { status: 409 });
  const controller = createBrowserResetController({
    suspend() { order.push('suspend'); },
    async requestReset() { order.push('request'); throw failure; },
    resume() { order.push('resume'); },
    clearLocalData() { order.push('clear'); },
    reload() { order.push('reload'); }
  });

  await assert.rejects(() => controller.run(), (error) => error === failure);
  assert.deepEqual(order, ['suspend', 'request', 'resume']);
});
