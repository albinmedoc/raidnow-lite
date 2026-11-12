const SAMPLE_RAIDS = [
  { rpl_id: 'demo-1', rpl_rank: '5', rpl_pokemon: 'Giratina', rpl_level: 50, rpl_maxuser: 10, cnt: 3, readycnt: 2, rpl_country_code: 'se', time: '08:42', rpl_code: '999988887777' },
  { rpl_id: 'demo-2', rpl_rank: '5', rpl_pokemon: 'Zacian (Crowned Sword)', rpl_level: 47, rpl_maxuser: 10, cnt: 6, readycnt: 4, rpl_country_code: 'us', time: '12:10', rpl_code: '111122223333' },
  { rpl_id: 'demo-3', rpl_rank: '4', rpl_pokemon: 'Mega Sableye', rpl_level: 44, rpl_maxuser: 8, cnt: 2, readycnt: 1, rpl_country_code: 'jp', time: '04:55', rpl_code: '444455556666' }
];

export class MockRaidNowAdapter {
  #raids;
  #matchAfterPolls;
  #polls = 0;
  #selection = null;
  #active = false;

  constructor({ matchAfterPolls = 3, raids = SAMPLE_RAIDS } = {}) {
    this.#matchAfterPolls = matchAfterPolls;
    this.#raids = structuredClone(raids);
  }

  async listRaids({ rank = 0 } = {}) {
    return rank && rank !== '0' ? this.#raids.filter((raid) => String(raid.rpl_rank) === String(rank)) : structuredClone(this.#raids);
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
