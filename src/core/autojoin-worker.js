import { EventEmitter } from 'node:events';
import { initialSnapshot, migrateSnapshot, reduceAutoJoin } from './autojoin-state-machine.js';
import {
  AdapterCapabilityError,
  diagnosticFieldsFromOutcome,
  isWriteOperation,
  normalizeAdapterSettlement,
  reducerEventFromOutcome,
  sanitizeDiagnosticEvent
} from './adapter-outcome.js';

const defaultClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => {
    const handle = globalThis.setTimeout(callback, delay);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => globalThis.clearTimeout(handle)
};

function clone(value) {
  return structuredClone(value);
}

function isExplicitTrue(value) {
  return value === true || value === 1 || value === '1';
}

function isExactRaidMembership(value) {
  return value === 1 || value === '1';
}

function isExplicitZero(value) {
  return value === 0 || value === '0';
}

async function probeRaidMembership(adapter, raidId, signal) {
  const exactPromise = Promise.resolve().then(() => {
    if (typeof adapter.findRaid !== 'function') throw new Error('Raid reconciliation requires adapter.findRaid().');
    return adapter.findRaid(raidId, { signal });
  });
  const playersPromise = Promise.resolve().then(() => {
    if (typeof adapter.listRaidPlayers !== 'function') throw new Error('Raid reconciliation requires adapter.listRaidPlayers().');
    return adapter.listRaidPlayers(raidId, { signal });
  });
  const [exactResult, playersResult] = await Promise.allSettled([exactPromise, playersPromise]);
  const observedRaid = exactResult.status === 'fulfilled' && exactResult.value && typeof exactResult.value === 'object'
    ? exactResult.value
    : null;
  const observedRaidId = observedRaid?.rpl_id;
  const raid = observedRaidId !== undefined && observedRaidId !== null && String(observedRaidId).trim() !== ''
    && String(observedRaidId) === String(raidId)
    ? observedRaid
    : null;
  const players = playersResult.status === 'fulfilled' && playersResult.value && typeof playersResult.value === 'object'
    ? playersResult.value
    : null;

  if (isExplicitTrue(players?.raidDeleted) || isExplicitTrue(raid?.rpl_deleted) || isExplicitTrue(raid?.deleted)) {
    return { membership: 'raid-ended', raid };
  }
  if (isExactRaidMembership(raid?.join) || isExactRaidMembership(raid?.my) || players?.players?.some((player) => player?.isMe === true)) {
    return { membership: 'present', raid };
  }
  if (isExplicitZero(raid?.join)) return { membership: 'absent', raid };
  return { membership: 'unknown', raid };
}

export function leaveRaidRejection(error) {
  const operation = { opId: 'classification', kind: 'leaveRaid', input: {} };
  const settlement = error && typeof error === 'object' && !Array.isArray(error) && error.status === 'error'
    ? { status: 'fulfilled', value: error }
    : { status: 'rejected', reason: error };
  return normalizeAdapterSettlement(operation, settlement).reason === 'raidAlreadyStarted' ? 'started' : null;
}

function runDirect(operation, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Operation aborted.'));
  return Promise.resolve().then(operation);
}

const ADAPTER_CAPABILITIES = {
  createQueue: ['createMatching'],
  pollQueue: ['pollMatching'],
  joinRaid: ['joinRaidFast'],
  cancelQueue: ['cancelMatching'],
  checkQueue: ['checkMatching'],
  leaveRaid: ['leaveRaid'],
  verifyMembership: ['findRaid', 'listRaidPlayers'],
  verifyMatched: ['findRaid', 'listRaidPlayers']
};

function unavailableMessage(kind, methods) {
  return `Auto Join ${kind} is unavailable because the adapter does not support ${methods.join(' and ')}.`;
}

export class AutoJoinUnavailableError extends AdapterCapabilityError {
  constructor(message) {
    super(message);
    this.name = 'AutoJoinUnavailableError';
  }
}

export class AutoJoinConflictError extends Error {
  constructor(message) {
    super(message);
    this.status = 409;
    this.code = 'AUTOJOIN_CONFLICT';
  }
}

export class AutoJoinWorker extends EventEmitter {
  #adapter;
  #persist;
  #clock;
  #runOperation;
  #diagnostics;
  #pollIntervalMs;
  #scanIntervalMs;
  #matchedValidationIntervalMs;
  #snapshot = initialSnapshot();
  #mailbox = Promise.resolve();
  #timer = null;
  #activeOperation = null;
  #running = true;
  #leavePromise = null;
  #recoverPromise = null;
  #waiters = new Set();

  constructor({ adapter, pollIntervalMs = 15_000, scanIntervalMs = 1_000, matchedValidationIntervalMs = 60_000, persist = async () => {}, clock = defaultClock, runOperation = runDirect, diagnostics = null }) {
    super();
    this.#adapter = adapter;
    this.#persist = persist;
    this.#clock = clock;
    this.#runOperation = runOperation;
    this.#diagnostics = typeof diagnostics === 'function' ? diagnostics : null;
    this.#pollIntervalMs = pollIntervalMs;
    this.#scanIntervalMs = scanIntervalMs;
    this.#matchedValidationIntervalMs = matchedValidationIntervalMs;
  }

  status() {
    const snapshot = this.#snapshot;
    const matched = snapshot.raid.state === 'matched' || snapshot.raid.state === 'leaving';
    let state = snapshot.terminal.target ?? 'idle';
    if (matched) state = 'matched';
    else if (snapshot.raid.state === 'unknown' && snapshot.intent === 'stop') state = 'stopping';
    else if (snapshot.raid.state === 'unknown') state = 'reconciling';
    else if (snapshot.operation?.kind === 'joinRaid') state = 'joining';
    else if (snapshot.intent === 'search') {
      if (snapshot.operation?.kind === 'createQueue') state = 'starting';
      else state = snapshot.retryCount > 0 || snapshot.lastError ? 'retrying' : 'searching';
    } else if ((snapshot.queue.state !== 'none' || snapshot.wake?.kind === 'reconcileQueue') && snapshot.terminal.code !== 'AUTOJOIN_UNAVAILABLE') state = 'reconciling';

    const queueCancelPending = snapshot.queue.state !== 'none' &&
      (snapshot.intent === 'stop' || snapshot.intent === 'leave' || matched || snapshot.terminal.target === 'error');
    let raid = clone(snapshot.raid.value ?? null);
    if (snapshot.raid.target) {
      if (raid) raid.rpl_id = String(snapshot.raid.target);
      else raid = { rpl_id: String(snapshot.raid.target) };
    }
    const canRequestLeave = ['matched', 'unknown'].includes(snapshot.raid.state) && Boolean(raid?.rpl_id);
    const canAbandonLocal = snapshot.intent === 'stop' &&
      snapshot.queue.state === 'unknown' &&
      snapshot.raid.state === 'none' &&
      !snapshot.raid.target &&
      !snapshot.raid.value &&
      Number(snapshot.retryCount || 0) >= 3 &&
      (!snapshot.operation || snapshot.operation.kind === 'checkQueue');
    const nextAt = snapshot.wake?.dueAt ?? null;
    return {
      state,
      startedAt: snapshot.startedAt,
      lastContactAt: snapshot.lastContactAt,
      nextPollAt: snapshot.wake && !snapshot.wake.kind.startsWith('reconcile') ? nextAt : null,
      error: snapshot.terminal.error ?? (['retrying', 'reconciling', 'stopping'].includes(state) ? snapshot.lastError : null),
      profile: matched ? null : clone(snapshot.search?.profile ?? null),
      selection: clone(snapshot.search?.selection ?? null),
      raid,
      raidMembership: snapshot.raid.state,
      canRequestLeave,
      queueCancelPending,
      canAbandonLocal,
      directScanDisabled: Boolean(snapshot.search?.directScanDisabled),
      retryCount: Number(snapshot.retryCount || 0),
      lastError: snapshot.lastError,
      workflowNotice: clone(snapshot.workflowNotice ?? null),
      nextRetryAt: snapshot.wake?.kind.startsWith('reconcile') ? nextAt : null
    };
  }

  start({ profile, selection }) {
    this.#assertCapabilities(selection);
    return this.#dispatch({ type: 'start', profile, selection }).then(() => this.status());
  }

  recover(context) {
    this.#assertCapabilities(context.selection);
    if (this.#recoverPromise) return this.#recoverPromise;
    const recovery = this.#dispatch({ type: 'recover', ...context }).then(() => true);
    const tracked = recovery.finally(() => {
      if (this.#recoverPromise === tracked) this.#recoverPromise = null;
    });
    this.#recoverPromise = tracked;
    return tracked;
  }

  async restore(saved) {
    if (!saved) return false;
    const restored = migrateSnapshot(saved, this.#config());
    await this.#enqueue(async () => {
      if (!this.#running) this.#running = true;
      await this.#persist(clone(restored));
      this.#snapshot = restored;
      this.emit('state', this.status());
      this.#resumeDurableWork();
    });
    return true;
  }

  stop() {
    return this.#dispatch({ type: 'stop' }).then(() => this.status());
  }

  abandonLocal() {
    return this.#dispatch({ type: 'abandonLocal' }).then(() => this.status());
  }

  matchedRaidEnded(raidId) {
    return this.#dispatch({ type: 'matchedRaidEnded', raidId }).then(() => this.status());
  }

  leaveRaid() {
    if (this.#leavePromise) return this.#leavePromise;
    const leaving = this.#dispatch({ type: 'leave' })
      .then(() => this.#waitUntil((status) => this.#snapshot.raid.state === 'none' || (this.#snapshot.intent !== 'leave' && Boolean(this.#snapshot.terminal.error))))
      .then((status) => {
        if (status.error) {
          if (this.#snapshot.terminal?.status === 501 && this.#snapshot.terminal?.code === 'AUTOJOIN_UNAVAILABLE') {
            throw new AutoJoinUnavailableError(status.error);
          }
          throw new Error(status.error);
        }
        return status;
      });
    const tracked = leaving.finally(() => {
      if (this.#leavePromise === tracked) this.#leavePromise = null;
    });
    this.#leavePromise = tracked;
    return tracked;
  }

  shutdown() {
    this.#running = false;
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
    const error = new Error('Auto Join worker shut down.');
    this.#activeOperation?.controller.abort(error);
    this.#activeOperation = null;
    for (const waiter of [...this.#waiters]) waiter.reject(error);
  }

  #config() {
    return {
      now: new Date(this.#clock.now()).toISOString(),
      pollIntervalMs: this.#pollIntervalMs,
      scanIntervalMs: this.#scanIntervalMs,
      matchedValidationIntervalMs: this.#matchedValidationIntervalMs
    };
  }

  #dispatch(event) {
    if (!this.#running) return Promise.reject(new Error('Auto Join worker is shut down.'));
    return this.#enqueue(() => this.#process(event));
  }

  #enqueue(task) {
    const result = this.#mailbox.then(task);
    this.#mailbox = result.catch(() => {});
    return result;
  }

  async #process(event) {
    const transition = reduceAutoJoin(this.#snapshot, event, this.#config());
    const rejection = transition.effects.find((effect) => effect.type === 'reject');
    if (rejection) throw new AutoJoinConflictError(rejection.error);
    await this.#persist(clone(transition.snapshot));
    this.#snapshot = transition.snapshot;
    this.emit('state', this.status());
    for (const effect of transition.effects) {
      if (effect.type === 'matched') this.emit('matched', clone(effect.raid));
      else if (effect.type === 'adapter') this.#launchAdapter(effect.opId);
      else if (effect.type === 'timer') this.#armTimer(effect);
      else if (effect.type === 'abort' && this.#activeOperation?.opId === effect.opId) {
        this.#activeOperation.controller.abort(new Error('Auto Join worker stopped.'));
      }
    }
    return this.status();
  }

  #resumeDurableWork() {
    if (!this.#running) return;
    if (this.#snapshot.operation) this.#launchAdapter(this.#snapshot.operation.opId);
    else if (this.#snapshot.wake) this.#armTimer(this.#snapshot.wake);
  }

  #armTimer({ kind, dueAt }) {
    if (!this.#running) return;
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    const delay = Math.max(0, Date.parse(dueAt) - this.#clock.now());
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = null;
      this.#dispatch({ type: 'wake', kind }).catch((error) => this.emit('workerError', error));
    }, delay);
  }

  #launchAdapter(opId) {
    if (!this.#running || this.#activeOperation || this.#snapshot.operation?.opId !== opId) return;
    const operation = clone(this.#snapshot.operation);
    const controller = new AbortController();
    const startedAt = this.#clock.now();
    this.#activeOperation = { opId, controller };
    this.#runOperation(() => this.#executeAdapter(operation, controller.signal), { signal: controller.signal })
      .then(
        (value) => this.#consumeAdapterSettlement(operation, { status: 'fulfilled', value }, startedAt),
        (reason) => this.#consumeAdapterSettlement(operation, { status: 'rejected', reason }, startedAt)
      )
      .catch((error) => this.emit('workerError', error))
      .finally(() => {
        if (this.#activeOperation?.controller === controller) this.#activeOperation = null;
        if (this.#running && this.#snapshot.operation && this.#snapshot.operation.opId !== opId) {
          this.#launchAdapter(this.#snapshot.operation.opId);
        }
      });
  }

  #consumeAdapterSettlement(operation, settlement, startedAt) {
    if (!this.#running) return;
    const outcome = normalizeAdapterSettlement(operation, settlement);
    if (isWriteOperation(operation.kind)) this.#recordDiagnostic(operation, outcome, startedAt);
    return this.#dispatch(reducerEventFromOutcome(operation, outcome));
  }

  #recordDiagnostic(operation, outcome, startedAt) {
    if (!this.#diagnostics) return;
    const event = {
      event: 'raidnow_operation',
      operation: operation.kind,
      at: new Date(this.#clock.now()).toISOString(),
      durationMs: Math.max(0, this.#clock.now() - startedAt),
      ...diagnosticFieldsFromOutcome(outcome)
    };
    if (['joinRaid', 'leaveRaid', 'verifyMembership', 'verifyMatched'].includes(operation.kind)) {
      event.raidId = String(operation.input?.raidId ?? '');
    }
    try {
      this.#diagnostics(sanitizeDiagnosticEvent(event));
    } catch {
      // Diagnostics must never affect the workflow.
    }
  }

  async #executeAdapter(operation, signal) {
    const input = operation.input ?? {};
    const required = ADAPTER_CAPABILITIES[operation.kind] ?? [];
    const missing = required.filter((method) => typeof this.#adapter[method] !== 'function');
    if (operation.kind === 'scanLobbies') {
      if (typeof this.#adapter.listRaidsForSelection !== 'function' && typeof this.#adapter.listRaids !== 'function') {
        throw new AutoJoinUnavailableError(unavailableMessage(operation.kind, ['listRaidsForSelection or listRaids']));
      }
    } else if (missing.length) {
      throw new AutoJoinUnavailableError(unavailableMessage(operation.kind, missing));
    }
    switch (operation.kind) {
      case 'createQueue':
        return this.#adapter.createMatching({ profile: input.profile, selection: input.selection }, { signal });
      case 'pollQueue': {
        const response = await this.#adapter.pollMatching({ profile: input.profile, selection: input.selection }, { signal });
        if (Number(response?.rpllm_status) === 2 && response?.rpllm_rpl_id && this.#adapter.findRaid) {
          const raid = await this.#adapter.findRaid(response.rpllm_rpl_id, { signal });
          return { ...response, raid };
        }
        return response;
      }
      case 'scanLobbies':
        return this.#adapter.listRaidsForSelection
          ? this.#adapter.listRaidsForSelection(input.selection, { signal })
          : this.#adapter.listRaids({ page: 1, rank: 0 }, { signal });
      case 'joinRaid':
        return this.#adapter.joinRaidFast(input.raidId, input.profile, { signal });
      case 'cancelQueue':
        return this.#adapter.cancelMatching({ signal });
      case 'checkQueue':
        return this.#adapter.checkMatching({ profile: input.profile, selection: input.selection }, { signal });
      case 'leaveRaid':
        return this.#adapter.leaveRaid(input.raidId, { signal });
      case 'verifyMembership':
      case 'verifyMatched':
        if (!input.raidId) throw new Error('Raid reconciliation requires a target raid ID.');
        return probeRaidMembership(this.#adapter, input.raidId, signal);
      default:
        throw new Error(`Unknown Auto Join operation: ${operation.kind}`);
    }
  }

  #waitUntil(predicate) {
    if (!this.#running) return Promise.reject(new Error('Auto Join worker is shut down.'));
    const current = this.status();
    if (predicate(current)) return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      const waiter = {
        reject: (error) => {
          this.off('state', listener);
          this.#waiters.delete(waiter);
          reject(error);
        }
      };
      const listener = (status) => {
        if (!predicate(status)) return;
        this.off('state', listener);
        this.#waiters.delete(waiter);
        resolve(status);
      };
      this.#waiters.add(waiter);
      this.on('state', listener);
    });
  }

  #assertCapabilities(selection) {
    if (selection?.strategy !== 'fast' && selection?.strategy !== 'hybrid') return;
    if ((!this.#adapter.listRaidsForSelection && !this.#adapter.listRaids) || !this.#adapter.joinRaidFast) {
      const label = selection.strategy === 'fast' ? 'Fast' : 'Hybrid';
      throw new AutoJoinUnavailableError(`${label} raid search is unavailable.`);
    }
  }
}
