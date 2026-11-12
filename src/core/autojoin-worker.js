import { EventEmitter } from 'node:events';
import { initialSnapshot, migrateSnapshot, reduceAutoJoin } from './autojoin-state-machine.js';

const defaultClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (handle) => globalThis.clearTimeout(handle)
};

function clone(value) {
  return structuredClone(value);
}

function message(error) {
  return error?.message || String(error);
}

function runDirect(operation, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Operation aborted.'));
  return Promise.resolve().then(operation);
}

export class AutoJoinUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.status = 501;
    this.code = 'AUTOJOIN_UNAVAILABLE';
  }
}

export class AutoJoinWorker extends EventEmitter {
  #adapter;
  #persist;
  #clock;
  #runOperation;
  #pollIntervalMs;
  #scanIntervalMs;
  #snapshot = initialSnapshot();
  #mailbox = Promise.resolve();
  #timer = null;
  #activeOperation = null;
  #running = true;
  #leavePromise = null;
  #recoverPromise = null;
  #waiters = new Set();

  constructor({ adapter, pollIntervalMs = 15_000, scanIntervalMs = 1_000, persist = async () => {}, clock = defaultClock, runOperation = runDirect }) {
    super();
    this.#adapter = adapter;
    this.#persist = persist;
    this.#clock = clock;
    this.#runOperation = runOperation;
    this.#pollIntervalMs = pollIntervalMs;
    this.#scanIntervalMs = scanIntervalMs;
  }

  status() {
    const snapshot = this.#snapshot;
    const matched = snapshot.raid.state === 'matched' || snapshot.raid.state === 'leaving' ||
      (snapshot.raid.state === 'unknown' && snapshot.raid.value && snapshot.intent === 'leave');
    let state = snapshot.terminal.target ?? 'idle';
    if (matched) state = 'matched';
    else if (snapshot.intent === 'stop' && snapshot.raid.state === 'unknown') state = 'stopping';
    else if (snapshot.operation?.kind === 'joinRaid') state = 'joining';
    else if (snapshot.intent === 'search') {
      if (snapshot.operation?.kind === 'createQueue') state = 'starting';
      else state = snapshot.retryCount > 0 || snapshot.lastError ? 'retrying' : 'searching';
    } else if (snapshot.queue.state !== 'none' || snapshot.wake?.kind === 'reconcileQueue') state = 'reconciling';

    const queueCancelPending = snapshot.queue.state !== 'none' &&
      (snapshot.intent === 'stop' || snapshot.intent === 'leave' || matched || snapshot.terminal.target === 'error');
    const nextAt = snapshot.wake?.dueAt ?? null;
    return {
      state,
      startedAt: snapshot.startedAt,
      lastContactAt: snapshot.lastContactAt,
      nextPollAt: snapshot.wake && !snapshot.wake.kind.startsWith('reconcile') ? nextAt : null,
      error: snapshot.terminal.error ?? (['retrying', 'reconciling', 'stopping'].includes(state) ? snapshot.lastError : null),
      profile: matched ? null : clone(snapshot.search?.profile ?? null),
      selection: clone(snapshot.search?.selection ?? null),
      raid: clone(snapshot.raid.value ?? null),
      queueCancelPending,
      retryCount: Number(snapshot.retryCount || 0),
      lastError: snapshot.lastError,
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

  leaveRaid() {
    if (this.#leavePromise) return this.#leavePromise;
    const leaving = this.#dispatch({ type: 'leave' })
      .then(() => this.#waitUntil((status) => status.state === 'idle' || (this.#snapshot.intent !== 'leave' && Boolean(this.#snapshot.terminal.error))))
      .then((status) => {
        if (status.error) throw new Error(status.error);
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
      scanIntervalMs: this.#scanIntervalMs
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
    if (rejection) throw new Error(rejection.error);
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
    this.#activeOperation = { opId, controller };
    this.#runOperation(() => this.#executeAdapter(operation, controller.signal), { signal: controller.signal })
      .then((value) => {
        if (!this.#running) return;
        return this.#dispatch({ type: 'operationSucceeded', opId, value });
      })
      .catch((error) => {
        if (!this.#running) return;
        return this.#dispatch({
          type: 'operationRejected',
          opId,
          error: message(error),
          definite: !['createQueue', 'cancelQueue', 'joinRaid', 'leaveRaid'].includes(operation.kind)
        });
      })
      .catch((error) => this.emit('workerError', error))
      .finally(() => {
        if (this.#activeOperation?.controller === controller) this.#activeOperation = null;
        if (this.#running && this.#snapshot.operation && this.#snapshot.operation.opId !== opId) {
          this.#launchAdapter(this.#snapshot.operation.opId);
        }
      });
  }

  async #executeAdapter(operation, signal) {
    const input = operation.input ?? {};
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
        if (!this.#adapter.findRaid) throw new Error('Raid reconciliation requires adapter.findRaid().');
        if (!input.raidId) throw new Error('Raid reconciliation requires a target raid ID.');
        return this.#adapter.findRaid(input.raidId, { signal });
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
