import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countryFlag,
  createBrowserResetController,
  applyStatusIfUnchanged,
  formatRaidRating,
  formatTrainerCode,
  isActiveRaidRequestCurrent,
  isCurrentMatchedRaid,
  loadActiveRaidDetailsIfCurrent,
  searchStatusDisplay,
  shouldShowEndedRaidNotice,
  mutationStatusDecision,
  activeRaidPresentation,
  queueSelectionFromBosses,
  workflowStatusPresentation
} from '../public/ui-helpers.js';

test('builds paired queue arguments when selected bosses share a tier', () => {
  assert.deepEqual(queueSelectionFromBosses([
    { rank: '5', pokemon: ['150'] },
    { rank: '5', pokemon: ['487'] },
    { rank: '5', pokemon: ['150'] }
  ]), {
    ranks: ['5', '5'],
    pokemon: ['150', '487']
  });
});

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

test('unknown raid membership offers recovery leave without showing matched details', () => {
  const raid = { rpl_id: 'raid-1', rpl_pokemon: 'Giratina' };
  assert.deepEqual(activeRaidPresentation({
    state: 'searching', raid, raidMembership: 'unknown', canRequestLeave: true
  }), {
    matchedRaid: null,
    recoveryRaid: raid
  });
  assert.deepEqual(activeRaidPresentation({
    state: 'matched', raid, raidMembership: 'matched', canRequestLeave: true
  }), {
    matchedRaid: raid,
    recoveryRaid: null
  });
  assert.deepEqual(activeRaidPresentation({
    state: 'matched', raid, raidMembership: 'leaving', canRequestLeave: false
  }), {
    matchedRaid: raid,
    recoveryRaid: null
  });
  assert.deepEqual(activeRaidPresentation({
    state: 'searching', raid, raidMembership: 'unknown', canRequestLeave: false
  }), {
    matchedRaid: null,
    recoveryRaid: null
  });
});

test('authoritative workflow notices project to one stable banner presentation', () => {
  assert.deepEqual(workflowStatusPresentation({
    workflowNotice: {
      kind: 'leave-cleanup',
      severity: 'info',
      message: 'Raiden är avslutad i Lite. Raid NOW-kön städas innan du kan söka igen.'
    }
  }), {
    title: 'Raiden lämnas',
    text: 'Raiden är avslutad i Lite. Raid NOW-kön städas innan du kan söka igen.',
    displayState: 'reconciling'
  });
  assert.deepEqual(workflowStatusPresentation({
    workflowNotice: {
      kind: 'leave-complete',
      severity: 'success',
      message: 'Raiden är avslutad i Lite. Du kan ändra valen och söka igen.'
    }
  }), {
    title: 'Raiden är avslutad',
    text: 'Raiden är avslutad i Lite. Du kan ändra valen och söka igen.',
    displayState: 'stopped'
  });
  assert.equal(workflowStatusPresentation({ state: 'matched' }), null);
});

test('terminal status errors override stale informational workflow notices', () => {
  for (const state of ['error', 'matched', 'stopped']) {
    assert.deepEqual(workflowStatusPresentation({
      state,
      error: 'Queue cancellation is unavailable (501).',
      workflowNotice: {
        kind: 'leave-cleanup',
        severity: 'info',
        message: 'Raiden är avslutad i Lite. Raid NOW-kön städas innan du kan söka igen.'
      }
    }), {
      title: 'Sökningen misslyckades',
      text: 'Queue cancellation is unavailable (501).',
      displayState: 'error'
    }, state);
  }
});

test('active raid details resolving during leave cannot restore any raid presentation', async () => {
  let resolveDetails;
  let resolveLeave;
  let generation = 0;
  const raid = { rpl_id: 'raid-1', rpl_code: '999988887777' };
  const presentation = {
    code: '—',
    qr: null,
    meta: 'Lämnar…',
    readyDisabled: true,
    boss: '',
    host: '',
    players: []
  };
  const detailsRequest = new Promise((resolve) => { resolveDetails = resolve; });
  const leaveRequest = new Promise((resolve) => { resolveLeave = resolve; });
  const details = loadActiveRaidDetailsIfCurrent({
    requestDetails: () => detailsRequest,
    requestedRaidId: 'raid-1',
    requestGeneration: generation,
    current: () => ({
      activeRaidId: 'raid-1',
      requestGeneration: generation,
      status: { state: 'matched', raid }
    })
  });

  generation += 1;
  const leaving = leaveRequest;
  resolveDetails({
    raid: { ...raid, rpl_tid: 'Ghost host', rpl_pokemon: 'Giratina' },
    fetchedAt: '2026-11-24T12:00:00.000Z',
    count: 1,
    readyCount: 0,
    players: [{ trainerName: 'Ghost', isMe: true, ready: 0 }]
  });

  const stale = await details;
  if (stale) {
    presentation.code = stale.raid.rpl_code;
    presentation.qr = 'restored';
    presentation.meta = stale.fetchedAt;
    presentation.readyDisabled = false;
    presentation.boss = stale.raid.rpl_pokemon;
    presentation.host = stale.raid.rpl_tid;
    presentation.players = stale.players;
  }

  assert.equal(stale, null);
  assert.deepEqual(presentation, {
    code: '—', qr: null, meta: 'Lämnar…', readyDisabled: true, boss: '', host: '', players: []
  });
  let leaveSettled = false;
  leaving.then(() => { leaveSettled = true; });
  await Promise.resolve();
  assert.equal(leaveSettled, false);
  resolveLeave();
  await leaving;
});

test('active raid details rejecting after leave starts cannot overwrite leave-safe presentation', async () => {
  let rejectDetails;
  let resolveLeave;
  const activeRaidId = 'raid-1';
  let generation = 7;
  const presentation = {
    meta: 'Uppdaterad nyss',
    qr: '9999 8888 7777',
    readyDisabled: false,
    leaveDisabled: false
  };
  const detailsRequest = new Promise((_resolve, reject) => { rejectDetails = reject; });
  const leaveRequest = new Promise((resolve) => { resolveLeave = resolve; });
  const requestedRaidId = activeRaidId;
  const requestGeneration = generation;
  assert.equal(isActiveRaidRequestCurrent(
    requestedRaidId,
    activeRaidId,
    requestGeneration,
    generation
  ), true);
  const details = (async () => {
    try {
      await detailsRequest;
    } catch (error) {
      if (!isActiveRaidRequestCurrent(
        requestedRaidId,
        activeRaidId,
        requestGeneration,
        generation
      )) return;
      presentation.meta = `Kunde inte uppdatera raiden: ${error.message}`;
    }
  })();

  generation += 1;
  presentation.meta = 'Lämnar…';
  presentation.qr = null;
  presentation.readyDisabled = true;
  presentation.leaveDisabled = true;
  const leaving = leaveRequest;
  rejectDetails(new Error('late details failure'));
  await details;

  assert.deepEqual(presentation, {
    meta: 'Lämnar…', qr: null, readyDisabled: true, leaveDisabled: true
  });
  assert.equal(activeRaidId, 'raid-1');
  let leaveSettled = false;
  leaving.then(() => { leaveSettled = true; });
  await Promise.resolve();
  assert.equal(leaveSettled, false);
  resolveLeave();
  await leaving;
});

test('matched leave failure keeps both matched details and the workflow banner visible', () => {
  const status = {
    state: 'matched',
    raidMembership: 'matched',
    canRequestLeave: true,
    raid: { rpl_id: 'raid-1', rpl_pokemon: 'Giratina' },
    workflowNotice: {
      kind: 'leave-unavailable',
      severity: 'error',
      message: 'Raiden kunde inte lämnas eftersom funktionen inte är tillgänglig.'
    }
  };

  assert.equal(activeRaidPresentation(status).matchedRaid, status.raid);
  assert.deepEqual(workflowStatusPresentation(status), {
    title: 'Kunde inte lämna raiden',
    text: 'Raiden kunde inte lämnas eftersom funktionen inte är tillgänglig.',
    displayState: 'error'
  });

  const refreshedDetails = { raid: { ...status.raid, rpl_tid: 'Host' }, fetchedAt: '2026-11-24T12:00:00.000Z' };
  assert.equal(isCurrentMatchedRaid(status, refreshedDetails.raid), true);
  assert.deepEqual(workflowStatusPresentation(status), {
    title: 'Kunde inte lämna raiden',
    text: 'Raiden kunde inte lämnas eftersom funktionen inte är tillgänglig.',
    displayState: 'error'
  });
});

test('unknown recovery failure is visible outside confirmed matched details', () => {
  const status = {
    state: 'reconciling',
    raidMembership: 'unknown',
    canRequestLeave: true,
    raid: { rpl_id: 'raid-1' },
    workflowNotice: {
      kind: 'raid-reconciliation-failed',
      severity: 'error',
      message: 'Raid-medlemskapet kunde inte bekräftas. Lite försöker igen.'
    }
  };
  assert.equal(activeRaidPresentation(status).matchedRaid, null);
  assert.ok(activeRaidPresentation(status).recoveryRaid);
  assert.deepEqual(workflowStatusPresentation(status), {
    title: 'Raiden behöver återställas',
    text: 'Raid-medlemskapet kunde inte bekräftas. Lite försöker igen.',
    displayState: 'error'
  });
});

test('mutation completion invalidates older polls without overwriting a newer SSE status', () => {
  assert.deepEqual(mutationStatusDecision(4, 4), { apply: true, nextRevision: 5 });
  assert.deepEqual(mutationStatusDecision(4, 5), { apply: false, nextRevision: 6 });
});

test('newer SSE beats leave mutation and successful mutation invalidates a later poll', () => {
  const rendered = [];
  let revision = 4;
  const leaveStart = revision;
  const pollStart = revision;

  revision += 1;
  rendered.push('sse-cleanup');
  const mutation = mutationStatusDecision(leaveStart, revision);
  revision = mutation.nextRevision;
  assert.equal(mutation.apply, false);
  assert.equal(applyStatusIfUnchanged(pollStart, revision, { state: 'matched' }, (status) => rendered.push(status.state)), false);
  assert.deepEqual(rendered, ['sse-cleanup']);
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
