import { clearLocalProfile, loadLocalProfile, saveLocalProfile } from './profile-storage.js';
import { activeRaidPresentation, applyStatusIfUnchanged, bossCardAriaLabel, countryFlag, createBrowserResetController, createStatusOrdering, formatLobbyPlayerCount, formatRaidRating, isActiveRaidRequestCurrent, loadActiveRaidDetailsIfCurrent, mutationStatusDecision, queueSelectionFromBosses, rankLabel, searchStatusDisplay, shouldShowEndedRaidNotice, workflowStatusPresentation } from './ui-helpers.js';
import { createTrainerCodeQrController, isValidTrainerCode } from './trainer-code-qr.js';
import {
  catalogForWorkerView,
  clearLocalSelection,
  isWorkerLocked,
  loadLocalSelection,
  nextStaleWarningCount,
  popularBosses,
  reconcileSelection,
  saveLocalSelection
} from './selection-storage.js';

const state = {
  config: null,
  profile: {},
  catalog: [],
  selected: new Map(),
  localSelection: null,
  autoJoin: null,
  hostedLobby: null,
  hostedLobbyTimer: null,
  hostedLobbyRefreshInFlight: false,
  activeRaidId: null,
  activeRaidTimer: null,
  activeRaidRequestGeneration: 0,
  eventSource: null,
  statusTimer: null,
  statusRefreshInFlight: false,
  statusRevision: 0,
  pendingStart: false,
  pendingHost: false,
  fetchedAt: null,
  staleWarningCount: 0
};
const $ = (selector) => document.querySelector(selector);
const trainerCodeQr = createTrainerCodeQrController();
const hostedLobbyOrdering = createStatusOrdering();
let qrReturnFocus = null;
let installPrompt = null;

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  $('#installButton').classList.remove('hidden');
});

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  $('#installButton').classList.add('hidden');
  $('#notificationHelp').textContent = 'Appen är installerad. Aktivera notiser med ett eget tryck när du vill.';
});

$('#installButton').addEventListener('click', async () => {
  if (!installPrompt) return;
  await installPrompt.prompt();
  await installPrompt.userChoice.catch(() => null);
  installPrompt = null;
  $('#installButton').classList.add('hidden');
});

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.message || `HTTP ${response.status}`), { data, status: response.status });
  return data;
}

function formatTime(value) {
  if (!value) return 'Ingen kontakt ännu';
  return new Intl.DateTimeFormat('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
}

function profileReady() {
  return /^[A-Za-z0-9]{3,}$/.test(state.profile.trainerName || '') && /^\d{12}$/.test(state.profile.trainerCode || '') && Number(state.profile.level) > 0 && !!state.profile.countryCode;
}

function activeServerSelection(status = state.autoJoin) {
  return status?.selection && !['idle', 'stopped', 'error'].includes(status.state) ? status.selection : null;
}

function selectionSnapshot() {
  return {
    bossIds: [...state.selected.keys()],
    hostLevel: Number($('#hostLevel').value || 0),
    hostRating: Number($('#hostRating').value),
    hostCountry: Number($('#hostCountry').value || 0),
    weatherBoost: Number($('#weatherBoost').value || 0),
    rankFilter: $('#rankFilter').value,
    textFilter: $('#bossSearch').value
  };
}

function persistSelection() {
  state.localSelection = saveLocalSelection(localStorage, selectionSnapshot());
}

function updateProfileLabel() {
  $('#trainerNameLabel').textContent = state.profile.trainerName || 'Ej sparad';
}

function updateControls() {
  const workerState = state.autoJoin?.state;
  const hostLocked = Boolean(state.hostedLobby && state.hostedLobby.state !== 'none');
  const locked = isWorkerLocked(workerState) || workerState === 'matched' || hostLocked;
  const liveReadOnly = state.config?.mode === 'live' && !state.config.liveWrites;
  const controls = ['#rankFilter', '#bossSearch', '#hostRating', '#hostCountry', '#hostLevel', '#weatherBoost', '#refreshRaids', '#filterButton'];
  for (const selector of controls) {
    const control = $(selector);
    control.disabled = locked;
    control.setAttribute('aria-disabled', String(locked));
  }
  $('#quickStartSearch').disabled = state.selected.size === 0 || locked || liveReadOnly || !['idle', 'stopped', 'error', undefined, null].includes(workerState);
  $('#quickStartSearch').setAttribute('aria-disabled', String($('#quickStartSearch').disabled));
  $('#stopSearch').disabled = !['starting', 'searching', 'retrying', 'joining'].includes(workerState);
  $('#openHostLobby').disabled = !state.hostedLobby?.canCreate || isWorkerLocked(workerState) || workerState === 'matched' || liveReadOnly;
  $('#openHostLobby').setAttribute('aria-disabled', String($('#openHostLobby').disabled));
  $('#raidGrid').classList.toggle('controls-locked', locked);
}

function renderSelectionDetail(reconciliation = null) {
  const serverSelection = activeServerSelection();
  const detail = $('#activeSelection');
  if (serverSelection) {
    const names = reconciliation?.selected.map((boss) => boss.displayName) || [...state.selected.values()].map((boss) => boss.displayName);
    const missing = reconciliation?.missingServerPokemon || [];
    const allNames = [...names, ...missing];
    detail.textContent = `Söker efter: ${allNames.join(', ') || 'okänd boss'}`;
    detail.classList.toggle('warning', missing.length > 0);
    if (missing.length) detail.textContent += ' · en aktiv boss finns inte längre i katalogen';
    return;
  }
  detail.classList.remove('warning');
  if (state.staleWarningCount) {
    detail.textContent = `${state.staleWarningCount} sparat val finns inte längre i katalogen.`;
    detail.classList.add('warning');
  } else {
    detail.textContent = '';
  }
}

function renderSelection(reconciliation = null) {
  $('#quickSelection').textContent = state.selected.size
    ? [...state.selected.values()].map((boss) => boss.displayName).join(', ')
    : 'Välj minst en Pokémon';
  renderSelectionDetail(reconciliation);
  updateControls();
}

function applySelection(selection) {
  state.selected = new Map(selection.selected.map((boss) => [boss.id, boss]));
  renderSelection(selection);
}

function reconcileCurrentSelection({ dismissStaleWarning = false } = {}) {
  const serverSelection = activeServerSelection();
  const reconciliation = reconcileSelection(state.catalog, state.localSelection, serverSelection);
  state.staleWarningCount = nextStaleWarningCount(state.staleWarningCount, reconciliation, { dismiss: dismissStaleWarning });
  applySelection(reconciliation);
  if (!serverSelection && state.localSelection && reconciliation.staleIds.length) {
    state.localSelection = saveLocalSelection(localStorage, { ...state.localSelection, bossIds: reconciliation.selected.map((boss) => boss.id) });
  }
  return reconciliation;
}

function visibleBosses() {
  return catalogForWorkerView(state.catalog, new Set(state.selected.keys()), {
    active: Boolean(activeServerSelection()),
    rank: $('#rankFilter').value,
    text: $('#bossSearch').value
  });
}

function createBossCard(boss, { popular = false } = {}) {
  const locked = isWorkerLocked(state.autoJoin?.state) || state.autoJoin?.state === 'matched' || Boolean(state.hostedLobby && state.hostedLobby.state !== 'none');
  const key = boss.id;
  const card = document.createElement('article');
  card.className = `raid-card boss-card${popular ? ' popular-card' : ''}${state.selected.has(key) ? ' selected' : ''}`;
  card.tabIndex = locked ? -1 : 0;
  card.setAttribute('role', 'checkbox');
  card.setAttribute('aria-checked', String(state.selected.has(key)));
  card.setAttribute('aria-disabled', String(locked));
  const top = document.createElement('div'); top.className = 'raid-top';
  if (['10', '11'].includes(String(boss.rank))) {
    const icon = document.createElement('img');
    icon.className = 'dynamax-icon'; icon.src = '/icons/dynamax.svg'; icon.alt = ''; icon.title = rankLabel(boss.rank);
    top.setAttribute('aria-label', rankLabel(boss.rank));
    top.append(icon);
  } else {
    const tier = document.createElement('span'); tier.className = 'tier'; tier.textContent = rankLabel(boss.rank);
    top.append(tier);
  }
  if (boss.shinyAvailable) {
    const shiny = document.createElement('span');
    shiny.className = 'shiny-badge'; shiny.textContent = '✦'; shiny.title = 'Shiny tillgänglig';
    shiny.setAttribute('aria-label', 'Shiny tillgänglig');
    top.append(shiny);
  }
  card.append(top);
  if (boss.image) {
    const image = document.createElement('img');
    image.className = 'boss-image'; image.src = boss.image; image.alt = ''; image.loading = 'lazy';
    card.append(image);
  }
  const title = document.createElement('h3'); title.textContent = boss.displayName || 'Okänd boss';
  const cp = document.createElement('div'); cp.className = 'boss-cp';
  if (Number.isInteger(boss.maxCP20) && boss.maxCP20 > 0) {
    const normal = document.createElement('span'); normal.textContent = `CP ${boss.maxCP20}`;
    normal.title = `Hundo CP utan väderboost: ${boss.maxCP20}`;
    normal.setAttribute('aria-label', normal.title);
    cp.append(normal);
  }
  if (Number.isInteger(boss.maxCP25) && boss.maxCP25 > 0) {
    const boosted = document.createElement('span'); boosted.className = 'weather-boosted-cp'; boosted.textContent = `☀ ${boss.maxCP25}`;
    boosted.title = `Hundo CP med väderboost: ${boss.maxCP25}`;
    boosted.setAttribute('aria-label', boosted.title);
    cp.append(boosted);
  }
  const meta = document.createElement('div'); meta.className = 'meta queue-count';
  const count = Math.max(0, Number(boss.waitingCount || 0));
  card.setAttribute('aria-label', bossCardAriaLabel(boss, count));
  meta.setAttribute('aria-label', `${count} ${count === 1 ? 'person' : 'personer'} i kö`);
  const person = document.createElement('span'); person.className = 'queue-person'; person.setAttribute('aria-hidden', 'true');
  const number = document.createElement('span'); number.textContent = String(count);
  meta.append(person, number);
  const mark = document.createElement('span'); mark.className = 'select-mark'; mark.textContent = state.selected.has(key) ? '✓' : '+';
  card.append(title);
  if (cp.childElementCount) card.append(cp);
  card.append(meta, mark);
  const toggle = () => {
    if (isWorkerLocked(state.autoJoin?.state) || state.autoJoin?.state === 'matched') return;
    state.selected.has(key) ? state.selected.delete(key) : state.selected.set(key, boss);
    state.staleWarningCount = nextStaleWarningCount(state.staleWarningCount, null, { dismiss: true });
    persistSelection();
    renderRaids(); renderSelection();
  };
  card.addEventListener('click', toggle);
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
  });
  return card;
}

function renderBossGrid(grid, bosses, emptyText, options = {}) {
  grid.replaceChildren();
  if (!bosses.length) {
    const empty = document.createElement('p');
    empty.className = 'muted'; empty.textContent = emptyText;
    grid.append(empty);
    return;
  }
  for (const boss of bosses) grid.append(createBossCard(boss, options));
}

function renderRaids() {
  renderBossGrid($('#popularRaidGrid'), popularBosses(state.catalog, 5), 'Ingen ködata tillgänglig ännu.', { popular: true });
  const bosses = visibleBosses();
  renderBossGrid(
    $('#raidGrid'),
    bosses,
    state.catalog.length ? 'Inga raidbossar matchar filtret.' : 'Inga raidbossar hittades.'
  );
}

function renderHostedPokemonOptions() {
  const select = $('#hostPokemon');
  const current = select.value;
  select.replaceChildren();
  for (const boss of state.catalog) {
    const option = document.createElement('option');
    option.value = boss.pokemon;
    option.textContent = `${boss.displayName} · ${rankLabel(boss.rank)}`;
    select.append(option);
  }
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function defaultHostedStartDate() {
  const date = new Date(Date.now() + 5 * 60_000);
  const part = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
}

function hostedWireDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  return match ? `${match[1]}/${match[2]}/${match[3]} ${match[4]}:${match[5]}:00` : '';
}

function renderHostedLobby(status) {
  const wasLocked = Boolean(state.hostedLobby && state.hostedLobby.state !== 'none');
  state.hostedLobby = status;
  const active = status.state === 'active';
  const pending = status.state === 'creating';
  const unknown = status.state === 'unknown' || Boolean(status.uncertainOperation);
  $('#hostLobbyTitle').textContent = active ? (status.summary?.pokemonId || 'Hostad lobby') : unknown ? 'Osäkert lobbyresultat' : pending ? 'Skapar lobby…' : 'Egen Raid NOW-lobby';
  $('#hostLobbyStatus').textContent = active
    ? status.started === true ? 'Raiden är markerad som startad.' : `Lobby ${status.raidId} är öppen.`
    : unknown ? 'En tidigare åtgärd kunde inte bekräftas. Kontrollera Raid NOW innan du glömmer tillståndet lokalt.'
      : pending ? 'Lobbyåtgärden pågår.' : 'Skapa en lobby och hantera gäster här.';
  $('#hostLobbyDetails').classList.toggle('hidden', !active);
  $('#hostLobbyCount').textContent = String(status.count ?? 0);
  $('#hostLobbyReadyCount').textContent = String(status.readyCount ?? 0);
  $('#openHostLobby').classList.toggle('hidden', !status.canCreate);
  $('#startHostedRaid').classList.toggle('hidden', !active);
  $('#startHostedRaid').disabled = !status.canStart;
  $('#closeHostedLobby').classList.toggle('hidden', !active);
  $('#closeHostedLobby').disabled = !status.canClose;
  $('#abandonHostedLobby').classList.toggle('hidden', !status.canAbandon);
  $('#hostLobbyMessage').textContent = status.error || '';
  $('#hostLobbyMessage').classList.toggle('error', Boolean(status.error));
  const players = $('#hostLobbyPlayers');
  players.replaceChildren();
  if (!status.players?.length) {
    const empty = document.createElement('p');
    empty.className = 'muted'; empty.textContent = 'Inga gäster ännu.'; players.append(empty);
  } else {
    for (const player of status.players) {
      const row = document.createElement('article'); row.className = 'host-player-row';
      const name = document.createElement('strong'); name.className = 'host-player-name'; name.textContent = player.trainerName || 'Okänd tränare';
      const meta = document.createElement('span'); meta.className = 'host-player-meta';
      const rating = player.rating === null ? 'utan betyg' : `${player.rating}/5`;
      meta.textContent = `${countryFlag(player.countryCode)} TL ${player.level} · ${rating} · ${player.ready ? 'redo' : 'inte redo'}`;
      const identity = document.createElement('div'); identity.append(name, meta); row.append(identity);
      const kick = document.createElement('button'); kick.type = 'button'; kick.className = 'danger'; kick.textContent = 'Kicka'; kick.disabled = !player.canKick;
      kick.addEventListener('click', async () => {
        if (!window.confirm(`Kicka ${player.trainerName || 'gästen'} från lobbyn?`)) return;
        kick.disabled = true;
        try {
          const guestId = player.id;
          await mutateHostedLobby('/api/hosted-lobby/kick', { method: 'POST', body: JSON.stringify({ guestId }) });
        } catch (error) { $('#hostLobbyMessage').textContent = error.message; }
      });
      row.append(kick); players.append(row);
    }
  }
  updateControls();
  const isLocked = status.state !== 'none';
  if (wasLocked !== isLocked) renderRaids();
}

async function mutateHostedLobby(path, options) {
  const mutationRevision = hostedLobbyOrdering.beginMutation();
  try {
    const status = await api(path, options);
    hostedLobbyOrdering.finishMutation(mutationRevision, status, renderHostedLobby);
    return status;
  } catch (error) {
    const current = hostedLobbyOrdering.finishMutation(mutationRevision);
    if (!current) return { stale: true };
    throw error;
  }
}

async function refreshHostedLobby() {
  if (state.hostedLobbyRefreshInFlight || hostedLobbyOrdering.mutationInFlight) return;
  const startRevision = hostedLobbyOrdering.captureRead();
  state.hostedLobbyRefreshInFlight = true;
  try {
    const status = await api('/api/hosted-lobby');
    hostedLobbyOrdering.applyRead(startRevision, status, renderHostedLobby);
  } catch (error) {
    if (hostedLobbyOrdering.isReadCurrent(startRevision)) $('#hostLobbyMessage').textContent = `Kunde inte uppdatera lobbyn: ${error.message}`;
  } finally { state.hostedLobbyRefreshInFlight = false; }
}

async function loadRaids({ dismissStaleWarning = false } = {}) {
  $('#raidUpdated').textContent = 'Hämtar raider…';
  try {
    const data = await api('/api/raids?rank=0');
    state.catalog = data.bosses || [];
    state.fetchedAt = data.fetchedAt;
    renderHostedPokemonOptions();
    const reconciliation = reconcileCurrentSelection({ dismissStaleWarning });
    $('#raidUpdated').textContent = `Senast uppdaterad ${formatTime(data.fetchedAt)} · ${state.catalog.length} raidbossar`;
    renderRaids();
    renderSelectionDetail(reconciliation);
  } catch (error) {
    $('#raidUpdated').textContent = `Kunde inte hämta raider: ${error.message}`;
  }
}

function bossName(upstreamPokemon) {
  return state.catalog.find((boss) => (boss.pokemon || []).includes(upstreamPokemon))?.displayName || upstreamPokemon || 'Raid hittad';
}

function setHostTrainerCode(value) {
  const qr = trainerCodeQr.update(value);
  const dialog = $('#trainerCodeQrDialog');
  const image = $('#trainerCodeQrImage');
  const desktopImage = $('#activeRaidQrImage');
  $('#copyCode').dataset.code = qr?.payload || '';
  $('#copyQrCode').dataset.code = qr?.payload || '';
  $('#activeRaidCode').textContent = qr?.grouped || '—';
  $('#trainerCodeQrFallback').textContent = qr?.grouped || '—';
  $('#showQrCode').disabled = !qr;
  if (!qr) {
    for (const target of [image, desktopImage]) {
      target.hidden = true;
      target.removeAttribute('src');
      target.alt = '';
    }
    if (dialog.open) dialog.close();
    return;
  }
  image.src = qr.imageUrl;
  image.alt = `QR-kod för trainer code ${qr.grouped}`;
  image.hidden = false;
  desktopImage.src = qr.imageUrl;
  desktopImage.alt = `QR-kod för trainer code ${qr.grouped}`;
  desktopImage.hidden = false;
}

async function loadActiveRaid() {
  const requestedRaidId = state.activeRaidId;
  const requestGeneration = state.activeRaidRequestGeneration;
  try {
    const details = await loadActiveRaidDetailsIfCurrent({
      requestDetails: () => api('/api/active-raid'),
      requestedRaidId,
      requestGeneration,
      current: () => ({
        activeRaidId: state.activeRaidId,
        requestGeneration: state.activeRaidRequestGeneration,
        status: state.autoJoin
      })
    });
    if (!details) return;
    $('#matchedBoss').textContent = bossName(details.raid.rpl_pokemon || details.raid.display_name);
    $('#activeRaidHost').textContent = details.raid.rpl_tid || 'Okänd host';
    $('#activeRaidHostMeta').textContent = Number(details.raid.rpl_level) > 0 ? `TL ${Number(details.raid.rpl_level)}` : '';
    const playerCount = details.count ?? details.players.length;
    const maximumPlayers = details.raid.maxusers ?? details.raid.rpl_maxuser;
    $('#activeRaidCount').textContent = formatLobbyPlayerCount(playerCount, maximumPlayers);
    $('#activeRaidReady').textContent = `${details.readyCount ?? 0}/${playerCount}`;
    $('#activeRaidMeta').textContent = `Uppdaterad ${formatTime(details.fetchedAt)}`;
    const me = details.players.find((player) => player.isMe);
    $('#readyRaid').disabled = !me || me.ready === 1;
    if (isValidTrainerCode(details.raid.rpl_code)) setHostTrainerCode(details.raid.rpl_code);
    const list = $('#activeRaidPlayers');
    list.replaceChildren();
    for (const player of details.players) {
      const row = document.createElement('div'); row.className = 'player-row';
      const name = document.createElement('div'); name.className = 'player-name';
      const strong = document.createElement('strong'); strong.textContent = player.trainerName || 'Okänd spelare';
      name.append(strong);
      if (player.isMe) { const me = document.createElement('span'); me.className = 'player-me'; me.textContent = 'Du'; name.append(me); }
      const flag = countryFlag(player.countryCode);
      if (flag) {
        const country = document.createElement('span'); country.className = 'player-country'; country.textContent = flag;
        country.title = String(player.countryCode || '').toUpperCase();
        name.prepend(country);
      }
      const meta = document.createElement('span'); meta.className = 'player-meta';
      const level = document.createElement('span'); level.className = 'player-fact'; level.textContent = `TL ${player.level || '?'}`;
      const rating = document.createElement('span'); rating.className = 'player-fact player-rating';
      const ratingDisplay = formatRaidRating(player.rating);
      rating.textContent = ratingDisplay.text;
      rating.title = ratingDisplay.title;
      rating.setAttribute('aria-label', rating.title);
      meta.append(level, rating);
      if (player.ready === 1) {
        const ready = document.createElement('span'); ready.className = 'player-fact player-ready'; ready.textContent = 'Redo';
        meta.append(ready);
      }
      row.append(name, meta); list.append(row);
    }
    if (!details.players.length) {
      const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'Inga spelare visas ännu.'; list.append(empty);
    }
  } catch (error) {
    if (error.data?.code === 'RAID_ENDED') {
      if (!shouldShowEndedRaidNotice(requestedRaidId, state.activeRaidId, requestGeneration, state.activeRaidRequestGeneration)) return;
      await refreshAutoJoinStatus();
      return;
    }
    if (!isActiveRaidRequestCurrent(
      requestedRaidId,
      state.activeRaidId,
      requestGeneration,
      state.activeRaidRequestGeneration
    )) return;
    $('#activeRaidMeta').textContent = `Kunde inte uppdatera raiden: ${error.message}`;
  }
}

function updateActiveRaidPolling(matched) {
  const raidId = matched?.rpl_id ? String(matched.rpl_id) : null;
  if (!raidId) {
    if (state.activeRaidTimer) clearInterval(state.activeRaidTimer);
    state.activeRaidTimer = null;
    state.activeRaidId = null;
    $('#readyRaid').disabled = true;
    setHostTrainerCode(null);
    return;
  }
  const changedRaid = state.activeRaidId !== raidId;
  if (changedRaid) {
    if (state.activeRaidTimer) clearInterval(state.activeRaidTimer);
    state.activeRaidTimer = null;
    state.activeRaidId = raidId;
    $('#readyRaid').disabled = true;
    setHostTrainerCode(null);
    if (isValidTrainerCode(matched.rpl_code)) setHostTrainerCode(matched.rpl_code);
  }
  if (changedRaid || !state.activeRaidTimer) loadActiveRaid();
  if (!state.activeRaidTimer) state.activeRaidTimer = setInterval(loadActiveRaid, 5_000);
}

function applySelectionPreferences(status) {
  const serverSelection = activeServerSelection(status);
  const preferences = serverSelection || state.localSelection;
  if (!preferences) return;
  $('#hostLevel').value = String(preferences.hostLevel ?? 0);
  $('#hostRating').value = String(preferences.hostRating ?? 3);
  $('#hostCountry').value = String(preferences.hostCountry ?? 0);
  $('#weatherBoost').value = String(preferences.weatherBoost ?? 0);
}

function renderStatus(status) {
  state.statusRevision += 1;
  state.autoJoin = status;
  applySelectionPreferences(status);
  const labels = {
    idle: ['Auto Join är av', 'Välj raidbossar och starta sökningen.'],
    starting: ['Startar sökning', 'Ställer dig i kö och startar lobbybevakningen…'],
    searching: ['Söker i bakgrunden', status.directScanDisabled
      ? 'Auto Join-kön fortsätter. Direkt lobbybevakning är tillfälligt otillgänglig hos Raid NOW.'
      : 'Du står i kö samtidigt som nya lobbyer bevakas.'],
    retrying: ['Anslutningen återställs', status.error || 'Nytt försök schemalagt.'],
    joining: ['Ansluter till raid', 'En matchning har hittats och anslutningen slutförs…'],
    stopping: ['Stoppar sökning', status.error || 'Sökningen avslutas säkert…'],
    reconciling: ['Kontrollerar tidigare sökning', status.error || 'Raid NOW-status synkroniseras…'],
    matched: ['Matchning klar', bossName(status.raid?.rpl_pokemon)],
    stopped: ['Sökningen stoppad', 'Dina val finns kvar om du vill starta igen.'],
    error: ['Sökningen misslyckades', status.error || 'Okänt fel.']
  };
  const [title, text] = labels[status.state] || [status.state, ''];
  const workflowDisplay = workflowStatusPresentation(status);
  const display = workflowDisplay || searchStatusDisplay(status) || { title, text, displayState: status.state };
  $('#statusTitle').textContent = display.title;
  $('#statusText').textContent = display.text;
  $('#statusDot').className = `status-dot ${display.displayState}`;
  $('#lastContact').textContent = status.lastContactAt ? `Kontakt ${formatTime(status.lastContactAt)}` : 'Ingen kontakt ännu';
  $('#nextPoll').textContent = status.nextPollAt ? `Nästa ${formatTime(status.nextPollAt)}` : '—';
  const { matchedRaid: matched, recoveryRaid } = activeRaidPresentation(status);
  const showSearchStatus = Boolean(workflowDisplay) || Boolean(recoveryRaid) || ['starting', 'searching', 'retrying', 'joining', 'stopping', 'reconciling', 'error'].includes(status.state);
  $('#statusCard').classList.toggle('hidden', !showSearchStatus);
  $('#abandonSearch').classList.toggle('hidden', !status.canAbandonLocal);
  $('#recoverLeaveRaid').classList.toggle('hidden', !recoveryRaid);
  $('#matchedPanel').classList.toggle('hidden', !matched);
  updateActiveRaidPolling(matched);
  if (matched) $('#matchedBoss').textContent = bossName(status.raid.rpl_pokemon);
  const reconciliation = reconcileCurrentSelection();
  renderRaids();
  renderSelectionDetail(reconciliation);
  updateControls();
}

async function loadProfile() {
  state.profile = loadLocalProfile();
  state.localSelection = loadLocalSelection();
  const form = $('#profileForm');
  for (const [key, value] of Object.entries(state.profile)) if (form.elements[key]) form.elements[key].value = value;
  if (state.localSelection) {
    $('#hostLevel').value = String(state.localSelection.hostLevel);
    $('#hostRating').value = String(state.localSelection.hostRating);
    $('#hostCountry').value = String(state.localSelection.hostCountry);
    $('#weatherBoost').value = String(state.localSelection.weatherBoost);
    $('#rankFilter').value = state.localSelection.rankFilter;
    $('#bossSearch').value = state.localSelection.textFilter;
  }
  updateProfileLabel();
  updateControls();
}

function showProfilePanel(panel) {
  const historyVisible = panel === 'history';
  const blocksVisible = panel === 'blocks';
  $('#profileHistoryPanel').classList.toggle('hidden', !historyVisible);
  $('#profileBlocksPanel').classList.toggle('hidden', !blocksVisible);
  $('#showProfileHistory').setAttribute('aria-expanded', String(historyVisible));
  $('#showProfileBlocks').setAttribute('aria-expanded', String(blocksVisible));
}

function renderProfileHistoryList(target, entries, statusLabel, emptyMessage) {
  target.replaceChildren();
  if (!Array.isArray(entries) || entries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'profile-empty';
    empty.textContent = emptyMessage;
    target.append(empty);
    return;
  }
  for (const entry of entries) {
    const card = document.createElement('article');
    card.className = 'profile-history-card';
    if (entry.imageUrl) {
      const image = document.createElement('img');
      image.src = entry.imageUrl;
      image.alt = '';
      card.append(image);
    }
    const body = document.createElement('div');
    body.className = 'profile-history-card-body';
    const title = document.createElement('div');
    title.className = 'profile-history-card-title';
    const name = document.createElement('strong');
    name.textContent = entry.pokemonName || 'Okänd Pokémon';
    const status = document.createElement('span');
    status.className = 'profile-history-status';
    status.textContent = statusLabel;
    title.append(name, status);
    const host = document.createElement('p');
    const hostFacts = [countryFlag(entry.country), entry.trainerName || 'Okänd host'];
    if (Number(entry.level) > 0) hostFacts.push(`TL ${entry.level}`);
    if (entry.rating !== null && entry.rating !== undefined) hostFacts.push(formatRaidRating(entry.rating).text);
    host.textContent = hostFacts.filter(Boolean).join(' · ');
    const time = document.createElement('p');
    time.textContent = entry.displayTime || 'Tid saknas';
    body.append(title, host, time);
    card.append(body);
    target.append(card);
  }
}

function renderBlockedTrainers(entries) {
  const target = $('#blockedTrainerList');
  target.replaceChildren();
  if (!Array.isArray(entries) || entries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'profile-empty';
    empty.textContent = 'Inga blockerade spelare.';
    target.append(empty);
    return;
  }
  for (const entry of entries) {
    const card = document.createElement('div');
    card.className = 'blocked-trainer-card';
    const name = document.createElement('strong');
    name.textContent = entry.trainerName || 'Okänd spelare';
    const label = document.createElement('span');
    label.className = 'muted';
    label.textContent = 'Blockerad';
    card.append(name, label);
    target.append(card);
  }
}

async function loadProfileHistory() {
  showProfilePanel('history');
  const button = $('#showProfileHistory');
  const message = $('#profileHistoryMessage');
  button.disabled = true;
  message.className = 'form-message';
  message.textContent = 'Hämtar historik…';
  try {
    const history = await api('/api/profile/history');
    renderProfileHistoryList($('#joinedHistoryList'), history.joined, 'Deltagit', 'Ingen deltagarhistorik.');
    renderProfileHistoryList($('#kickedHistoryList'), history.kicked, 'Kickad', 'Ingen kickhistorik.');
    message.textContent = '';
  } catch (error) {
    message.className = 'form-message error';
    message.textContent = `Kunde inte hämta historiken: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

async function loadProfileBlocks() {
  showProfilePanel('blocks');
  const button = $('#showProfileBlocks');
  const message = $('#profileBlocksMessage');
  button.disabled = true;
  message.className = 'form-message';
  message.textContent = 'Hämtar blockerade spelare…';
  try {
    const data = await api('/api/profile/blocks');
    renderBlockedTrainers(data.blocks);
    message.textContent = '';
  } catch (error) {
    message.className = 'form-message error';
    message.textContent = `Kunde inte hämta blockerade spelare: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

$('#showProfileHistory').addEventListener('click', loadProfileHistory);
$('#showProfileBlocks').addEventListener('click', loadProfileBlocks);

$('#profileForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('#profileMessage'); message.className = 'form-message'; message.textContent = 'Sparar…';
  try {
    state.profile = await api('/api/profile', { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    saveLocalProfile(localStorage, state.profile); updateProfileLabel();
    message.textContent = 'Sparad.'; updateControls(); $('#profileDialog').close();
    if (state.pendingStart) { state.pendingStart = false; await startSearch(); }
    if (state.pendingHost) { state.pendingHost = false; $('#openHostLobby').click(); }
  } catch (error) {
    message.className = 'form-message error';
    message.textContent = error.data?.errors ? Object.values(error.data.errors).join(' ') : error.message;
  }
});

$('#openHostLobby').addEventListener('click', () => {
  if (!profileReady()) {
    state.pendingHost = true;
    $('#profileMessage').textContent = 'Fyll i profilen för att hosta en raid.';
    $('#profileDialog').showModal();
    return;
  }
  renderHostedPokemonOptions();
  if (!$('#hostStartDate').value) $('#hostStartDate').value = defaultHostedStartDate();
  $('#hostLobbyFormMessage').textContent = '';
  $('#hostLobbyDialog').showModal();
});

$('#hostPassType').addEventListener('change', () => {
  const remote = $('#hostPassType').value === 'remote';
  const ten = [...$('#hostMaxUsers').options].find((option) => option.value === '10');
  ten.disabled = remote;
  if (remote && $('#hostMaxUsers').value === '10') $('#hostMaxUsers').value = '5';
});

$('#hostLobbyForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = $('#hostLobbyFormMessage');
  const submit = form.querySelector('button[type="submit"]');
  message.className = 'form-message'; message.textContent = 'Skapar…'; submit.disabled = true;
  const payload = {
    profile: state.profile,
    startDate: hostedWireDate($('#hostStartDate').value),
    pokemonId: $('#hostPokemon').value,
    currentWeather: $('#hostCurrentWeather').value,
    gymColor: $('#hostGymColor').value,
    passType: $('#hostPassType').value,
    maxUsers: Number($('#hostMaxUsers').value),
    weatherBoosted: $('#hostWeatherBoosted').checked,
    guestLevel: Number($('#hostGuestLevel').value),
    guestRating: $('#hostGuestRating').value,
    private: $('#hostPrivate').checked,
    invitationOnly: $('#hostInvitationOnly').checked,
    hot: $('#hostHot').checked,
    megaPokemonEntry: $('#hostMegaPokemonEntry').checked
  };
  try {
    await mutateHostedLobby('/api/hosted-lobby', { method: 'POST', body: JSON.stringify(payload) });
    $('#hostLobbyDialog').close();
  } catch (error) {
    message.className = 'form-message error'; message.textContent = error.message;
  } finally { submit.disabled = false; }
});

$('#startHostedRaid').addEventListener('click', async () => {
  if (!window.confirm('Markera att raiden börjar? Gäster kan därefter inte hanteras som vanligt.')) return;
  try { await mutateHostedLobby('/api/hosted-lobby/start', { method: 'POST', body: '{}' }); }
  catch (error) { $('#hostLobbyMessage').textContent = error.message; }
});

$('#closeHostedLobby').addEventListener('click', async () => {
  if (!window.confirm('Stäng den hostade lobbyn?')) return;
  try { await mutateHostedLobby('/api/hosted-lobby/close', { method: 'POST', body: '{}' }); }
  catch (error) { $('#hostLobbyMessage').textContent = error.message; }
});

$('#abandonHostedLobby').addEventListener('click', async () => {
  if (!window.confirm('Glöm lobbyn endast lokalt? Detta skickar ingen ny åtgärd till Raid NOW.')) return;
  try { await mutateHostedLobby('/api/hosted-lobby/abandon', { method: 'POST', body: '{}' }); }
  catch (error) { $('#hostLobbyMessage').textContent = error.message; }
});

async function startSearch() {
  if (!profileReady()) {
    state.pendingStart = true; $('#profileMessage').textContent = 'Fyll i profilen för att starta sökningen.'; $('#profileDialog').showModal(); return;
  }
  persistSelection();
  const bosses = [...state.selected.values()];
  const pairedSelection = queueSelectionFromBosses(bosses);
  const selection = {
    strategy: 'hybrid', profile: state.profile,
    ...pairedSelection,
    hostLevel: Number($('#hostLevel').value || 0),
    hostRating: Number($('#hostRating').value),
    hostCountry: Number($('#hostCountry').value || 0),
    weatherBoost: Number($('#weatherBoost').value || 0)
  };
  $('#searchMessage').className = 'form-message search-message'; $('#searchMessage').textContent = 'Startar…';
  try {
    renderStatus(await api('/api/autojoin/start', { method: 'POST', body: JSON.stringify(selection) }));
    $('#searchMessage').textContent = 'Sökningen körs i tjänsten. Du kan stänga sidan.';
  } catch (error) {
    $('#searchMessage').className = 'form-message search-message error'; $('#searchMessage').textContent = error.message;
  }
}

$('#quickStartSearch').addEventListener('click', startSearch);
$('#stopSearch').addEventListener('click', async () => renderStatus(await api('/api/autojoin/stop', { method: 'POST', body: '{}' })));
$('#abandonSearch').addEventListener('click', async () => {
  const warning = 'Detta glömmer endast den lokala sökningen. En eventuell Raid NOW-kö avbryts inte och kan finnas kvar tills den löper ut. Fortsätt?';
  if (!window.confirm(warning)) return;
  try {
    renderStatus(await api('/api/autojoin/abandon', { method: 'POST', body: '{}' }));
  } catch { await refreshStatusAfterMutation(); }
});

$('#readyRaid').addEventListener('click', async () => {
  const button = $('#readyRaid');
  button.disabled = true;
  try {
    await api('/api/active-raid/ready', { method: 'POST', body: '{}' });
    await loadActiveRaid();
  } catch (error) {
    $('#activeRaidMeta').textContent = `Kunde inte markera dig som redo: ${error.message}`;
    button.disabled = error.data?.retryAllowed === false;
  }
});

async function requestRaidLeave(button) {
  if (!window.confirm('Vill du lämna den aktiva raiden?')) return;
  state.activeRaidRequestGeneration += 1;
  const leaveRevision = state.statusRevision;
  button.disabled = true;
  try {
    const status = await api('/api/active-raid/leave', { method: 'POST', body: '{}' });
    state.activeRaidRequestGeneration += 1;
    const decision = mutationStatusDecision(leaveRevision, state.statusRevision);
    state.statusRevision = decision.nextRevision;
    if (decision.apply) renderStatus(status);
  } catch {
    await refreshStatusAfterMutation();
  } finally { button.disabled = false; }
}

$('#leaveRaid').addEventListener('click', (event) => requestRaidLeave(event.currentTarget));
$('#recoverLeaveRaid').addEventListener('click', (event) => requestRaidLeave(event.currentTarget));

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* Fall through for HTTP/denied clipboard. */ }
  }
  const input = document.createElement('textarea');
  input.value = text; input.setAttribute('readonly', ''); input.style.position = 'fixed'; input.style.opacity = '0';
  document.body.append(input);
  try {
    input.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    input.remove();
  }
}

$('#copyCode').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const code = button.dataset.code;
  if (!code) return;
  const copied = await copyText(code);
  button.textContent = copied ? 'Kopierad' : 'Kopiering misslyckades – markera koden ovan och kopiera manuellt';
  setTimeout(() => { button.textContent = 'Kopiera trainer code'; }, 1800);
});

$('#copyQrCode').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const code = button.dataset.code;
  if (!code) return;
  const copied = await copyText(code);
  button.textContent = copied ? 'Kopierad' : 'Kopiering misslyckades – markera koden ovan och kopiera manuellt';
  setTimeout(() => { button.textContent = 'Kopiera trainer code'; }, 1800);
});

$('#showQrCode').addEventListener('click', (event) => {
  if (!trainerCodeQr.current) return;
  qrReturnFocus = event.currentTarget;
  $('#trainerCodeQrDialog').showModal();
});

$('#trainerCodeQrDialog').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});

$('#trainerCodeQrDialog').addEventListener('close', () => {
  qrReturnFocus?.focus();
  qrReturnFocus = null;
});

function urlBase64ToUint8Array(value) {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function isStandaloneApp() {
  return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

async function serviceWorkerRegistration() {
  if (!('serviceWorker' in navigator) || !isSecureContext) return null;
  await navigator.serviceWorker.register('/service-worker.js');
  return navigator.serviceWorker.ready;
}

async function configureNotificationButton() {
  const button = $('#notificationButton');
  const help = $('#notificationHelp');
  if (!isSecureContext) {
    button.textContent = 'Notiser kräver HTTPS'; button.disabled = true;
    help.textContent = 'Öppna appen via privat HTTPS för att installera och få pushnotiser.'; return;
  }
  if (!('Notification' in window) || !('PushManager' in window) || !('serviceWorker' in navigator)) {
    button.textContent = 'Notiser stöds inte här'; button.disabled = true;
    help.textContent = 'Webbläsaren saknar stöd för Web Push.'; return;
  }
  if (/iPad|iPhone|iPod/.test(navigator.userAgent) && !isStandaloneApp()) {
    button.textContent = 'Installera först';
    help.textContent = 'På iPhone/iPad: lägg till appen på hemskärmen, öppna den installerade appen och använd iOS/iPadOS 16.4+.';
    return;
  }
  const config = await api('/api/push/config');
  if (!config.enabled || !config.publicKey) {
    button.textContent = 'Notiser ej konfigurerade'; button.disabled = true;
    help.textContent = 'Servern kör utan Web Push. Sökningen fungerar fortfarande.'; return;
  }
  const registration = await serviceWorkerRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  button.textContent = subscription ? 'Notiser aktiverade' : Notification.permission === 'denied' ? 'Notiser blockerade' : 'Aktivera notiser';
  button.disabled = Notification.permission === 'denied';
  help.textContent = subscription ? 'Den här webbläsarsessionen får en privat notis när en raid hittas.' : 'Tryck för att aktivera notiser för just den här webbläsarsessionen.';
}

$('#notificationButton').addEventListener('click', async () => {
  const button = $('#notificationButton');
  if (!isSecureContext || !('Notification' in window) || !('PushManager' in window)) return;
  if (/iPad|iPhone|iPod/.test(navigator.userAgent) && !isStandaloneApp()) {
    $('#notificationHelp').textContent = 'Installera via Dela → Lägg till på hemskärmen, öppna sedan appen därifrån. Kräver iOS/iPadOS 16.4+.';
    return;
  }
  button.disabled = true;
  try {
    const config = await api('/api/push/config');
    if (!config.enabled || !config.publicKey) throw new Error('Servern har inte Web Push aktiverat.');
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (permission !== 'granted') throw new Error(permission === 'denied' ? 'Notiser är blockerade i webbläsarens inställningar.' : 'Notiser aktiverades inte.');
    const registration = await serviceWorkerRegistration();
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(config.publicKey) });
    await api('/api/push/subscriptions', { method: 'POST', body: JSON.stringify(subscription.toJSON()) });
    button.textContent = 'Notiser aktiverade';
    $('#notificationHelp').textContent = 'Den här webbläsarsessionen får en privat notis när en raid hittas.';
  } catch (error) {
    $('#notificationHelp').textContent = error.message;
    button.textContent = Notification.permission === 'denied' ? 'Notiser blockerade' : 'Försök igen';
  } finally {
    button.disabled = Notification.permission === 'denied';
  }
});

function updateLocalFilters() {
  persistSelection(); renderRaids(); renderSelection();
}
$('#refreshRaids').addEventListener('click', () => loadRaids({ dismissStaleWarning: true }));
$('#rankFilter').addEventListener('change', updateLocalFilters);
$('#bossSearch').addEventListener('input', updateLocalFilters);
$('#hostRating').addEventListener('change', persistSelection);
$('#hostCountry').addEventListener('change', persistSelection);
$('#hostLevel').addEventListener('change', persistSelection);
$('#weatherBoost').addEventListener('change', persistSelection);
$('#settingsButton').addEventListener('click', () => $('#profileDialog').showModal());
$('#filterButton').addEventListener('click', () => $('#filterDialog').showModal());

async function refreshAutoJoinStatus() {
  if (state.statusRefreshInFlight) return;
  state.statusRefreshInFlight = true;
  const startRevision = state.statusRevision;
  try {
    const status = await api('/api/autojoin/status');
    applyStatusIfUnchanged(startRevision, state.statusRevision, status, renderStatus);
  } catch {
    // SSE remains the primary channel; the next poll or reconnect retries.
  } finally {
    state.statusRefreshInFlight = false;
  }
}

async function refreshStatusAfterMutation() {
  state.statusRevision += 1;
  const startRevision = state.statusRevision;
  try {
    const status = await api('/api/autojoin/status');
    applyStatusIfUnchanged(startRevision, state.statusRevision, status, renderStatus);
  } catch {
    // The next SSE event or reconciliation poll retries without inventing UI state.
  }
}

function startStatusPolling() {
  if (!state.statusTimer) state.statusTimer = setInterval(refreshAutoJoinStatus, 5_000);
  if (!state.hostedLobbyTimer) state.hostedLobbyTimer = setInterval(refreshHostedLobby, 5_000);
}

function closeBrowserResources() {
  const events = state.eventSource;
  if (events) events.close();
  if (state.activeRaidTimer) clearInterval(state.activeRaidTimer);
  if (state.statusTimer) clearInterval(state.statusTimer);
  if (state.hostedLobbyTimer) clearInterval(state.hostedLobbyTimer);
  state.eventSource = null;
  state.activeRaidTimer = null;
  state.statusTimer = null;
  state.hostedLobbyTimer = null;
}

function resumeBrowserResources() {
  connectEvents();
  updateActiveRaidPolling(state.autoJoin?.state === 'matched' && state.autoJoin?.raid);
}

const browserReset = createBrowserResetController({
  suspend: closeBrowserResources,
  requestReset: () => api('/api/session/reset', { method: 'POST', body: '{}' }),
  resume: resumeBrowserResources,
  clearLocalData: () => {
    clearLocalProfile(localStorage);
    clearLocalSelection(localStorage);
  },
  reload: () => window.location.reload()
});

$('#resetBrowser').addEventListener('click', async () => {
  if (!window.confirm('Återställ denna webbläsare? Lokal profil, val och serversession tas bort. En aktiv sökning måste stoppas först.')) return;
  const button = $('#resetBrowser'); const message = $('#resetMessage');
  button.disabled = true; message.className = 'form-message'; message.textContent = 'Återställer…';
  try {
    await browserReset.run();
  } catch (error) {
    message.className = 'form-message error';
    message.textContent = error.status === 409
      ? 'Webbläsaren kan inte återställas medan en sökning, raid eller säker återställning pågår. Stoppa eller lämna först. Inga lokala data har tagits bort.'
      : `Kunde inte återställa webbläsaren: ${error.message}. Inga lokala data har tagits bort.`;
    button.disabled = false;
  }
});

function connectEvents() {
  startStatusPolling();
  if (state.eventSource) return;
  const events = new EventSource('/api/events');
  state.eventSource = events;
  events.addEventListener('open', refreshAutoJoinStatus);
  events.addEventListener('status', (event) => renderStatus(JSON.parse(event.data)));
  events.addEventListener('matched', () => {
    // Server-side Web Push owns background notifications; SSE only updates the visible UI.
  });
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { refreshAutoJoinStatus(); refreshHostedLobby(); }
});
window.addEventListener('focus', () => { refreshAutoJoinStatus(); refreshHostedLobby(); });

async function init() {
  state.config = await api('/api/config');
  const demo = state.config.mode === 'demo';
  $('#modeBadge').textContent = demo ? 'Demo · säkert testläge' : state.config.liveWrites ? 'Live' : 'Live · endast läsning';
  await serviceWorkerRegistration().catch(() => null);
  await configureNotificationButton();
  if (!demo && !state.config.liveWrites) $('#searchMessage').textContent = 'Live Auto Join är låst tills RAIDNOW_LIVE_WRITES=true har aktiverats.';
  await loadProfile();
  await loadRaids();
  renderStatus(await api('/api/autojoin/status'));
  await refreshHostedLobby();
  connectEvents();
}

init().catch((error) => renderStatus({
  state: 'error', error: error.message, lastContactAt: null, nextPollAt: null,
  raid: null, raidMembership: 'none', canRequestLeave: false, canAbandonLocal: false
}));
