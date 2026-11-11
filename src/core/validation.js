export function normalizeProfile(input = {}) {
  return {
    trainerName: String(input.trainerName ?? '').trim(),
    trainerCode: String(input.trainerCode ?? '').replace(/[\s　]/g, ''),
    level: Number(input.level ?? 0),
    countryCode: String(input.countryCode ?? '').trim().toLowerCase()
  };
}

export function validateProfile(input = {}) {
  const profile = normalizeProfile(input);
  const errors = {};

  if (!/^[A-Za-z0-9]{3,}$/.test(profile.trainerName)) {
    errors.trainerName = 'Use at least 3 letters or numbers (A-Z, 0-9).';
  }
  if (!/^\d{12}$/.test(profile.trainerCode)) {
    errors.trainerCode = 'Trainer code must contain exactly 12 digits.';
  }
  if (!Number.isInteger(profile.level) || profile.level < 1 || profile.level > 80) {
    errors.level = 'Choose a trainer level.';
  }
  if (!profile.countryCode) {
    errors.countryCode = 'Choose a country.';
  }

  return errors;
}
