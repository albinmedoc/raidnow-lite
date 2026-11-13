const DEFAULT_URL = 'https://pokemongo-get.com/wp-content/themes/simplicity2-child/include/gofriend_enraid_masta.php?v=2025121601';
const RAIDNOW_PAGE_URL = 'https://raidnow.leekduck.com/';
const DEFAULT_OPERATION_TIMEOUTS = {
  login: 15_000,
  user_info_post: 15_000,
  par_list: 10_000,
  line_matching_get_list: 10_000,
  child_post_fast: 15_000,
  line_matching_create: 15_000,
  line_matching_list: 10_000,
  line_matching_check: 10_000,
  line_matching_cancel: 15_000,
  par_find_first: 10_000,
  child_list: 10_000,
  guest_raid_del_post: 15_000,
  pokemon_metadata: 10_000
};
const OPERATION_LABELS = {
  login: 'Login',
  user_info_post: 'Profile update',
  par_list: 'Raid list',
  line_matching_get_list: 'Auto Join boss list',
  child_post_fast: 'Fast raid join',
  line_matching_create: 'Auto Join create',
  line_matching_list: 'Auto Join poll',
  line_matching_check: 'Auto Join check',
  line_matching_cancel: 'Auto Join cancel',
  par_find_first: 'Raid lookup',
  child_list: 'Raid player list',
  guest_raid_del_post: 'Raid leave',
  pokemon_metadata: 'Pokémon metadata'
};

function parseAssignedJson(source, variableName) {
  const assignment = new RegExp(`\\bvar\\s+${variableName}\\s*=`).exec(source);
  if (!assignment) throw new Error(`Raid NOW metadata variable ${variableName} was not found.`);
  const start = source.indexOf('{', assignment.index + assignment[0].length);
  if (start < 0) throw new Error(`Raid NOW metadata variable ${variableName} was invalid.`);
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return JSON.parse(source.slice(start, index + 1));
  }
  throw new Error(`Raid NOW metadata variable ${variableName} was incomplete.`);
}

function appendValue(body, key, value) {
  if (Array.isArray(value)) {
    for (const item of value) body.append(`${key}[]`, String(item));
  } else if (value !== undefined && value !== null) {
    body.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
}

function upstreamResponseError(response, fallback) {
  const message = response?.text || fallback;
  const error = new Error(message);
  if (/session has expired|please log in|login required/i.test(message)) error.status = 401;
  return error;
}

export class RaidNowAdapter {
  #fetch;
  #url;
  #allowWrites;
  #token;
  #csrfToken;
  #operationTimeouts;
  #lastContext = null;
  #currentBosses = [];
  #currentBossesAt = 0;
  #pokemonMetadata = null;
  #pokemonMetadataAt = 0;

  constructor({ fetchImpl = fetch, url = DEFAULT_URL, allowWrites = false, token = '', csrfToken = '', operationTimeouts = {} } = {}) {
    this.#fetch = fetchImpl;
    this.#url = url;
    this.#allowWrites = allowWrites;
    this.#token = token;
    this.#csrfToken = csrfToken;
    this.#operationTimeouts = { ...DEFAULT_OPERATION_TIMEOUTS, ...operationTimeouts };
  }

  setToken(token = '') { this.#token = token; }
  hasToken() { return Boolean(this.#token); }

  async login({ email, password }, { signal } = {}) {
    const response = await this.#post('login', {
      input_email: email,
      input_password1: password,
      token: this.#token
    }, { url: 'https://raidnow.leekduck.com/', signal });
    if (response?.status === 'success' && response.token) this.#token = response.token;
    return response;
  }

  async updateProfile(profile, { signal } = {}) {
    this.#assertWritable();
    return this.#post('user_info_post', {
      input_tid: profile.trainerName,
      input_level: profile.level,
      input_code: profile.trainerCode,
      input_country_code: profile.countryCode,
      token: this.#token
    }, { allowEmpty: true, signal });
  }

  async listRaids({ page = 1, filter = [], rank = 0, hostLevel = 0, hostEvaluate = [] } = {}, { signal } = {}) {
    const response = await this.#post('par_list', {
      possible: false,
      filter,
      page,
      firstaccess: 0,
      searchrank: rank,
      hostevalstar: '',
      guestevalstar: '',
      lang: '1',
      token: this.#token,
      hostlevel: hostLevel,
      hostevaluate: hostEvaluate
    }, { signal });
    if (response?.status === 'error') throw upstreamResponseError(response, 'Raid NOW rejected the raid list request.');
    return Array.isArray(response) ? response : response?.list ?? [];
  }

  async listCurrentRaidBosses({ signal } = {}) {
    const [response, metadata] = await Promise.all([
      this.#post('line_matching_get_list', { token: this.#token }, { signal }),
      this.#listPokemonMetadata({ signal })
    ]);
    if (response?.status === 'error') throw upstreamResponseError(response, 'Raid NOW rejected the Auto Join list request.');
    const list = Array.isArray(response?.list) ? response.list : [];
    const bosses = list
      .filter((entry) => entry?.rank && entry?.pokemon && entry.pokemon !== 'egg')
      .map((entry) => {
        const pokemon = String(entry.pokemon);
        const details = metadata[pokemon] || {};
        return {
          rank: String(entry.rank),
          pokemon,
          displayName: String(details.en || pokemon),
          image: String(details.image || ''),
          waitingCount: Math.max(0, Number.parseInt(entry.offpokemon, 10) || 0)
        };
      });
    this.#currentBosses = bosses;
    this.#currentBossesAt = Date.now();
    return bosses;
  }

  async listRaidsForSelection(selection = {}, { signal } = {}) {
    if (!this.#currentBosses.length || Date.now() - this.#currentBossesAt > 60_000) {
      await this.listCurrentRaidBosses({ signal });
    }
    const selected = new Set((selection.pokemon ?? []).map(String));
    const filter = [...new Set(this.#currentBosses.map((boss) => boss.pokemon).filter((pokemon) => !selected.has(pokemon)))];
    const ranks = [...new Set((selection.ranks ?? []).map(String))];
    return this.listRaids({
      page: 1,
      rank: ranks.length === 1 ? ranks[0] : 0,
      filter,
      hostLevel: Number(selection.hostLevel || 0)
    }, { signal });
  }

  async joinRaidFast(raidId, profile, { signal } = {}) {
    this.#assertWritable();
    return this.#post('child_post_fast', {
      parid: raidId,
      tid: profile.trainerName,
      show: 0,
      level: profile.level,
      color: 0,
      memo: '',
      lang: '1',
      country_code: profile.countryCode,
      regional_raid: 0,
      token: this.#token
    }, { signal });
  }

  async createMatching({ profile, selection }, { signal } = {}) {
    this.#assertWritable();
    this.#lastContext = { profile, selection };
    return this.#post('line_matching_create', {
      rank: selection.ranks,
      pokemon: selection.pokemon,
      code: profile.trainerCode,
      tid: profile.trainerName,
      level: profile.level,
      priority: selection.priority ?? 0,
      lang: '1',
      gscore: selection.guestScore ?? '',
      country_code: profile.countryCode,
      plugs: JSON.stringify(selection.plugs ?? []),
      host_country: selection.hostCountry ?? 0,
      weather_boost: selection.weatherBoost ?? 0,
      guest6: selection.guest6 ?? 0,
      regional_raid: 0,
      token: this.#token,
      hosteval: selection.hostEvaluate ?? [-1, 0, 1, 2],
      hosttl: selection.hostLevel ?? 0
    }, { signal });
  }

  async pollMatching({ selection } = {}, { signal } = {}) {
    const actual = selection ?? this.#lastContext?.selection ?? {};
    return this.#post('line_matching_list', {
      rank: actual.ranks ?? [],
      pokemon: actual.pokemon ?? [],
      guestevalstar: actual.guestScore ?? '',
      token: this.#token
    }, { signal });
  }

  async checkMatching({ selection } = {}, { signal } = {}) {
    const actual = selection ?? this.#lastContext?.selection ?? {};
    return this.#post('line_matching_check', { pokemon: actual.pokemon ?? [], token: this.#token }, { signal });
  }

  async cancelMatching({ signal } = {}) {
    this.#assertWritable();
    return this.#post('line_matching_cancel', { lang: '1', token: this.#token }, { signal });
  }

  async findRaid(id, { signal } = {}) {
    const response = await this.#post('par_find_first', {
      possible: false,
      filter: [],
      firstaccess: id,
      lang: '1',
      token: this.#token,
      hostlevel: 0,
      hostevaluate: []
    }, { signal });
    if (Array.isArray(response)) return response.find((raid) => String(raid.rpl_id) === String(id)) ?? null;
    return response?.list?.find((raid) => String(raid.rpl_id) === String(id)) ?? null;
  }

  async listRaidPlayers(id, { signal } = {}) {
    const response = await this.#post('child_list', {
      parid: id,
      lang: '1',
      token: this.#token
    }, { signal });
    if (response?.status === 'error') throw new Error(response.text || 'Raid NOW rejected the player list request.');
    const players = (response?.list ?? []).map((player) => ({
      id: player.rplc_id,
      trainerName: player.rplc_tid,
      level: Number(player.rplc_level || 0),
      countryCode: player.rplc_country_code || '',
      ready: Number(player.rplc_ready || 0),
      isMe: Number(player.my || 0) === 1
    }));
    return {
      players,
      count: Number(response?.count ?? players.length),
      readyCount: Number(response?.readycount ?? 0),
      raidDeleted: Number(response?.rpl_delete ?? 0) === 1
    };
  }

  async leaveRaid(id, { signal } = {}) {
    this.#assertWritable();
    return this.#post('guest_raid_del_post', {
      edit: id,
      lang: '1',
      token: this.#token
    }, { signal });
  }

  async #post(type, fields, { allowEmpty = false, url = this.#url, signal } = {}) {
    const body = new URLSearchParams();
    body.append('type', type);
    for (const [key, value] of Object.entries(fields)) appendValue(body, key, value);

    const headers = {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      origin: 'https://raidnow.leekduck.com',
      referer: 'https://raidnow.leekduck.com/',
      'user-agent': 'Mozilla/5.0 RaidNowLite/0.1'
    };
    if (this.#csrfToken) headers['x-csrf-token'] = this.#csrfToken;
    return this.#withDeadline(type, signal, async (operationSignal) => {
      const response = await this.#fetch(url, { method: 'POST', headers, body, signal: operationSignal });
      if (!response.ok) throw new Error(`Raid NOW returned HTTP ${response.status}.`);
      const text = await response.text();
      if (!text.trim()) {
        if (allowEmpty) return {};
        throw new Error('Raid NOW returned an empty response.');
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new Error('Raid NOW returned an invalid JSON response.');
      }
    });
  }

  async #listPokemonMetadata({ signal } = {}) {
    if (this.#pokemonMetadata && Date.now() - this.#pokemonMetadataAt < 60 * 60_000) return this.#pokemonMetadata;
    try {
      return await this.#withDeadline('pokemon_metadata', signal, async (operationSignal) => {
        const response = await this.#fetch(RAIDNOW_PAGE_URL, {
          method: 'GET',
          headers: {
            accept: 'text/html',
            'user-agent': 'Mozilla/5.0 RaidNowLite/0.1'
          },
          signal: operationSignal
        });
        if (!response.ok) throw new Error(`Raid NOW returned HTTP ${response.status}.`);
        this.#pokemonMetadata = parseAssignedJson(await response.text(), 'aryPokemon');
        this.#pokemonMetadataAt = Date.now();
        return this.#pokemonMetadata;
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      return {};
    }
  }

  async #withDeadline(type, signal, operation) {
    const controller = new AbortController();
    const operationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timeoutError = new Error(`${OPERATION_LABELS[type]} timed out.`);
    let timeout;
    let abortListener;
    const races = [Promise.resolve().then(() => operation(operationSignal))];
    races.push(new Promise((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(timeoutError);
        controller.abort(timeoutError);
      }, this.#operationTimeouts[type]);
    }));
    if (signal) {
      races.push(new Promise((_resolve, reject) => {
        abortListener = () => reject(signal.reason);
        if (signal.aborted) abortListener();
        else signal.addEventListener('abort', abortListener, { once: true });
      }));
    }
    try {
      return await Promise.race(races);
    } finally {
      clearTimeout(timeout);
      if (abortListener) signal.removeEventListener('abort', abortListener);
    }
  }

  #assertWritable() {
    if (!this.#allowWrites) throw new Error('Live writes are disabled. Set RAIDNOW_LIVE_WRITES=true to enable Auto Join mutations.');
  }
}
