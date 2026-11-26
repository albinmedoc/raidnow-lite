import { CliCommandError, CliRunnerError } from './cli-process-runner.js';

const BASE_ARGS = ['--json', '--token-file'];
const BOSS_CACHE_MS = 60_000;

function invalidInput() {
  return new CliRunnerError('CLI_INVALID_INPUT', 'Invalid CLI adapter input.');
}

function protocolError() {
  return new CliRunnerError('CLI_PROTOCOL_ERROR', 'The CLI returned an invalid response.');
}

function writesDisabled() {
  return new CliRunnerError('WRITES_DISABLED', 'Live writes are disabled.');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertObjectArray(value) {
  if (!Array.isArray(value) || !value.every(isObject)) throw protocolError();
}

function assertBoolean(value) {
  if (typeof value !== 'boolean') throw protocolError();
}

function optionalPositiveInteger(value) {
  if (value === null) return null;
  if (!Number.isInteger(value) || value <= 0) throw protocolError();
  return value;
}

function profileHistoryEntry(entry) {
  return {
    displayTime: entry.displayTime,
    pokemonId: entry.pokemonId,
    pokemonName: entry.pokemonName,
    imageUrl: entry.imageUrl,
    trainerName: entry.trainerName,
    level: entry.level,
    country: entry.country,
    rating: entry.rating
  };
}

function trainerArgs(profile, { code = false } = {}) {
  const args = [
    '--trainer-name', String(profile?.trainerName ?? ''),
    '--trainer-level', String(profile?.level ?? ''),
    '--trainer-country', String(profile?.countryCode ?? '')
  ];
  if (code) args.push('--trainer-code-file', '-');
  return args;
}

function repeatedArgs(flag, values) {
  return (Array.isArray(values) ? values : []).flatMap((value) => [flag, String(value)]);
}

function minimumHostRating(hostEvaluate) {
  if (!Array.isArray(hostEvaluate) || hostEvaluate.length > 6) throw invalidInput();
  for (let index = 0; index < hostEvaluate.length; index += 1) {
    if (hostEvaluate[index] !== index - 1) throw invalidInput();
  }
  return hostEvaluate.length - 1;
}

function legacyRaid(raid, { exact = false } = {}) {
  assertBoolean(raid.deleted);
  assertBoolean(raid.isMe);
  const result = {
    rpl_id: raid.id,
    rpl_rank: raid.rank,
    rpl_pokemon: raid.pokemonId,
    rpl_tid: raid.hostName,
    rpl_level: raid.hostLevel,
    rpl_country_code: raid.country,
    rpl_weather: raid.weather,
    maxusers: raid.maxUsers,
    count: raid.count,
    readycount: raid.readyCount,
    join: raid.joinState,
    rpl_deleted: raid.deleted ? 1 : 0,
    my: raid.isMe ? 1 : 0,
    rpl_glevel: raid.minimumGuestLevel
  };
  if (exact && Object.hasOwn(raid, 'hostTrainerCode')) result.rpl_code = raid.hostTrainerCode;
  return result;
}

export class CliRaidNowAdapter {
  #runner;
  #tokenFile;
  #allowWrites;
  #currentBosses = [];
  #currentBossesAt = 0;

  constructor({ runner, tokenFile, allowWrites = false } = {}) {
    if (!runner || typeof runner.run !== 'function'
      || typeof tokenFile !== 'string' || tokenFile.trim().length === 0) {
      throw invalidInput();
    }
    this.#runner = runner;
    this.#tokenFile = tokenFile;
    this.#allowWrites = Boolean(allowWrites);
  }

  hasToken() { return true; }

  async updateProfile(profile, { signal } = {}) {
    this.#assertWritesAllowed();
    const data = await this.#run([
      'trainer', 'publish', ...trainerArgs(profile, { code: true })
    ], { stdin: profile?.trainerCode, signal });
    this.#assertObject(data);
    return { status: 'success' };
  }

  async listCurrentRaidBosses({ signal } = {}) {
    const data = await this.#run(['bosses', 'list'], { signal });
    assertObjectArray(data);
    const bosses = data.map((boss) => {
      assertBoolean(boss.shinyAvailable);
      return {
        rank: boss.rank,
        pokemon: boss.pokemonId,
        displayName: boss.pokemonName,
        image: boss.imageUrl,
        shinyAvailable: boss.shinyAvailable,
        maxCP20: optionalPositiveInteger(boss.maxCP20),
        maxCP25: optionalPositiveInteger(boss.maxCP25),
        waitingCount: boss.waitingCount
      };
    });
    this.#currentBosses = bosses;
    this.#currentBossesAt = Date.now();
    return bosses;
  }

  async listJoinedHistory({ signal } = {}) {
    const data = await this.#run(['history', 'joined'], { signal });
    assertObjectArray(data);
    return data.map(profileHistoryEntry);
  }

  async listKickedHistory({ signal } = {}) {
    const data = await this.#run(['history', 'kicked'], { signal });
    assertObjectArray(data);
    return data.map(profileHistoryEntry);
  }

  async listBlocks({ signal } = {}) {
    const data = await this.#run(['blocks', 'list'], { signal });
    assertObjectArray(data);
    return data.map((entry) => ({ trainerName: entry.trainerName }));
  }

  async listRaids({
    page = 1,
    filter = [],
    rank = 0,
    hostLevel = 0,
    hostEvaluate = []
  } = {}, { signal } = {}) {
    const data = await this.#run([
      'lobbies', 'list',
      '--page', String(page),
      '--rank', String(rank),
      '--host-level', String(hostLevel),
      '--min-host-rating', String(minimumHostRating(hostEvaluate)),
      '--include-metadata=false',
      ...repeatedArgs('--exclude-pokemon', filter)
    ], { signal });
    assertObjectArray(data);
    return data.map((raid) => legacyRaid(raid));
  }

  async listRaidsForSelection(selection = {}, { signal } = {}) {
    if (this.#currentBossesAt === 0 || Date.now() - this.#currentBossesAt > BOSS_CACHE_MS) {
      await this.listCurrentRaidBosses({ signal });
    }
    const selected = new Set((selection.pokemon ?? []).map(String));
    const filter = [...new Set(this.#currentBosses
      .map((boss) => String(boss.pokemon))
      .filter((pokemon) => !selected.has(pokemon)))];
    const ranks = [...new Set((selection.ranks ?? []).map(String))];
    const data = await this.#run([
      'lobbies', 'list',
      '--page', '1',
      '--rank', ranks.length === 1 ? ranks[0] : '0',
      '--host-level', String(selection.hostLevel),
      '--min-host-rating', String(selection.hostRating),
      '--include-metadata=false',
      ...repeatedArgs('--exclude-pokemon', filter)
    ], { signal });
    assertObjectArray(data);
    return data.map((raid) => legacyRaid(raid));
  }

  async joinRaidFast(raidId, profile, { signal } = {}) {
    this.#assertWritesAllowed();
    const data = await this.#run([
      'raid', 'join', '--raid-id', String(raidId), ...trainerArgs(profile)
    ], { signal });
    this.#assertObject(data);
    return { status: 'success' };
  }

  async createMatching({ profile, selection }, { signal } = {}) {
    this.#assertWritesAllowed();
    const data = await this.#run([
      'queue', 'join',
      ...repeatedArgs('--rank', selection?.ranks),
      ...repeatedArgs('--pokemon', selection?.pokemon),
      ...trainerArgs(profile, { code: true }),
      '--guest-score', String(selection?.guestScore ?? ''),
      '--min-host-rating', String(selection?.hostRating ?? 3),
      '--host-country', String(selection?.hostCountry ?? 0),
      '--weather-boost', String(selection?.weatherBoost ?? 0),
      '--host-level', String(selection?.hostLevel ?? 0)
    ], { stdin: profile?.trainerCode, signal });
    this.#assertObject(data);
    return { status: 'success' };
  }

  async pollMatching({ selection } = {}, { signal } = {}) {
    const data = await this.#run([
      'queue', 'status',
      ...repeatedArgs('--rank', selection?.ranks),
      ...repeatedArgs('--pokemon', selection?.pokemon)
    ], { signal });
    this.#assertObject(data);
    if (data.state === 'waiting') return { status: 'success', rpllm_status: 1 };
    if (data.state === 'matched') {
      return { status: 'success', rpllm_status: 2, rpllm_rpl_id: data.raidId };
    }
    throw protocolError();
  }

  async checkMatching({ selection } = {}, { signal } = {}) {
    const data = await this.#run([
      'queue', 'check', ...repeatedArgs('--pokemon', selection?.pokemon)
    ], { signal });
    this.#assertObject(data);
    assertBoolean(data.present);
    if (!Array.isArray(data.waiting)) throw protocolError();
    return {
      status: 'success',
      id: data.present ? data.id || 'present' : '',
      priority: data.priority,
      list: data.waiting
    };
  }

  async cancelMatching({ signal } = {}) {
    this.#assertWritesAllowed();
    const data = await this.#run(['queue', 'cancel', '--verify=false'], { signal });
    this.#assertObject(data);
    return { status: 'success' };
  }

  async findRaid(id, { signal } = {}) {
    try {
      const data = await this.#run(['raid', 'get', '--raid-id', String(id)], { signal });
      this.#assertObject(data);
      return legacyRaid(data, { exact: true });
    } catch (error) {
      if (error instanceof CliCommandError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  async listRaidPlayers(id, { signal } = {}) {
    const data = await this.#run(['raid', 'players', '--raid-id', String(id)], { signal });
    this.#assertObject(data);
    assertObjectArray(data.players);
    assertBoolean(data.raidDeleted);
    return {
      players: data.players.map((player) => {
        assertBoolean(player.ready);
        assertBoolean(player.isMe);
        return {
          id: player.id,
          trainerName: player.trainerName,
          level: player.level,
          countryCode: player.country,
          rating: player.rating,
          ready: player.ready ? 1 : 0,
          isMe: player.isMe
        };
      }),
      count: data.count,
      readyCount: data.readyCount,
      raidDeleted: data.raidDeleted
    };
  }

  async markRaidReady(id, { signal } = {}) {
    this.#assertWritesAllowed();
    const data = await this.#run([
      'raid', 'ready', '--raid-id', String(id)
    ], { signal });
    this.#assertObject(data);
    return { status: 'success' };
  }

  async leaveRaid(id, { signal } = {}) {
    this.#assertWritesAllowed();
    const data = await this.#run([
      'raid', 'leave', '--raid-id', String(id), '--verify=false'
    ], { signal });
    this.#assertObject(data);
    return { status: 'success' };
  }

  #assertObject(data) {
    if (!isObject(data)) throw protocolError();
  }

  #assertWritesAllowed() {
    if (!this.#allowWrites) throw writesDisabled();
  }

  async #run(args, { stdin = null, signal } = {}) {
    try {
      const envelope = await this.#runner.run({
        args: [...BASE_ARGS, this.#tokenFile, ...args],
        stdin,
        signal
      });
      return envelope.data;
    } catch (error) {
      if (error instanceof CliCommandError && error.code === 'AUTHENTICATION_UNSUPPORTED') {
        error.status = 401;
      }
      throw error;
    }
  }
}
