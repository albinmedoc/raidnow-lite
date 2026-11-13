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

function boundedStrings(value, { label, maxItems, maxLength }) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxItems) invalid(`Select valid ${label}.`);
  const normalized = value.map((item) => typeof item === 'string' ? item.trim() : '');
  if (normalized.some((item) => !item || item.length > maxLength)) invalid(`Select valid ${label}.`);
  return [...new Set(normalized)];
}

export function hostEvaluateForMinimum(minimum) {
  if (minimum < 0) return [];
  return Array.from({ length: minimum + 1 }, (_, index) => index - 1);
}

export function normalizeSearchSelection(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Invalid search selection.');
  const hostRating = allowedInteger(input.hostRating, 3, HOST_RATINGS, 'host rating');
  return {
    strategy: 'hybrid',
    ranks: boundedStrings(input.ranks, { label: 'raid tiers', maxItems: 16, maxLength: 16 }),
    pokemon: boundedStrings(input.pokemon, { label: 'raid bosses', maxItems: 100, maxLength: 200 }),
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
  return normalizeSearchSelection({
    ranks: input?.ranks,
    pokemon: input?.pokemon,
    hostRating: supported(input?.hostRating, HOST_RATINGS),
    hostCountry: supported(input?.hostCountry, HOST_COUNTRIES),
    weatherBoost: supported(input?.weatherBoost, WEATHER_BOOSTS),
    hostLevel: supported(input?.hostLevel, HOST_LEVELS)
  });
}
