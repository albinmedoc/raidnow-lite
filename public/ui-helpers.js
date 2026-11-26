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

export function queueSelectionFromBosses(bosses) {
  const pairs = [];
  const seen = new Set();
  for (const boss of Array.isArray(bosses) ? bosses : []) {
    const rank = String(boss?.rank ?? '');
    for (const value of Array.isArray(boss?.pokemon) ? boss.pokemon : []) {
      const pokemon = String(value);
      const key = `${rank}\u0000${pokemon}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ rank, pokemon });
    }
  }
  return {
    ranks: pairs.map((pair) => pair.rank),
    pokemon: pairs.map((pair) => pair.pokemon)
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

export function formatLobbyPlayerCount(count, maximum) {
  const current = Number(count);
  const max = Number(maximum);
  const currentText = Number.isInteger(current) && current >= 0 ? String(current) : '0';
  return Number.isInteger(max) && max > 0 ? `${currentText}/${max}` : currentText;
}

export function rankLabel(rank) {
  return ({ '4': 'Mega', '10': 'Dynamax', '11': 'Gigantamax' })[String(rank)] || `Tier ${rank || '?'}`;
}

export function bossCardAriaLabel(boss, waitingCount) {
  const count = Math.max(0, Number(waitingCount || 0));
  const parts = [rankLabel(boss?.rank), boss?.displayName || 'Okänd boss'];
  if (boss?.shinyAvailable === true) parts.push('Shiny tillgänglig');
  if (Number.isInteger(boss?.maxCP20) && boss.maxCP20 > 0) parts.push(`Hundo CP utan väderboost ${boss.maxCP20}`);
  if (Number.isInteger(boss?.maxCP25) && boss.maxCP25 > 0) parts.push(`Hundo CP med väderboost ${boss.maxCP25}`);
  parts.push(`${count} ${count === 1 ? 'person' : 'personer'} i kö`);
  return parts.join(', ');
}

export function formatRaidRating(value) {
  const available = Number.isInteger(value) && value >= 0 && value <= 5;
  return available
    ? { text: `★ ${value}/5`, title: `Raid NOW-rating: ${value} av 5` }
    : { text: '★ —', title: 'Raid NOW-rating saknas' };
}

export function workflowStatusPresentation(status) {
  const notice = status?.workflowNotice;
  if (typeof status?.error === 'string' && status.error) {
    return {
      title: 'Sökningen misslyckades',
      text: status.error,
      displayState: 'error'
    };
  }
  if (!notice || typeof notice.message !== 'string' || !notice.message) return null;
  const titles = {
    'leave-unavailable': 'Kunde inte lämna raiden',
    'leave-failed': 'Kunde inte lämna raiden',
    'raid-reconciliation-failed': 'Raiden behöver återställas',
    'leave-cleanup': 'Raiden lämnas',
    'leave-complete': 'Raiden är avslutad',
    'raid-ended': 'Raiden avslutades'
  };
  const displayStates = { error: 'error', success: 'stopped', info: 'reconciling' };
  return {
    title: titles[notice.kind] || 'Auto Join-status',
    text: notice.message,
    displayState: displayStates[notice.severity] || 'reconciling'
  };
}

export function mutationStatusDecision(startRevision, currentRevision) {
  return {
    apply: startRevision === currentRevision,
    nextRevision: currentRevision + 1
  };
}

export function shouldShowEndedRaidNotice(requestedRaidId, currentRaidId, requestGeneration, currentGeneration) {
  if (!requestedRaidId || requestGeneration !== currentGeneration) return false;
  return !currentRaidId || String(currentRaidId) === String(requestedRaidId);
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

export function isActiveRaidRequestCurrent(requestedRaidId, currentRaidId, requestGeneration, currentGeneration) {
  if (!requestedRaidId || requestGeneration !== currentGeneration) return false;
  return String(currentRaidId || '') === String(requestedRaidId);
}

export async function loadActiveRaidDetailsIfCurrent({
  requestDetails,
  requestedRaidId,
  requestGeneration,
  current
}) {
  const details = await requestDetails();
  const latest = current();
  if (!isActiveRaidRequestCurrent(
    requestedRaidId,
    latest?.activeRaidId,
    requestGeneration,
    latest?.requestGeneration
  )) return null;
  return isCurrentMatchedRaid(latest?.status, details?.raid) ? details : null;
}

export function activeRaidPresentation(status) {
  const matchedRaid = status?.state === 'matched' && ['matched', 'leaving'].includes(status?.raidMembership) && status.raid?.rpl_id
    ? status.raid
    : null;
  const recoveryRaid = !matchedRaid && status?.canRequestLeave && status.raid?.rpl_id
    ? status.raid
    : null;
  return { matchedRaid, recoveryRaid };
}
