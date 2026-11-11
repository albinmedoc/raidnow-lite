import { EventEmitter } from 'node:events';

const ACTIVE_STATES = new Set(['starting', 'searching', 'retrying']);

export class AutoJoinWorker extends EventEmitter {
  #adapter;
  #pollIntervalMs;
  #timer = null;
  #generation = 0;
  #fastAttempts = new Map();
  #nextQueuePollAt = 0;
  #state = {
    state: 'idle',
    startedAt: null,
    lastContactAt: null,
    nextPollAt: null,
    error: null,
    profile: null,
    selection: null,
    raid: null
  };

  constructor({ adapter, pollIntervalMs = 15_000 }) {
    super();
    this.#adapter = adapter;
    this.#pollIntervalMs = pollIntervalMs;
  }

  status() {
    return structuredClone(this.#state);
  }

  restore(saved) {
    if (saved?.state !== 'matched' || !saved.raid?.rpl_id) return false;
    this.#state = {
      ...this.#state,
      ...structuredClone(saved),
      state: 'matched',
      nextPollAt: null,
      error: null
    };
    return true;
  }

  async start({ profile, selection }) {
    if (ACTIVE_STATES.has(this.#state.state)) throw new Error('An Auto Join search is already active.');
    this.#clearTimer();
    const generation = ++this.#generation;
    this.#setState({ state: 'starting', startedAt: new Date().toISOString(), profile, selection, raid: null, error: null });

    if (selection?.strategy === 'fast') {
      if ((!this.#adapter.listRaidsForSelection && !this.#adapter.listRaids) || !this.#adapter.joinRaidFast) throw new Error('Fast raid search is unavailable.');
      this.#fastAttempts.clear();
      this.#setState({ state: 'searching', lastContactAt: new Date().toISOString() });
      await this.#pollFast(generation);
      return this.status();
    }

    const response = await this.#adapter.createMatching({ profile, selection });
    if (response?.status !== 'success') {
      const message = response?.text || 'Raid NOW rejected the Auto Join request.';
      this.#setState({ state: 'error', error: message, nextPollAt: null });
      throw new Error(message);
    }

    this.#setState({ state: 'searching', lastContactAt: new Date().toISOString() });
    if (selection?.strategy === 'hybrid') {
      if ((!this.#adapter.listRaidsForSelection && !this.#adapter.listRaids) || !this.#adapter.joinRaidFast) throw new Error('Hybrid raid search is unavailable.');
      this.#fastAttempts.clear();
      this.#nextQueuePollAt = Date.now() + this.#pollIntervalMs;
      await this.#pollHybrid(generation);
      return this.status();
    }
    this.#schedulePoll(generation);
    return this.status();
  }

  async recover({ profile, selection }) {
    if (ACTIVE_STATES.has(this.#state.state)) return true;
    if (selection?.strategy === 'fast') {
      this.#clearTimer();
      const generation = ++this.#generation;
      this.#setState({
        state: 'searching',
        startedAt: new Date().toISOString(),
        lastContactAt: null,
        profile,
        selection,
        raid: null,
        error: null
      });
      this.#schedulePoll(generation, 0);
      return true;
    }
    if (selection?.strategy === 'hybrid') {
      let response = await this.#adapter.checkMatching({ profile, selection });
      if (!response?.id) {
        response = await this.#adapter.createMatching({ profile, selection });
        if (response?.status !== 'success') return false;
      }
      this.#clearTimer();
      const generation = ++this.#generation;
      this.#fastAttempts.clear();
      this.#nextQueuePollAt = Date.now() + this.#pollIntervalMs;
      this.#setState({
        state: 'searching',
        startedAt: new Date().toISOString(),
        lastContactAt: new Date().toISOString(),
        profile,
        selection,
        raid: null,
        error: null
      });
      this.#schedulePoll(generation, 0);
      return true;
    }
    const response = await this.#adapter.checkMatching({ profile, selection });
    if (!response?.id) return false;

    this.#clearTimer();
    const generation = ++this.#generation;
    this.#setState({
      state: 'searching',
      startedAt: new Date().toISOString(),
      lastContactAt: new Date().toISOString(),
      profile,
      selection,
      raid: null,
      error: null
    });
    this.#schedulePoll(generation);
    return true;
  }

  async stop() {
    const wasActive = ACTIVE_STATES.has(this.#state.state);
    ++this.#generation;
    this.#clearTimer();
    if (wasActive && this.#state.selection?.strategy !== 'fast' && this.#adapter.cancelMatching) await this.#adapter.cancelMatching();
    this.#setState({ state: 'stopped', nextPollAt: null, profile: null, selection: null });
    return this.status();
  }

  shutdown() {
    ++this.#generation;
    this.#clearTimer();
  }

  async leaveRaid() {
    const id = this.#state.raid?.rpl_id;
    if (this.#state.state !== 'matched' || !id) throw new Error('There is no active raid to leave.');
    if (!this.#adapter.leaveRaid) throw new Error('Leaving a raid is unavailable.');
    const response = await this.#adapter.leaveRaid(id);
    if (response?.status && response.status !== 'success') throw new Error(response.text || 'Raid NOW rejected the leave request.');
    this.#setState({
      state: 'idle',
      startedAt: null,
      lastContactAt: new Date().toISOString(),
      nextPollAt: null,
      error: null,
      profile: null,
      selection: null,
      raid: null
    });
    return this.status();
  }

  #schedulePoll(generation, delay = this.#pollIntervalMs) {
    if (generation !== this.#generation || !ACTIVE_STATES.has(this.#state.state)) return;
    const nextPollAt = new Date(Date.now() + delay).toISOString();
    this.#setState({ nextPollAt });
    this.#timer = setTimeout(() => this.#poll(generation), delay);
  }

  async #poll(generation) {
    if (generation !== this.#generation || !ACTIVE_STATES.has(this.#state.state)) return;
    this.#timer = null;
    if (this.#state.selection?.strategy === 'fast') return this.#pollFast(generation);
    if (this.#state.selection?.strategy === 'hybrid') return this.#pollHybrid(generation);
    try {
      const response = await this.#adapter.pollMatching({
        profile: this.#state.profile,
        selection: this.#state.selection
      });
      if (generation !== this.#generation) return;
      this.#setState({ state: 'searching', lastContactAt: new Date().toISOString(), error: null });

      if (response?.status === 'success' && Number(response.rpllm_status) === 2 && response.rpllm_rpl_id) {
        const raid = this.#adapter.findRaid
          ? await this.#adapter.findRaid(response.rpllm_rpl_id)
          : { rpl_id: response.rpllm_rpl_id, rpl_pokemon: response.pokemon };
        return this.#finishMatch(raid, false);
      }
      this.#schedulePoll(generation);
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#setState({ state: 'retrying', error: error.message || String(error) });
      this.#schedulePoll(generation, Math.min(this.#pollIntervalMs * 2, 60_000));
    }
  }

  async #pollFast(generation) {
    if (generation !== this.#generation || !ACTIVE_STATES.has(this.#state.state)) return;
    this.#timer = null;
    try {
      const raid = await this.#scanFastLobby(generation);
      if (generation !== this.#generation) return;
      this.#setState({ state: 'searching', lastContactAt: new Date().toISOString(), error: null });
      if (raid) return this.#finishMatch(raid, false);
      this.#schedulePoll(generation, Math.min(this.#pollIntervalMs, 1_000));
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#setState({ state: 'retrying', error: error.message || String(error) });
      this.#schedulePoll(generation, Math.min(Math.max(this.#pollIntervalMs, 1_000), 5_000));
    }
  }

  async #pollHybrid(generation) {
    if (generation !== this.#generation || !ACTIVE_STATES.has(this.#state.state)) return;
    this.#timer = null;
    let lastError = null;

    try {
      const directRaid = await this.#scanFastLobby(generation);
      if (generation !== this.#generation) return;
      if (directRaid) return this.#finishMatch(directRaid, true);
    } catch (error) {
      lastError = error;
    }

    if (Date.now() >= this.#nextQueuePollAt) {
      this.#nextQueuePollAt = Date.now() + this.#pollIntervalMs;
      try {
        const response = await this.#adapter.pollMatching({
          profile: this.#state.profile,
          selection: this.#state.selection
        });
        if (generation !== this.#generation) return;
        if (response?.status === 'success' && Number(response.rpllm_status) === 2 && response.rpllm_rpl_id) {
          const raid = this.#adapter.findRaid
            ? await this.#adapter.findRaid(response.rpllm_rpl_id)
            : { rpl_id: response.rpllm_rpl_id, rpl_pokemon: response.pokemon };
          return this.#finishMatch(raid, false);
        }
      } catch (error) {
        lastError = error;
      }
    }

    this.#setState({
      state: lastError ? 'retrying' : 'searching',
      lastContactAt: new Date().toISOString(),
      error: lastError ? lastError.message || String(lastError) : null
    });
    this.#schedulePoll(generation, Math.min(this.#pollIntervalMs, 1_000));
  }

  async #scanFastLobby(generation) {
    const selection = this.#state.selection ?? {};
    const selectedPokemon = new Set((selection.pokemon ?? []).map(String));
    const selectedRanks = new Set((selection.ranks ?? []).map(String));
    const raids = this.#adapter.listRaidsForSelection
      ? await this.#adapter.listRaidsForSelection(selection)
      : await this.#adapter.listRaids({ page: 1, rank: 0 });
    if (generation !== this.#generation) return null;

    const now = Date.now();
    for (const [id, attemptedAt] of this.#fastAttempts) {
      if (now - attemptedAt > 10_000) this.#fastAttempts.delete(id);
    }

    const candidates = raids.filter((raid) =>
      raid?.rpl_id &&
      selectedPokemon.has(String(raid.rpl_pokemon)) &&
      selectedRanks.has(String(raid.rpl_rank)) &&
      Number(raid.rpl_deleted || 0) === 0 &&
      Number(raid.my || 0) !== 1 &&
      (!Number(selection.hostLevel || 0) || Number(raid.rpl_level || 0) >= Number(selection.hostLevel)) &&
      (Number(selection.weatherBoost || 0) !== 1 || Number(raid.rpl_weather || 0) === 1) &&
      (Number(selection.weatherBoost || 0) !== 2 || Number(raid.rpl_weather || 0) !== 1)
    );

    for (const raid of candidates) {
      if (Number(raid.join || 0) === 1) return raid;
      if (Number(raid.rpl_glevel || 0) > Number(this.#state.profile?.level || 0)) continue;
      if (this.#fastAttempts.has(String(raid.rpl_id))) continue;
      this.#fastAttempts.set(String(raid.rpl_id), now);
      const response = await this.#adapter.joinRaidFast(raid.rpl_id, this.#state.profile);
      if (generation !== this.#generation) return null;
      if (response?.status === 'success') return response.data || raid;
    }
    return null;
  }

  async #finishMatch(raid, cancelQueue) {
    let cancellationError = null;
    if (cancelQueue && this.#adapter.cancelMatching) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await this.#adapter.cancelMatching();
          if (!response?.status || response.status === 'success') {
            cancellationError = null;
            break;
          }
          cancellationError = new Error(response.text || 'Could not cancel the Auto Join queue.');
        } catch (error) {
          cancellationError = error;
        }
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    this.#setState({
      state: 'matched',
      raid,
      profile: null,
      nextPollAt: null,
      error: cancellationError ? `Raiden hittades, men kön kunde inte avbrytas: ${cancellationError.message || cancellationError}` : null
    });
    this.emit('matched', raid);
  }

  #setState(patch) {
    Object.assign(this.#state, patch);
    this.emit('state', this.status());
  }

  #clearTimer() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
