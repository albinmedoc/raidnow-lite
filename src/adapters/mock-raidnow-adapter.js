const SAMPLE_RAIDS = [
  { rpl_id: 'demo-1', rpl_rank: '5', rpl_pokemon: 'Giratina', rpl_image: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/487.png', rpl_level: 50, rpl_maxuser: 10, cnt: 3, readycnt: 2, rpl_country_code: 'se', time: '08:42', rpl_code: '999988887777' },
  { rpl_id: 'demo-2', rpl_rank: '5', rpl_pokemon: 'Zacian (Crowned Sword)', rpl_image: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/888.png', rpl_level: 47, rpl_maxuser: 10, cnt: 6, readycnt: 4, rpl_country_code: 'us', time: '12:10', rpl_code: '111122223333' },
  { rpl_id: 'demo-3', rpl_rank: '4', rpl_pokemon: 'Mega Sableye', rpl_image: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/302.png', rpl_level: 44, rpl_maxuser: 8, cnt: 2, readycnt: 1, rpl_country_code: 'jp', time: '04:55', rpl_code: '444455556666' }
];

export class MockRaidNowAdapter {
  #raids;
  #matchAfterPolls;
  #polls = 0;
  #selection = null;
  #active = false;
  #hostedLobby = null;

  constructor({ matchAfterPolls = 3, raids = SAMPLE_RAIDS } = {}) {
    this.#matchAfterPolls = matchAfterPolls;
    this.#raids = structuredClone(raids);
  }

  async listRaids({ rank = 0 } = {}) {
    return rank && rank !== '0' ? this.#raids.filter((raid) => String(raid.rpl_rank) === String(rank)) : structuredClone(this.#raids);
  }

  async listCurrentRaidBosses() {
    return this.#raids.map((raid) => ({
      rank: String(raid.rpl_rank), pokemon: raid.rpl_pokemon, displayName: raid.rpl_pokemon,
      image: raid.rpl_image, shinyAvailable: false, maxCP20: null, maxCP25: null, waitingCount: raid.cnt ?? 0
    }));
  }

  async createHostedLobby(input) {
    this.#hostedLobby = {
      id: 'demo-host-1', pokemonId: input.pokemonId, started: false, deleted: false,
      players: [{ id: 'demo-host-guest-1', trainerName: 'DemoGuest', level: 44, countryCode: 'jp', rating: 0, ready: false, isMe: false }]
    };
    return { raidId: this.#hostedLobby.id };
  }

  async getHostedLobbyStatus(id) {
    if (!this.#hostedLobby || this.#hostedLobby.id !== String(id) || this.#hostedLobby.deleted) {
      return { players: [], count: 0, readyCount: 0, raidDeleted: true };
    }
    const players = structuredClone(this.#hostedLobby.players);
    return { players, count: players.length, readyCount: players.filter((player) => player.ready).length, raidDeleted: false };
  }

  async kickHostedGuest(id, guestId) {
    if (!this.#hostedLobby || this.#hostedLobby.id !== String(id)) throw new Error('Hosted lobby not found.');
    this.#hostedLobby.players = this.#hostedLobby.players.filter((player) => player.id !== String(guestId));
    return { kicked: true };
  }

  async startHostedLobby(id) {
    if (!this.#hostedLobby || this.#hostedLobby.id !== String(id)) throw new Error('Hosted lobby not found.');
    this.#hostedLobby.started = true;
    return { started: true };
  }

  async closeHostedLobby(id) {
    if (!this.#hostedLobby || this.#hostedLobby.id !== String(id)) throw new Error('Hosted lobby not found.');
    this.#hostedLobby.deleted = true;
    return { closed: true };
  }

  async joinRaidFast(id) {
    const raid = this.#raids.find((item) => String(item.rpl_id) === String(id));
    if (!raid) return { status: 'error', text: 'Raid not found.' };
    raid.join = 1;
    return { status: 'success', data: structuredClone(raid) };
  }

  async createMatching({ selection }) {
    this.#selection = structuredClone(selection);
    this.#polls = 0;
    this.#active = true;
    return { status: 'success', list: [] };
  }

  async pollMatching() {
    if (!this.#active) return { status: 'error', text: 'No active search.' };
    this.#polls += 1;
    if (this.#polls < this.#matchAfterPolls) return { status: 'success', rpllm_status: 1, list: [] };
    const raid = this.#matchingRaid();
    raid.join = 1;
    this.#active = false;
    return { status: 'success', rpllm_status: 2, rpllm_rpl_id: raid.rpl_id, pokemon: raid.rpl_pokemon, list: [] };
  }

  async checkMatching() {
    return this.#active ? { id: 'demo-search', priority: 0, list: [] } : { id: '', list: [] };
  }

  async cancelMatching() {
    this.#active = false;
    return { status: 'success' };
  }

  async findRaid(id) {
    return structuredClone(this.#raids.find((raid) => String(raid.rpl_id) === String(id)) ?? null);
  }

  async listRaidPlayers(id) {
    const raid = this.#raids.find((item) => String(item.rpl_id) === String(id));
    if (!raid) return { players: [], count: 0, readyCount: 0, raidDeleted: true };
    return {
      players: [
        { id: 'demo-player-1', trainerName: 'DemoTrainer', level: 50, countryCode: 'se', rating: 5, ready: 1, isMe: true },
        { id: 'demo-player-2', trainerName: 'RaidFriend', level: 47, countryCode: 'de', rating: 4, ready: 0, isMe: false },
        { id: 'demo-player-3', trainerName: 'NewTrainer', level: 41, countryCode: 'jp', rating: 0, ready: 0, isMe: false }
      ],
      count: 3,
      readyCount: 1,
      raidDeleted: false
    };
  }

  async listJoinedHistory() {
    return [{
      displayTime: 'Idag 14:30', pokemonId: 'Giratina', pokemonName: 'Giratina',
      trainerName: 'DemoHost', level: 50, country: 'se', rating: 5
    }];
  }

  async listKickedHistory() {
    return [{
      displayTime: 'Igår 18:15', pokemonId: 'Zacian (Crowned Sword)', pokemonName: 'Zacian (Crowned Sword)',
      trainerName: 'AnotherHost', level: 47, country: 'us', rating: 4
    }];
  }

  async listBlocks() {
    return [{ trainerName: 'VeryLongBlockedTrainerName12345' }];
  }

  async leaveRaid(id) {
    const raid = this.#raids.find((item) => String(item.rpl_id) === String(id));
    if (!raid || raid.join !== 1) return { status: 'error', text: 'Raid membership not found.' };
    raid.join = 0;
    return { status: 'success' };
  }

  #matchingRaid() {
    return this.#raids.find((raid) => this.#selection?.pokemon?.includes(raid.rpl_pokemon) && this.#selection?.ranks?.map(String).includes(String(raid.rpl_rank))) ?? this.#raids[0];
  }
}
