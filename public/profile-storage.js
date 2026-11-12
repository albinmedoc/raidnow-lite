const PROFILE_KEY = 'raidnow_profile_v2';

export function loadLocalProfile(storage = localStorage) {
  try {
    return JSON.parse(storage.getItem(PROFILE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

export function saveLocalProfile(storage = localStorage, profile) {
  storage.setItem(PROFILE_KEY, JSON.stringify(profile));
  return profile;
}

export function clearLocalProfile(storage = localStorage) {
  storage.removeItem(PROFILE_KEY);
}
