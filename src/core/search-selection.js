const HOST_RATINGS = new Set([-1, 0, 1, 2, 3, 4, 5]);
const HOST_COUNTRIES = new Set([0, 1]);
const WEATHER_BOOSTS = new Set([0, 1, 2]);
const HOST_LEVELS = new Set([0, 40, 50, 60, 70]);

function invalid(message) {
  throw Object.assign(new TypeError(message), { status: 400 });
}

function parseInteger(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/u.test(value)) return Number(value);
  return Number.NaN;
}

function allowedInteger(value, fallback, allowed, label) {
  const number = parseInteger(value == null ? fallback : value);
  if (!Number.isInteger(number) || !allowed.has(number)) invalid(`Invalid ${label}.`);
  return number;
}

function boundedStrings(value, { label, maxItems, maxLength, deduplicate = true }) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxItems) invalid(`Select valid ${label}.`);
  const normalized = value.map((item) => typeof item === 'string' ? item.trim() : '');
  if (normalized.some((item) => !item || item.length > maxLength)) invalid(`Select valid ${label}.`);
  return deduplicate ? [...new Set(normalized)] : normalized;
}

function boundedSelectionPairs(input) {
  const ranks = boundedStrings(input.ranks, { label: 'raid tiers', maxItems: 100, maxLength: 16, deduplicate: false });
  const pokemon = boundedStrings(input.pokemon, { label: 'raid bosses', maxItems: 100, maxLength: 200, deduplicate: false });
  if (ranks.length !== pokemon.length) invalid('Select matching raid tiers and bosses.');
  const pairs = [];
  const seen = new Set();
  for (let index = 0; index < ranks.length; index += 1) {
    const key = `${ranks[index]}\u0000${pokemon[index]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ rank: ranks[index], pokemon: pokemon[index] });
  }
  return {
    ranks: pairs.map((pair) => pair.rank),
    pokemon: pairs.map((pair) => pair.pokemon)
  };
}

export function hostEvaluateForMinimum(minimum) {
  if (minimum < 0) return [];
  return Array.from({ length: minimum + 1 }, (_, index) => index - 1);
}

export function normalizeSearchSelection(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Invalid search selection.');
  const hostRating = allowedInteger(input.hostRating, 3, HOST_RATINGS, 'host rating');
  const pairs = boundedSelectionPairs(input);
  return {
    strategy: 'hybrid',
    ...pairs,
    hostRating,
    hostCountry: allowedInteger(input.hostCountry, 0, HOST_COUNTRIES, 'host country'),
    weatherBoost: allowedInteger(input.weatherBoost, 0, WEATHER_BOOSTS, 'weather boost'),
    hostLevel: allowedInteger(input.hostLevel, 0, HOST_LEVELS, 'host level'),
    hostEvaluate: hostEvaluateForMinimum(hostRating),
    guest6: 0
  };
}

export function normalizeRestoredSearchSelection(input = {}) {
  const supported = (value, allowed) => {
    const number = parseInteger(value);
    return allowed.has(number) ? number : undefined;
  };
  const pokemon = input?.pokemon;
  const savedRanks = input?.ranks;
  const ranks = Array.isArray(savedRanks) && savedRanks.length === 1 && Array.isArray(pokemon) && pokemon.length > 1
    ? Array(pokemon.length).fill(savedRanks[0])
    : savedRanks;
  return normalizeSearchSelection({
    ranks,
    pokemon,
    hostRating: supported(input?.hostRating, HOST_RATINGS),
    hostCountry: supported(input?.hostCountry, HOST_COUNTRIES),
    weatherBoost: supported(input?.weatherBoost, WEATHER_BOOSTS),
    hostLevel: supported(input?.hostLevel, HOST_LEVELS)
  });
}
