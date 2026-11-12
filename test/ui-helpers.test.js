import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserResetController, formatTrainerCode, isCurrentMatchedRaid } from '../public/ui-helpers.js';

test('formats a trainer code into selectable four-digit groups', () => {
  assert.equal(formatTrainerCode('999988887777'), '9999 8888 7777');
  assert.equal(formatTrainerCode(' 9999-8888-7777 '), '9999 8888 7777');
  assert.equal(formatTrainerCode(''), '—');
});

test('rejects stale raid details after leaving or changing raids', () => {
  const raid = { rpl_id: 'raid-1' };
  assert.equal(isCurrentMatchedRaid({ state: 'matched', raid }, raid), true);
  assert.equal(isCurrentMatchedRaid({ state: 'idle', raid }, raid), false);
  assert.equal(isCurrentMatchedRaid({ state: 'matched', raid: { rpl_id: 'raid-2' } }, raid), false);
  assert.equal(isCurrentMatchedRaid({ state: 'matched', raid }, { rpl_id: '' }), false);
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
