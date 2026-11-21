export function createBrowserResetController({ suspend, requestReset, resume, clearLocalData, reload }) {
  let inFlight = null;
  return {
    run() {
      if (inFlight) return inFlight;
      inFlight = (async () => {
        suspend();
        try {
          await requestReset();
        } catch (error) {
          await resume();
          inFlight = null;
          throw error;
        }
        clearLocalData();
        reload();
      })();
      return inFlight;
    }
  };
}

export function formatTrainerCode(value) {
  const digits = String(value || '').replace(/\D/g, '').slice(0, 12);
  if (!digits) return '—';
  return digits.match(/.{1,4}/g).join(' ');
}

export function countryFlag(value) {
  const code = String(value || '').trim().toUpperCase();
  if (code === 'WORLD') return '🌐';
  if (!/^[A-Z]{2}$/.test(code)) return '';
  return String.fromCodePoint(...[...code].map((character) => 127397 + character.charCodeAt(0)));
}

export function formatRaidRating(value) {
  const available = Number.isInteger(value) && value >= 0 && value <= 5;
  return available
    ? { text: `★ ${value}/5`, title: `Raid NOW-rating: ${value} av 5` }
    : { text: '★ —', title: 'Raid NOW-rating saknas' };
}

export function applyStatusIfUnchanged(startRevision, currentRevision, status, render) {
  if (startRevision !== currentRevision) return false;
  render(status);
  return true;
}

export function searchStatusDisplay(status) {
  if (['starting', 'searching', 'joining', 'retrying'].includes(status?.state)) {
    return {
      title: 'Söker i bakgrunden',
      text: 'Du står i kö samtidigt som nya lobbyer bevakas.',
      displayState: 'searching'
    };
  }
  return null;
}

export function isCurrentMatchedRaid(status, raid) {
  return status?.state === 'matched'
    && Boolean(status.raid?.rpl_id)
    && status.raid.rpl_id === raid?.rpl_id;
}
