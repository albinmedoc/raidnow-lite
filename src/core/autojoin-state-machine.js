const WRITE_KINDS = new Set(['createQueue', 'cancelQueue', 'joinRaid', 'leaveRaid']);

export function initialSnapshot() {
  return {
    schemaVersion: 2,
    intent: 'idle',
    startedAt: null,
    search: null,
    queue: { state: 'none' },
    raid: { state: 'none', target: null, value: null },
    operation: null,
    wake: null,
    terminal: { target: 'idle', error: null },
    lastContactAt: null,
    retryCount: 0,
    lastError: null,
    opSequence: 0
  };
}

function clone(value) {
  return structuredClone(value);
}

function at(now, delay = 0) {
  return new Date(Date.parse(now) + delay).toISOString();
}

function operation(snapshot, kind, input, now, attempt = 1) {
  const sequence = Number(snapshot.opSequence || 0) + 1;
  return {
    opSequence: sequence,
    operation: {
      opId: `${kind}:${now}:${sequence}`,
      kind,
      input: clone(input ?? {}),
      startedAt: now,
      attempt
    }
  };
}

function withOperation(snapshot, kind, input, now, attempt = 1) {
  const next = operation(snapshot, kind, input, now, attempt);
  return {
    snapshot: { ...snapshot, operation: next.operation, wake: null, opSequence: next.opSequence },
    effects: [{ type: 'adapter', opId: next.operation.opId }]
  };
}

function withWake(snapshot, kind, now, delay) {
  return {
    snapshot: { ...snapshot, operation: null, wake: { kind, dueAt: at(now, delay) } },
    effects: [{ type: 'timer', kind, dueAt: at(now, delay) }]
  };
}

function noChange(snapshot) {
  return { snapshot, effects: [] };
}

function errorText(event) {
  return event.error?.message || String(event.error || 'Unknown Auto Join error.');
}

function isSuccess(value) {
  return !value?.status || value.status === 'success';
}

function isAlreadyGone(value) {
  return /inte längre|redan lämnat|not (?:in|part of)|already (?:left|gone)|not found/i.test(String(value?.text || ''));
}

function selectedRaid(snapshot, raids, now) {
  const selection = snapshot.search?.selection ?? {};
  const profile = snapshot.search?.profile ?? {};
  const pokemon = new Set((selection.pokemon ?? []).map(String));
  const ranks = new Set((selection.ranks ?? []).map(String));
  const attempted = snapshot.search?.attemptedRaids ?? {};
  return (Array.isArray(raids) ? raids : []).find((raid) =>
    raid?.rpl_id &&
    pokemon.has(String(raid.rpl_pokemon)) &&
    ranks.has(String(raid.rpl_rank)) &&
    Number(raid.rpl_deleted || 0) === 0 &&
    Number(raid.my || 0) !== 1 &&
    (!Number(selection.hostLevel || 0) || Number(raid.rpl_level || 0) >= Number(selection.hostLevel)) &&
    (Number(selection.weatherBoost || 0) !== 1 || Number(raid.rpl_weather || 0) === 1) &&
    (Number(selection.weatherBoost || 0) !== 2 || Number(raid.rpl_weather || 0) !== 1) &&
    (Number(raid.join || 0) === 1 || Number(raid.rpl_glevel || 0) <= Number(profile.level || 0)) &&
    (!Number.isFinite(Date.parse(attempted[String(raid.rpl_id)])) || Date.parse(now) - Date.parse(attempted[String(raid.rpl_id)]) >= 10_000)
  ) ?? null;
}

function terminalize(snapshot) {
  if (snapshot.queue.state !== 'none' || snapshot.raid.state !== 'none' || snapshot.operation) return snapshot;
  if (snapshot.intent === 'leave') {
    return { ...snapshot, intent: 'idle', search: null, terminal: { target: 'idle', error: null }, retryCount: 0, lastError: null };
  }
  if (snapshot.intent === 'stop') {
    return { ...snapshot, search: null, terminal: { target: 'stopped', error: snapshot.terminal.error }, retryCount: 0, lastError: null };
  }
  return snapshot;
}

function beginRaidReconciliation(snapshot, now, effects = []) {
  const scheduled = withWake({ ...snapshot, raid: { ...snapshot.raid, state: 'unknown' } }, 'reconcileRaid', now, 0);
  return { snapshot: scheduled.snapshot, effects: [...effects, ...scheduled.effects] };
}

function beginQueueCleanup(snapshot, now, effects = []) {
  if (snapshot.operation) return { snapshot, effects };
  if (snapshot.queue.state === 'none') {
    if (snapshot.raid.state === 'unknown') return beginRaidReconciliation(snapshot, now, effects);
    return { snapshot: terminalize(snapshot), effects };
  }
  if (snapshot.queue.state === 'present') {
    const launched = withOperation({ ...snapshot, queue: { state: 'canceling' } }, 'cancelQueue', {}, now);
    return { snapshot: launched.snapshot, effects: [...effects, ...launched.effects] };
  }
  return withWake({ ...snapshot, queue: { state: 'unknown' } }, 'reconcileQueue', now, 0);
}

function matchRaid(snapshot, raid, now) {
  let next = {
    ...snapshot,
    raid: { state: 'matched', target: String(raid?.rpl_id ?? snapshot.raid.target ?? ''), value: clone(raid) },
    operation: null,
    wake: null,
    lastContactAt: now,
    terminal: { target: 'matched', error: null },
    retryCount: 0,
    lastError: null
  };
  const effects = [{ type: 'matched', raid: clone(raid) }];
  if (next.queue.state === 'present') {
    const cleanup = withOperation({ ...next, queue: { state: 'canceling' } }, 'cancelQueue', {}, now);
    next = cleanup.snapshot;
    effects.push(...cleanup.effects);
  }
  return { snapshot: next, effects };
}

function afterReadFailure(snapshot, event, config) {
  const message = errorText(event);
  const kind = snapshot.operation?.kind;
  const next = { ...snapshot, operation: null, lastError: message, retryCount: Number(snapshot.retryCount || 0) + 1 };
  if (snapshot.intent === 'stop' || snapshot.intent === 'leave') return beginQueueCleanup(next, config.now);
  const strategy = snapshot.search?.selection?.strategy;
  if (kind === 'scanLobbies' || (kind === 'pollQueue' && strategy === 'hybrid')) {
    return withWake(next, 'scan', config.now, config.scanIntervalMs ?? 1_000);
  }
  const wakeKind = strategy === 'hybrid' || strategy === 'fast' ? 'scan' : 'pollQueue';
  return withWake(next, wakeKind, config.now, Math.min(config.pollIntervalMs * 2, 60_000));
}

export function reduceAutoJoin(current, event, config) {
  const snapshot = clone(current);
  const now = config.now;
  const pollIntervalMs = config.pollIntervalMs;
  const scanIntervalMs = config.scanIntervalMs ?? 1_000;

  if (event.type === 'start') {
    if (snapshot.operation || snapshot.wake || snapshot.queue.state !== 'none' || snapshot.raid.state !== 'none' || snapshot.intent === 'search') {
      return { snapshot, effects: [{ type: 'reject', error: 'An Auto Join search is already active.' }] };
    }
    const strategy = event.selection?.strategy ?? 'queue';
    const base = {
      ...initialSnapshot(),
      intent: 'search',
      startedAt: now,
      search: { profile: clone(event.profile), selection: clone(event.selection), nextQueuePollAt: strategy === 'hybrid' ? at(now, pollIntervalMs) : null, attemptedRaids: {} },
      terminal: { target: 'searching', error: null },
      opSequence: snapshot.opSequence
    };
    if (strategy === 'fast') return withWake(base, 'scan', now, 0);
    return withOperation({ ...base, queue: { state: 'creating' } }, 'createQueue', { profile: event.profile, selection: event.selection }, now);
  }

  if (event.type === 'recover') {
    if (snapshot.operation || snapshot.wake || snapshot.queue.state !== 'none' || snapshot.raid.state !== 'none') return noChange(snapshot);
    const strategy = event.selection?.strategy ?? 'queue';
    if (strategy === 'fast') return reduceAutoJoin(snapshot, { type: 'start', profile: event.profile, selection: event.selection }, config);
    const base = {
      ...snapshot,
      intent: 'search',
      startedAt: now,
      search: { profile: clone(event.profile), selection: clone(event.selection), nextQueuePollAt: strategy === 'hybrid' ? at(now, pollIntervalMs) : null, attemptedRaids: {}, recovering: true },
      queue: { state: 'unknown' },
      terminal: { target: 'searching', error: null }
    };
    return withOperation(base, 'checkQueue', { profile: event.profile, selection: event.selection }, now);
  }

  if (event.type === 'stop') {
    if (snapshot.raid.state === 'matched') {
      const next = { ...snapshot, intent: snapshot.queue.state === 'none' ? snapshot.intent : 'stop' };
      return beginQueueCleanup(next, now);
    }
    let next = { ...snapshot, intent: 'stop', terminal: { target: 'stopped', error: null }, wake: null };
    if (next.operation?.kind === 'createQueue') {
      next.queue = { state: 'unknown' };
      return { snapshot: next, effects: [{ type: 'abort', opId: next.operation.opId }] };
    }
    if (next.operation?.kind === 'joinRaid') {
      next.raid = { ...next.raid, state: 'unknown' };
      return { snapshot: next, effects: [{ type: 'abort', opId: next.operation.opId }] };
    }
    if (next.operation && !WRITE_KINDS.has(next.operation.kind)) {
      const opId = next.operation.opId;
      next.operation = null;
      const cleanup = beginQueueCleanup(next, now, [{ type: 'abort', opId }]);
      return cleanup;
    }
    return beginQueueCleanup(next, now);
  }

  if (event.type === 'leave') {
    if (!snapshot.raid.value?.rpl_id || !['matched', 'unknown'].includes(snapshot.raid.state)) {
      return { snapshot, effects: [{ type: 'reject', error: 'There is no active raid to leave.' }] };
    }
    const next = { ...snapshot, intent: 'leave', terminal: { target: 'idle', error: null } };
    if (next.operation || next.queue.state !== 'none') return beginQueueCleanup(next, now);
    return withOperation({ ...next, raid: { ...next.raid, state: 'leaving' } }, 'leaveRaid', { raidId: next.raid.value.rpl_id }, now);
  }

  if (event.type === 'wake') {
    if (!snapshot.wake || snapshot.wake.kind !== event.kind || snapshot.operation) return noChange(snapshot);
    const next = { ...snapshot, wake: null };
    if (event.kind === 'scan') return withOperation(next, 'scanLobbies', { selection: next.search?.selection }, now);
    if (event.kind === 'pollQueue') return withOperation(next, 'pollQueue', { profile: next.search?.profile, selection: next.search?.selection }, now);
    if (event.kind === 'reconcileQueue') return withOperation(next, 'checkQueue', { profile: next.search?.profile, selection: next.search?.selection }, now, Number(next.retryCount || 0) + 1);
    if (event.kind === 'reconcileRaid') return withOperation(next, 'verifyMembership', { raidId: next.raid.target ?? next.raid.value?.rpl_id }, now, Number(next.retryCount || 0) + 1);
    return withWake(next, event.kind, now, Math.min(pollIntervalMs * Math.max(1, 2 ** Number(next.retryCount || 0)), 60_000));
  }

  if (event.type === 'operationRejected') {
    if (!snapshot.operation || snapshot.operation.opId !== event.opId) return noChange(snapshot);
    const kind = snapshot.operation.kind;
    const message = errorText(event);
    if (kind === 'createQueue') {
      if (event.definite) return { snapshot: { ...snapshot, queue: { state: 'none' }, operation: null, intent: 'idle', search: null, terminal: { target: 'error', error: message }, lastError: message }, effects: [] };
      return withWake({ ...snapshot, queue: { state: 'unknown' }, operation: null, intent: snapshot.intent === 'search' ? 'stop' : snapshot.intent, terminal: { target: snapshot.intent === 'stop' ? 'stopped' : 'error', error: message }, lastError: message }, 'reconcileQueue', now, pollIntervalMs);
    }
    if (kind === 'cancelQueue') {
      return withWake({ ...snapshot, queue: { state: 'unknown' }, operation: null, retryCount: Number(snapshot.retryCount || 0) + 1, lastError: message }, 'reconcileQueue', now, pollIntervalMs);
    }
    if (kind === 'joinRaid') {
      if (!event.definite) return withWake({ ...snapshot, raid: { ...snapshot.raid, state: 'unknown' }, operation: null, lastError: message }, 'reconcileRaid', now, pollIntervalMs);
      const next = { ...snapshot, raid: { state: 'none', target: null, value: null }, operation: null, lastError: message };
      if (next.search?.attemptedRaids && snapshot.raid.target) delete next.search.attemptedRaids[String(snapshot.raid.target)];
      if (next.intent === 'stop') return beginQueueCleanup(next, now);
      return withWake(next, 'scan', now, scanIntervalMs);
    }
    if (kind === 'leaveRaid') {
      if (!event.definite) return withWake({ ...snapshot, raid: { ...snapshot.raid, state: 'unknown' }, operation: null, lastError: message }, 'reconcileRaid', now, pollIntervalMs);
      return { snapshot: { ...snapshot, raid: { ...snapshot.raid, state: 'matched' }, operation: null, intent: 'idle', terminal: { target: 'matched', error: message }, lastError: message }, effects: [] };
    }
    if (kind === 'verifyMembership') {
      return withWake({
        ...snapshot,
        raid: { ...snapshot.raid, state: 'unknown' },
        operation: null,
        retryCount: Number(snapshot.retryCount || 0) + 1,
        lastError: message
      }, 'reconcileRaid', now, pollIntervalMs);
    }
    return afterReadFailure(snapshot, event, config);
  }

  if (event.type === 'operationSucceeded') {
    if (!snapshot.operation || snapshot.operation.opId !== event.opId) return noChange(snapshot);
    const kind = snapshot.operation.kind;
    const value = event.value;
    if (!isSuccess(value) && !(kind === 'leaveRaid' && isAlreadyGone(value))) {
      return reduceAutoJoin(snapshot, { type: 'operationRejected', opId: event.opId, error: value?.text || 'Raid NOW rejected the request.', definite: true }, config);
    }
    if (kind === 'createQueue') {
      const next = { ...snapshot, queue: { state: 'present' }, operation: null, lastContactAt: now };
      if (next.intent === 'stop') return beginQueueCleanup(next, now);
      return withWake(next, next.search?.selection?.strategy === 'hybrid' ? 'scan' : 'pollQueue', now, next.search?.selection?.strategy === 'hybrid' ? 0 : pollIntervalMs);
    }
    if (kind === 'scanLobbies') {
      const candidate = selectedRaid(snapshot, value, now);
      let next = { ...snapshot, operation: null, lastContactAt: now };
      if (!candidate) {
        if (next.intent === 'stop' || next.intent === 'leave') return beginQueueCleanup(next, now);
        const queueDue = Date.parse(next.search?.nextQueuePollAt || '');
        if (next.search?.selection?.strategy === 'hybrid' && Number.isFinite(queueDue) && queueDue <= Date.parse(now)) {
          next.search.nextQueuePollAt = at(now, pollIntervalMs);
          return withWake(next, 'pollQueue', now, 0);
        }
        return withWake(next, 'scan', now, scanIntervalMs);
      }
      if (Number(candidate.join || 0) === 1) return matchRaid(next, candidate, now);
      next.search.attemptedRaids[String(candidate.rpl_id)] = now;
      return withOperation({ ...next, raid: { state: 'joining', target: String(candidate.rpl_id), value: clone(candidate) } }, 'joinRaid', { raid: candidate, raidId: candidate.rpl_id, profile: next.search.profile }, now);
    }
    if (kind === 'joinRaid') {
      const raid = value?.data || snapshot.operation.input.raid || snapshot.raid.value;
      return matchRaid(snapshot, raid, now);
    }
    if (kind === 'verifyMembership') {
      if (value && Number(value.join || 0) === 1) {
        if (snapshot.intent === 'leave') {
          return withOperation({
            ...snapshot,
            raid: { state: 'leaving', target: String(value.rpl_id ?? snapshot.raid.target ?? ''), value: clone(value) },
            operation: null,
            lastContactAt: now,
            retryCount: 0,
            lastError: null
          }, 'leaveRaid', { raidId: value.rpl_id ?? snapshot.raid.target }, now);
        }
        return matchRaid(snapshot, value, now);
      }
      const confirmedAbsent = value == null || Object.hasOwn(value, 'join');
      if (!confirmedAbsent) {
        return withWake({
          ...snapshot,
          raid: { ...snapshot.raid, state: 'unknown' },
          operation: null,
          lastContactAt: now,
          retryCount: Number(snapshot.retryCount || 0) + 1,
          lastError: 'Raid membership could not be confirmed.'
        }, 'reconcileRaid', now, pollIntervalMs);
      }
      const next = {
        ...snapshot,
        raid: { state: 'none', target: null, value: null },
        operation: null,
        lastContactAt: now,
        retryCount: 0,
        lastError: null
      };
      if (next.intent === 'leave') return { snapshot: terminalize(next), effects: [] };
      if (next.intent === 'stop') return beginQueueCleanup(next, now);
      const strategy = next.search?.selection?.strategy;
      return withWake(next, strategy === 'fast' || strategy === 'hybrid' ? 'scan' : 'pollQueue', now, strategy === 'fast' || strategy === 'hybrid' ? scanIntervalMs : pollIntervalMs);
    }
    if (kind === 'pollQueue') {
      const next = { ...snapshot, operation: null, lastContactAt: now };
      if (Number(value?.rpllm_status) === 2 && value?.rpllm_rpl_id) {
        return matchRaid(
          { ...next, queue: { state: 'none' } },
          value.raid || { rpl_id: value.rpllm_rpl_id, rpl_pokemon: value.pokemon },
          now
        );
      }
      if (next.intent === 'stop' || next.intent === 'leave') return beginQueueCleanup(next, now);
      return withWake(next, next.search?.selection?.strategy === 'hybrid' ? 'scan' : 'pollQueue', now, next.search?.selection?.strategy === 'hybrid' ? scanIntervalMs : pollIntervalMs);
    }
    if (kind === 'cancelQueue') {
      return withOperation({ ...snapshot, queue: { state: 'unknown' }, operation: null, lastContactAt: now }, 'checkQueue', { profile: snapshot.search?.profile, selection: snapshot.search?.selection }, now);
    }
    if (kind === 'checkQueue') {
      const present = Boolean(value?.id);
      let next = { ...snapshot, operation: null, lastContactAt: now };
      if (present) {
        next.queue = { state: 'present' };
        if (next.intent === 'stop' || next.intent === 'leave' || next.raid.state === 'matched') return beginQueueCleanup(next, now);
        return withWake(next, next.search?.selection?.strategy === 'hybrid' ? 'scan' : 'pollQueue', now, next.search?.selection?.strategy === 'hybrid' ? 0 : pollIntervalMs);
      }
      next.queue = { state: 'none' };
      next.retryCount = 0;
      next.lastError = null;
      if (next.search?.recovering && next.intent === 'search') {
        next.search.recovering = false;
        return withOperation({ ...next, queue: { state: 'creating' } }, 'createQueue', { profile: next.search.profile, selection: next.search.selection }, now);
      }
      if (next.intent === 'leave' && next.raid.value?.rpl_id) return withOperation({ ...next, raid: { ...next.raid, state: 'leaving' } }, 'leaveRaid', { raidId: next.raid.value.rpl_id }, now);
      return beginQueueCleanup(next, now);
    }
    if (kind === 'leaveRaid') {
      const next = { ...snapshot, raid: { state: 'none', target: null, value: null }, operation: null, lastContactAt: now };
      return { snapshot: terminalize(next), effects: [] };
    }
  }

  return noChange(snapshot);
}

export function migrateSnapshot(saved, config) {
  const now = config.now;
  const pollIntervalMs = config.pollIntervalMs;
  if (!saved) return initialSnapshot();
  if (saved.schemaVersion === 2) {
    let next = { ...initialSnapshot(), ...clone(saved) };
    const op = next.operation;
    next.operation = null;
    if (op?.kind === 'createQueue' || op?.kind === 'cancelQueue') {
      next.queue = { state: 'unknown' };
      next.wake = { kind: 'reconcileQueue', dueAt: now };
    } else if (op?.kind === 'joinRaid') {
      next.raid = { state: 'unknown', target: String(op.input?.raidId ?? next.raid.target ?? ''), value: clone(op.input?.raid ?? next.raid.value ?? null) };
      next.wake = { kind: 'reconcileRaid', dueAt: at(now, pollIntervalMs) };
    } else if (op?.kind === 'leaveRaid') {
      next.raid = { ...next.raid, state: 'unknown' };
      next.wake = { kind: 'reconcileRaid', dueAt: at(now, pollIntervalMs) };
    } else if (op?.kind === 'verifyMembership') {
      next.raid = { ...next.raid, state: 'unknown' };
      next.wake = { kind: 'reconcileRaid', dueAt: now };
    } else if (op?.kind === 'checkQueue') {
      next.queue = { state: 'unknown' };
      next.wake = { kind: 'reconcileQueue', dueAt: now };
    } else if (op) {
      next.wake = { kind: next.search?.selection?.strategy === 'fast' || next.search?.selection?.strategy === 'hybrid' ? 'scan' : 'pollQueue', dueAt: now };
    }
    return next;
  }

  const next = initialSnapshot();
  next.startedAt = saved.startedAt ?? null;
  next.lastContactAt = saved.lastContactAt ?? null;
  next.search = saved.selection ? { profile: clone(saved.profile), selection: clone(saved.selection), nextQueuePollAt: null, attemptedRaids: {} } : null;
  next.retryCount = Number(saved.retryCount || 0);
  next.lastError = saved.lastError ?? saved.error ?? null;
  next.terminal = { target: saved.state === 'matched' ? 'matched' : saved.state === 'error' ? 'error' : saved.state === 'stopped' ? 'stopped' : 'idle', error: saved.error ?? saved.lastError ?? null };
  if (saved.raid?.rpl_id) next.raid = { state: 'matched', target: String(saved.raid.rpl_id), value: clone(saved.raid) };
  const active = new Set(['starting', 'searching', 'retrying', 'joining', 'stopping', 'reconciling']);
  if (saved.queueCancelPending || active.has(saved.state)) {
    next.intent = saved.state === 'matched' ? 'idle' : 'stop';
    next.queue = { state: 'unknown' };
    next.wake = { kind: 'reconcileQueue', dueAt: saved.nextRetryAt ?? now };
  }
  return next;
}
