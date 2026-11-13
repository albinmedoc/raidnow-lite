export const SELECTION_KEY = 'raidnow_selection_v1';
const VERSION = 1;
const LOCKED_WORKER_STATES = new Set(['starting', 'searching', 'retrying', 'joining', 'stopping', 'reconciling']);

function exactBossId(value) {
  return typeof value === 'string' && /^.+\u0000.+$/u.test(value);
}

function normalizeInteger(value, allowed, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) && allowed(number) ? number : fallback;
}

function normalizeSelection(value) {
  if (!value || value.version !== VERSION || !Array.isArray(value.bossIds) || !value.bossIds.every(exactBossId)) return null;
  return {
    version: VERSION,
    bossIds: [...new Set(value.bossIds)],
    hostLevel: normalizeInteger(value.hostLevel, (number) => number >= 0 && number <= 80),
    weatherBoost: normalizeInteger(value.weatherBoost, (number) => [0, 1, 2].includes(number)),
    rankFilter: typeof value.rankFilter === 'string' ? value.rankFilter : '0',
    textFilter: typeof value.textFilter === 'string' ? value.textFilter.slice(0, 100) : ''
  };
}

export function loadLocalSelection(storage = localStorage) {
  try {
    return normalizeSelection(JSON.parse(storage.getItem(SELECTION_KEY) || 'null'));
  } catch {
    return null;
  }
}

export function saveLocalSelection(storage = localStorage, selection = {}) {
  const normalized = normalizeSelection({ version: VERSION, ...selection });
  if (!normalized) throw new TypeError('Selection contains an invalid boss identity.');
  storage.setItem(SELECTION_KEY, JSON.stringify(normalized));
  return normalized;
}

export function clearLocalSelection(storage = localStorage) {
  storage.removeItem(SELECTION_KEY);
}

export function filterBossCatalog(catalog = [], rank = '0', text = '') {
  const selectedRank = String(rank || '0');
  const query = String(text || '').trim().toLocaleLowerCase('en');
  return catalog.filter((boss) => {
    if (selectedRank !== '0' && String(boss.rank) !== selectedRank) return false;
    if (!query) return true;
    const searchable = [boss.displayName, ...(boss.pokemon || [])].join('\n').toLocaleLowerCase('en');
    return searchable.includes(query);
  });
}

export function catalogForWorkerView(catalog = [], selectedIds = new Set(), { active = false, rank = '0', text = '' } = {}) {
  if (active) return catalog.filter((boss) => selectedIds.has(boss.id));
  return filterBossCatalog(catalog, rank, text);
}

export function popularBosses(catalog = [], limit = 5) {
  return catalog
    .map((boss, index) => ({ boss, index }))
    .sort((left, right) => Number(right.boss.waitingCount || 0) - Number(left.boss.waitingCount || 0) || left.index - right.index)
    .slice(0, Math.max(0, limit))
    .map(({ boss }) => boss);
}

export function reconcileSelection(catalog = [], localSelection = null, serverSelection = null) {
  if (serverSelection && Array.isArray(serverSelection.ranks) && Array.isArray(serverSelection.pokemon)) {
    const ranks = new Set(serverSelection.ranks.map(String));
    const pokemon = new Set(serverSelection.pokemon.map(String));
    const selected = catalog.filter((boss) => ranks.has(String(boss.rank)) && (boss.pokemon || []).some((id) => pokemon.has(String(id))));
    const matchedPokemon = new Set(selected.flatMap((boss) => boss.pokemon || []).map(String));
    return {
      source: 'server',
      selected,
      staleIds: [],
      missingServerPokemon: [...pokemon].filter((id) => !matchedPokemon.has(id)).sort((a, b) => a.localeCompare(b))
    };
  }

  const ids = new Set(localSelection?.bossIds || []);
  const catalogIds = new Set(catalog.map((boss) => boss.id));
  return {
    source: 'local',
    selected: catalog.filter((boss) => ids.has(boss.id)),
    staleIds: [...ids].filter((id) => !catalogIds.has(id)).sort((a, b) => a.localeCompare(b)),
    missingServerPokemon: []
  };
}

export function nextStaleWarningCount(current = 0, reconciliation = null, { dismiss = false } = {}) {
  if (dismiss) return 0;
  return reconciliation?.staleIds?.length || current;
}

export function isWorkerLocked(workerState) {
  return LOCKED_WORKER_STATES.has(workerState);
}
