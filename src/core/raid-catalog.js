import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const catalog = JSON.parse(readFileSync(fileURLToPath(new URL('../data/pokemon-catalog.json', import.meta.url)), 'utf8'));

function readableName(name) {
  return String(name || '').replace(/\s*\(/g, ' (');
}

export function enrichRaids(raids = []) {
  return raids.map((raid) => {
    const entry = catalog[raid.rpl_pokemon] || {};
    return {
      ...raid,
      display_name: readableName(entry.name || raid.rpl_pokemon || 'Unknown boss'),
      image: entry.image || ''
    };
  });
}

export function groupRaidBosses(raids = []) {
  const groups = new Map();
  for (const raid of raids) {
    const key = `${raid.rpl_rank || ''}\u0000${raid.rpl_pokemon || ''}`;
    const existing = groups.get(key);
    if (existing) {
      existing.activeRaids += 1;
      continue;
    }
    groups.set(key, {
      id: key,
      rank: String(raid.rpl_rank || ''),
      pokemon: [raid.rpl_pokemon],
      displayName: raid.display_name || raid.rpl_pokemon,
      image: raid.image || '',
      activeRaids: 1
    });
  }
  return [...groups.values()].sort((a, b) => Number(b.rank) - Number(a.rank) || a.displayName.localeCompare(b.displayName));
}

export function buildRaidBossCatalog(currentBosses = []) {
  const bosses = new Map();
  for (const current of currentBosses) {
    const rank = String(current.rank || '');
    const pokemon = String(current.pokemon || '');
    if (!rank || !pokemon) continue;
    const key = `${rank}\u0000${pokemon}`;
    if (bosses.has(key)) continue;
    const entry = catalog[pokemon] || {};
    bosses.set(key, {
      id: key,
      rank,
      pokemon: [pokemon],
      displayName: readableName(entry.name || pokemon),
      image: entry.image || ''
    });
  }
  return [...bosses.values()].sort((a, b) => Number(b.rank) - Number(a.rank) || a.displayName.localeCompare(b.displayName));
}
