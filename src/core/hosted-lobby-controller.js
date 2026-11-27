import { normalizeAdapterSettlement } from './adapter-outcome.js';

const SCHEMA_VERSION = 1;
const LOBBY_STATES = new Set(['none', 'creating', 'active', 'unknown']);
const OPERATION_KINDS = new Set(['create', 'start', 'kick', 'close']);

function initialSnapshot() {
  return {
    schemaVersion: SCHEMA_VERSION,
    lobby: { state: 'none', raidId: null, summary: null },
    started: false,
    operation: null,
    uncertain: null,
    lastError: null,
    opSequence: 0
  };
}

function lifecycleError(status, message, code = 'HOSTED_LOBBY_CONFLICT') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function boundedId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;
}

function safeSummary(input = {}) {
  return {
    pokemonId: String(input.pokemonId ?? '').slice(0, 256),
    startDate: String(input.startDate ?? '').slice(0, 64),
    maxUsers: Number(input.maxUsers) || 0,
    currentWeather: String(input.currentWeather ?? '').slice(0, 32),
    gymColor: String(input.gymColor ?? '').slice(0, 32),
    passType: String(input.passType ?? '').slice(0, 32)
  };
}

function normalizeSnapshot(saved) {
  if (!saved || saved.schemaVersion !== SCHEMA_VERSION || !LOBBY_STATES.has(saved.lobby?.state)) return initialSnapshot();
  const snapshot = initialSnapshot();
  snapshot.lobby = {
    state: saved.lobby.state,
    raidId: boundedId(saved.lobby.raidId) ? saved.lobby.raidId : null,
    summary: saved.lobby.summary && typeof saved.lobby.summary === 'object' ? safeSummary(saved.lobby.summary) : null
  };
  snapshot.started = saved.started === true || saved.started === 'unknown' ? saved.started : false;
  snapshot.opSequence = Number.isSafeInteger(saved.opSequence) && saved.opSequence >= 0 ? saved.opSequence : 0;
  if (saved.uncertain && OPERATION_KINDS.has(saved.uncertain.kind)) {
    snapshot.uncertain = {
      kind: saved.uncertain.kind,
      raidId: boundedId(saved.uncertain.raidId) ? saved.uncertain.raidId : null,
      guestId: boundedId(saved.uncertain.guestId) ? saved.uncertain.guestId : null,
      recordedAt: typeof saved.uncertain.recordedAt === 'string' ? saved.uncertain.recordedAt : new Date(0).toISOString()
    };
  }
  snapshot.lastError = typeof saved.lastError === 'string' ? saved.lastError.slice(0, 512) : null;
  if (saved.operation && OPERATION_KINDS.has(saved.operation.kind)) {
    snapshot.uncertain = {
      kind: saved.operation.kind,
      raidId: boundedId(saved.operation.raidId) ? saved.operation.raidId : snapshot.lobby.raidId,
      guestId: boundedId(saved.operation.guestId) ? saved.operation.guestId : null,
      recordedAt: typeof saved.operation.startedAt === 'string' ? saved.operation.startedAt : new Date(0).toISOString()
    };
    snapshot.lastError = 'En tidigare lobbyåtgärd avbröts innan resultatet kunde bekräftas.';
    if (saved.operation.kind === 'create') snapshot.lobby.state = 'unknown';
    if (saved.operation.kind === 'start') snapshot.started = 'unknown';
  }
  return snapshot;
}

function publicPlayer(player, canKick) {
  return {
    id: player.id,
    trainerName: player.trainerName,
    level: player.level,
    countryCode: player.countryCode,
    rating: player.rating,
    ready: player.ready,
    canKick
  };
}

export class HostedLobbyController {
  #adapter;
  #persist;
  #snapshot = initialSnapshot();
  #queue = Promise.resolve();
  #details = null;

  constructor({ adapter, persist } = {}) {
    if (!adapter || typeof persist !== 'function') throw new TypeError('Hosted lobby dependencies are required.');
    this.#adapter = adapter;
    this.#persist = persist;
  }

  async restore(saved) {
    this.#snapshot = normalizeSnapshot(saved);
    this.#snapshot.operation = null;
    await this.#persist(this.#snapshot);
    return this.status();
  }

  hasObligation() {
    return this.#snapshot.lobby.state !== 'none' || Boolean(this.#snapshot.operation) || Boolean(this.#snapshot.uncertain);
  }

  status() {
    const snapshot = this.#snapshot;
    const busy = Boolean(snapshot.operation);
    const uncertainKind = snapshot.uncertain?.kind ?? null;
    const raidKnown = boundedId(snapshot.lobby.raidId);
    const active = snapshot.lobby.state === 'active' && raidKnown;
    const canKick = active && snapshot.started !== true && !busy && !uncertainKind;
    return {
      state: snapshot.lobby.state,
      raidId: snapshot.lobby.raidId,
      summary: snapshot.lobby.summary ? structuredClone(snapshot.lobby.summary) : null,
      started: snapshot.started,
      operation: snapshot.operation?.kind ?? null,
      uncertainOperation: uncertainKind,
      error: snapshot.lastError,
      players: (this.#details?.players ?? []).map((player) => publicPlayer(player, canKick)),
      count: this.#details?.count ?? 0,
      readyCount: this.#details?.readyCount ?? 0,
      canCreate: snapshot.lobby.state === 'none' && !busy && !uncertainKind,
      canStart: active && snapshot.started === false && !busy && !uncertainKind,
      canClose: active && !busy && uncertainKind !== 'close',
      canAbandon: !busy && (snapshot.lobby.state === 'unknown' || Boolean(uncertainKind))
    };
  }

  refresh() {
    return this.#enqueue(async () => {
      const raidId = this.#snapshot.lobby.raidId;
      if (!boundedId(raidId)) return this.status();
      if (typeof this.#adapter.getHostedLobbyStatus !== 'function') throw lifecycleError(501, 'Lobby status is unavailable in this mode.', 'HOSTED_LOBBY_UNAVAILABLE');
      let details;
      try {
        details = await this.#adapter.getHostedLobbyStatus(raidId);
      } catch {
        this.#snapshot.lastError = 'Lobbyn kunde inte uppdateras.';
        await this.#persist(this.#snapshot);
        return this.status();
      }
      this.#details = structuredClone(details);
      if (details.raidDeleted === true) {
        this.#snapshot = initialSnapshot();
        this.#details = null;
        await this.#persist(this.#snapshot);
        return this.status();
      }
      const uncertain = this.#snapshot.uncertain;
      if (uncertain?.kind === 'kick') {
        this.#snapshot.uncertain = null;
        this.#snapshot.lastError = details.players.some((player) => player.id === uncertain.guestId)
          ? 'Kickningen bekräftades inte. Du kan försöka igen.'
          : null;
      } else if (uncertain?.kind === 'close') {
        this.#snapshot.uncertain = null;
        this.#snapshot.lastError = 'Stängningen bekräftades inte. Lobbyn är fortfarande öppen.';
      }
      if (this.#snapshot.lobby.state === 'unknown' && raidId) this.#snapshot.lobby.state = 'active';
      await this.#persist(this.#snapshot);
      return this.status();
    });
  }

  create({ profile, input }) {
    return this.#enqueue(async () => {
      if (this.hasObligation()) throw lifecycleError(409, 'En hostad lobby är redan aktiv eller osäker.');
      if (typeof this.#adapter.createHostedLobby !== 'function') throw lifecycleError(501, 'Lobby hosting is unavailable in this mode.', 'HOSTED_LOBBY_UNAVAILABLE');
      const operation = await this.#begin('create', { summary: safeSummary(input) });
      const outcome = await this.#settle(operation, () => this.#adapter.createHostedLobby(input, profile), { profile });
      if (outcome.ok) {
        if (!boundedId(outcome.value?.raidId)) return this.#definiteFailure(operation, 'CLI_PROTOCOL_ERROR', 'Lobbyn skapades inte med ett giltigt ID.');
        this.#snapshot.lobby = { state: 'active', raidId: outcome.value.raidId, summary: safeSummary(input) };
        this.#snapshot.started = false;
        this.#snapshot.operation = null;
        this.#snapshot.uncertain = null;
        this.#snapshot.lastError = null;
        await this.#persist(this.#snapshot);
        return this.status();
      }
      return this.#handleFailure(operation, outcome);
    });
  }

  start() {
    return this.#enqueue(async () => {
      const raidId = this.#requireActive('start');
      if (this.#snapshot.started !== false || this.#snapshot.uncertain) throw lifecycleError(409, 'Raidstarten är redan markerad eller osäker.');
      if (typeof this.#adapter.startHostedLobby !== 'function') throw lifecycleError(501, 'Lobby start is unavailable in this mode.', 'HOSTED_LOBBY_UNAVAILABLE');
      const operation = await this.#begin('start', { raidId });
      const outcome = await this.#settle(operation, () => this.#adapter.startHostedLobby(raidId));
      if (outcome.ok) {
        this.#snapshot.started = true;
        return this.#complete();
      }
      return this.#handleFailure(operation, outcome);
    });
  }

  kick(guestId) {
    return this.#enqueue(async () => {
      const raidId = this.#requireActive('kick');
      if (this.#snapshot.started === true || this.#snapshot.uncertain) throw lifecycleError(409, 'Gäster kan inte kickas i lobbyläget just nu.');
      if (!boundedId(guestId)) throw lifecycleError(400, 'Ett giltigt guest-id krävs.', 'INVALID_GUEST_ID');
      if (typeof this.#adapter.getHostedLobbyStatus !== 'function' || typeof this.#adapter.kickHostedGuest !== 'function') {
        throw lifecycleError(501, 'Lobby kick is unavailable in this mode.', 'HOSTED_LOBBY_UNAVAILABLE');
      }
      const details = await this.#adapter.getHostedLobbyStatus(raidId);
      if (details.raidDeleted === true) {
        this.#snapshot = initialSnapshot();
        this.#details = null;
        await this.#persist(this.#snapshot);
        throw lifecycleError(410, 'Lobbyn finns inte längre.', 'HOSTED_LOBBY_ENDED');
      }
      if (!details.players.some((player) => player.id === guestId)) throw lifecycleError(404, 'Gästen finns inte i lobbyn.', 'GUEST_NOT_FOUND');
      this.#details = structuredClone(details);
      const operation = await this.#begin('kick', { raidId, guestId });
      const outcome = await this.#settle(operation, () => this.#adapter.kickHostedGuest(raidId, guestId));
      if (outcome.ok) {
        this.#details.players = this.#details.players.filter((player) => player.id !== guestId);
        this.#details.count = Math.max(0, this.#details.count - 1);
        return this.#complete();
      }
      return this.#handleFailure(operation, outcome);
    });
  }

  close() {
    return this.#enqueue(async () => {
      const raidId = this.#requireActive('close', { allowUncertain: true });
      if (this.#snapshot.uncertain?.kind === 'close') throw lifecycleError(409, 'Stängningen har redan ett osäkert resultat.');
      if (typeof this.#adapter.closeHostedLobby !== 'function') throw lifecycleError(501, 'Lobby close is unavailable in this mode.', 'HOSTED_LOBBY_UNAVAILABLE');
      const operation = await this.#begin('close', { raidId });
      const outcome = await this.#settle(operation, () => this.#adapter.closeHostedLobby(raidId));
      if (outcome.ok) {
        this.#snapshot = initialSnapshot();
        this.#details = null;
        await this.#persist(this.#snapshot);
        return this.status();
      }
      return this.#handleFailure(operation, outcome);
    });
  }

  abandon() {
    return this.#enqueue(async () => {
      if (!this.status().canAbandon) throw lifecycleError(409, 'Det finns ingen osäker lobby att glömma lokalt.');
      this.#snapshot = initialSnapshot();
      this.#details = null;
      await this.#persist(this.#snapshot);
      return this.status();
    });
  }

  #requireActive(action, { allowUncertain = false } = {}) {
    if (this.#snapshot.lobby.state !== 'active' || !boundedId(this.#snapshot.lobby.raidId) || this.#snapshot.operation) {
      throw lifecycleError(409, `Lobbyn kan inte ${action}as i nuvarande läge.`);
    }
    if (!allowUncertain && this.#snapshot.uncertain) throw lifecycleError(409, 'En tidigare lobbyåtgärd har ett osäkert resultat.');
    return this.#snapshot.lobby.raidId;
  }

  async #begin(kind, { raidId = null, guestId = null, summary = null } = {}) {
    const opId = this.#snapshot.opSequence + 1;
    this.#snapshot.opSequence = opId;
    if (kind === 'create') this.#snapshot.lobby = { state: 'creating', raidId: null, summary };
    this.#snapshot.operation = { opId, kind, raidId, guestId, startedAt: new Date().toISOString() };
    this.#snapshot.lastError = null;
    await this.#persist(this.#snapshot);
    return { ...this.#snapshot.operation, input: {} };
  }

  async #settle(operation, effect, runtimeInput = {}) {
    operation.input = runtimeInput;
    const [settlement] = await Promise.allSettled([Promise.resolve().then(effect)]);
    const kind = {
      create: 'createHostedLobby',
      start: 'startHostedLobby',
      kick: 'kickHostedGuest',
      close: 'closeHostedLobby'
    }[operation.kind];
    return normalizeAdapterSettlement({ ...operation, kind }, settlement);
  }

  async #complete() {
    this.#snapshot.operation = null;
    this.#snapshot.uncertain = null;
    this.#snapshot.lastError = null;
    await this.#persist(this.#snapshot);
    return this.status();
  }

  async #definiteFailure(operation, code, message) {
    this.#snapshot.operation = null;
    if (operation.kind === 'create') this.#snapshot.lobby = { state: 'none', raidId: null, summary: null };
    this.#snapshot.lastError = message;
    await this.#persist(this.#snapshot);
    throw lifecycleError(409, message, code);
  }

  async #handleFailure(operation, outcome) {
    this.#snapshot.operation = null;
    this.#snapshot.lastError = outcome.message;
    if (outcome.certainty === 'unknown') {
      this.#snapshot.uncertain = {
        kind: operation.kind,
        raidId: operation.raidId,
        guestId: operation.guestId,
        recordedAt: new Date().toISOString()
      };
      if (operation.kind === 'create') this.#snapshot.lobby.state = 'unknown';
      if (operation.kind === 'start') this.#snapshot.started = 'unknown';
      await this.#persist(this.#snapshot);
      return this.status();
    }
    if (operation.kind === 'create') this.#snapshot.lobby = { state: 'none', raidId: null, summary: null };
    await this.#persist(this.#snapshot);
    const status = outcome.code === 'WRITES_DISABLED' ? 501 : 409;
    throw lifecycleError(status, outcome.message, outcome.code ?? 'HOSTED_LOBBY_REJECTED');
  }

  #enqueue(operation) {
    const task = this.#queue.then(operation, operation);
    this.#queue = task.catch(() => {});
    return task;
  }
}

export function hasHostedLobbyObligation(saved) {
  const snapshot = normalizeSnapshot(saved);
  return snapshot.lobby.state !== 'none' || Boolean(snapshot.operation) || Boolean(snapshot.uncertain);
}
