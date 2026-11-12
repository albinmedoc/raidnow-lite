import { clearLocalProfile, loadLocalProfile, saveLocalProfile } from './profile-storage.js';
import { createBrowserResetController, isCurrentMatchedRaid } from './ui-helpers.js';
import { createTrainerCodeQrController } from './trainer-code-qr.js';
import {
  catalogForWorkerView,
  clearLocalSelection,
  isWorkerLocked,
  loadLocalSelection,
  nextStaleWarningCount,
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
  activeRaidTimer: null,
  eventSource: null,
  pendingStart: false,
  fetchedAt: null,
  staleWarningCount: 0
};
const $ = (selector) => document.querySelector(selector);
const trainerCodeQr = createTrainerCodeQrController();
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

function rankLabel(rank) {
  return ({ '4': 'Mega', '10': 'Dynamax', '11': 'Gigantamax' })[String(rank)] || `Tier ${rank || '?'}`;
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
  const locked = isWorkerLocked(workerState) || workerState === 'matched';
  const liveReadOnly = state.config?.mode === 'live' && !state.config.liveWrites;
  const controls = ['#rankFilter', '#bossSearch', '#hostLevel', '#weatherBoost', '#refreshRaids', '#filterButton'];
  for (const selector of controls) {
    const control = $(selector);
    control.disabled = locked;
    control.setAttribute('aria-disabled', String(locked));
  }
  $('#quickStartSearch').disabled = state.selected.size === 0 || locked || liveReadOnly || !['idle', 'stopped', 'error', undefined, null].includes(workerState);
  $('#quickStartSearch').setAttribute('aria-disabled', String($('#quickStartSearch').disabled));
  $('#stopSearch').disabled = !['starting', 'searching', 'retrying', 'joining'].includes(workerState);
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

function renderRaids() {
  const grid = $('#raidGrid');
  const locked = isWorkerLocked(state.autoJoin?.state) || state.autoJoin?.state === 'matched';
  const bosses = visibleBosses();
  grid.replaceChildren();
  if (!bosses.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = state.catalog.length ? 'Inga raidbossar matchar filtret.' : 'Inga raidbossar hittades.';
    grid.append(empty);
    return;
  }
  for (const boss of bosses) {
    const key = boss.id;
    const card = document.createElement('article');
    card.className = `raid-card boss-card${state.selected.has(key) ? ' selected' : ''}`;
    card.tabIndex = locked ? -1 : 0;
    card.setAttribute('role', 'checkbox');
    card.setAttribute('aria-checked', String(state.selected.has(key)));
    card.setAttribute('aria-disabled', String(locked));
    const top = document.createElement('div'); top.className = 'raid-top';
    const tier = document.createElement('span'); tier.className = 'tier'; tier.textContent = rankLabel(boss.rank);
    top.append(tier);
    if (boss.image) {
      const image = document.createElement('img');
      image.className = 'boss-image'; image.src = boss.image; image.alt = ''; image.loading = 'lazy';
      card.append(top, image);
    } else card.append(top);
    const title = document.createElement('h3'); title.textContent = boss.displayName || 'Okänd boss';
    const meta = document.createElement('div'); meta.className = 'meta';
    const description = document.createElement('span'); description.textContent = (boss.pokemon || []).join(', ');
    meta.append(description);
    const mark = document.createElement('span'); mark.className = 'select-mark'; mark.textContent = state.selected.has(key) ? '✓' : '+';
    card.append(title, meta, mark);
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
    grid.append(card);
  }
}

async function loadRaids({ dismissStaleWarning = false } = {}) {
  $('#raidUpdated').textContent = 'Hämtar raider…';
  try {
    const data = await api('/api/raids?rank=0');
    state.catalog = data.bosses || [];
    state.fetchedAt = data.fetchedAt;
    const reconciliation = reconcileCurrentSelection({ dismissStaleWarning });
    $('#raidUpdated').textContent = `Senast uppdaterad ${formatTime(data.fetchedAt)} · ${state.catalog.length} raidbossar`;
    renderRaids();
    renderSelectionDetail(reconciliation);
  } catch (error) {
    $('#raidUpdated').textContent = `Kunde inte hämta raider: ${error.message}`;
    if (error.status === 401 || /session|log in/i.test(error.data?.message || '')) $('#connectionDialog').showModal();
  }
}

function bossName(upstreamPokemon) {
  return state.catalog.find((boss) => (boss.pokemon || []).includes(upstreamPokemon))?.displayName || upstreamPokemon || 'Raid hittad';
}

function setHostTrainerCode(value) {
  const qr = trainerCodeQr.update(value);
  const dialog = $('#trainerCodeQrDialog');
  const image = $('#trainerCodeQrImage');
  $('#copyCode').dataset.code = qr?.payload || '';
  $('#copyQrCode').dataset.code = qr?.payload || '';
  $('#activeRaidCode').textContent = qr?.grouped || '—';
  $('#trainerCodeQrFallback').textContent = qr?.grouped || '—';
  $('#showQrCode').disabled = !qr;
  if (!qr) {
    image.hidden = true;
    image.removeAttribute('src');
    image.alt = '';
    if (dialog.open) dialog.close();
    return;
  }
  image.src = qr.imageUrl;
  image.alt = `QR-kod för trainer code ${qr.grouped}`;
  image.hidden = false;
}

async function loadActiveRaid() {
  try {
    const details = await api('/api/active-raid');
    if (!isCurrentMatchedRaid(state.autoJoin, details.raid)) return;
    $('#matchedBoss').textContent = bossName(details.raid.rpl_pokemon || details.raid.display_name);
    $('#activeRaidHost').textContent = details.raid.rpl_tid || 'Okänd host';
    $('#activeRaidCount').textContent = String(details.count ?? details.players.length);
    $('#activeRaidReady').textContent = `${details.readyCount ?? 0}/${details.count ?? details.players.length}`;
    $('#activeRaidMeta').textContent = `Uppdaterad ${formatTime(details.fetchedAt)}`;
    setHostTrainerCode(details.raid.rpl_code);
    const list = $('#activeRaidPlayers');
    list.replaceChildren();
    for (const player of details.players) {
      const row = document.createElement('div'); row.className = 'player-row';
      const name = document.createElement('div'); name.className = 'player-name';
      const strong = document.createElement('strong'); strong.textContent = player.trainerName || 'Okänd spelare';
      name.append(strong);
      if (player.isMe) { const me = document.createElement('span'); me.className = 'player-me'; me.textContent = 'Du'; name.append(me); }
      const meta = document.createElement('span'); meta.className = 'player-meta';
      meta.textContent = `TL ${player.level || '?'}${player.ready === 1 ? ' · Redo' : ''}`;
      row.append(name, meta); list.append(row);
    }
    if (!details.players.length) {
      const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'Inga spelare visas ännu.'; list.append(empty);
    }
  } catch (error) {
    $('#activeRaidMeta').textContent = `Kunde inte uppdatera raiden: ${error.message}`;
  }
}

function updateActiveRaidPolling(matched) {
  if (!matched) {
    if (state.activeRaidTimer) clearInterval(state.activeRaidTimer);
    state.activeRaidTimer = null;
    return;
  }
  loadActiveRaid();
  if (!state.activeRaidTimer) state.activeRaidTimer = setInterval(loadActiveRaid, 5_000);
}

function applySelectionPreferences(status) {
  const serverSelection = activeServerSelection(status);
  const preferences = serverSelection || state.localSelection;
  if (!preferences) return;
  $('#hostLevel').value = String(preferences.hostLevel ?? 0);
  $('#weatherBoost').value = String(preferences.weatherBoost ?? 0);
}

function renderStatus(status) {
  state.autoJoin = status;
  applySelectionPreferences(status);
  const labels = {
    idle: ['Auto Join är av', 'Välj raidbossar och starta sökningen.'],
    starting: ['Startar sökning', 'Ställer dig i kö och startar lobbybevakningen…'],
    searching: ['Söker i bakgrunden', 'Du står i kö samtidigt som nya lobbyer bevakas.'],
    retrying: ['Anslutningen återställs', status.error || 'Nytt försök schemalagt.'],
    joining: ['Ansluter till raid', 'En matchning har hittats och anslutningen slutförs…'],
    stopping: ['Stoppar sökning', status.error || 'Sökningen avslutas säkert…'],
    reconciling: ['Kontrollerar tidigare sökning', status.error || 'Raid NOW-status synkroniseras…'],
    matched: ['Matchning klar', bossName(status.raid?.rpl_pokemon)],
    stopped: ['Sökningen stoppad', 'Dina val finns kvar om du vill starta igen.'],
    error: ['Sökningen misslyckades', status.error || 'Okänt fel.']
  };
  const [title, text] = labels[status.state] || [status.state, ''];
  $('#statusTitle').textContent = title;
  $('#statusText').textContent = text;
  $('#statusDot').className = `status-dot ${status.state}`;
  $('#lastContact').textContent = status.lastContactAt ? `Kontakt ${formatTime(status.lastContactAt)}` : 'Ingen kontakt ännu';
  $('#nextPoll').textContent = status.nextPollAt ? `Nästa ${formatTime(status.nextPollAt)}` : '—';
  const matched = status.state === 'matched' && status.raid;
  const showSearchStatus = ['starting', 'searching', 'retrying', 'joining', 'stopping', 'reconciling', 'error'].includes(status.state);
  $('#statusCard').classList.toggle('hidden', !showSearchStatus);
  $('#matchedPanel').classList.toggle('hidden', !matched);
  updateActiveRaidPolling(matched);
  if (matched) {
    $('#matchedBoss').textContent = bossName(status.raid.rpl_pokemon);
    setHostTrainerCode(status.raid.rpl_code);
  } else setHostTrainerCode(null);
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
    $('#weatherBoost').value = String(state.localSelection.weatherBoost);
    $('#rankFilter').value = state.localSelection.rankFilter;
    $('#bossSearch').value = state.localSelection.textFilter;
  }
  updateProfileLabel();
  updateControls();
}

$('#sessionForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('#sessionMessage'); const form = event.currentTarget;
  message.className = 'form-message'; message.textContent = 'Ansluter…';
  try {
    await api('/api/session/import', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    form.elements.token.value = ''; state.config.loggedIn = true; message.textContent = 'Anonym session ansluten.';
    $('#connectionDialog').close(); await loadRaids();
  } catch (error) {
    form.elements.token.value = ''; message.className = 'form-message error'; message.textContent = error.message;
  }
});

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('#loginMessage'); const form = event.currentTarget;
  message.className = 'form-message'; message.textContent = 'Loggar in…';
  try {
    const result = await api('/api/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    state.profile = saveLocalProfile(localStorage, result.profile); state.config.loggedIn = true;
    const profileForm = $('#profileForm');
    for (const [key, value] of Object.entries(state.profile)) if (profileForm.elements[key]) profileForm.elements[key].value = value;
    updateProfileLabel(); form.elements.password.value = ''; message.textContent = 'Inloggad.';
    $('#connectionDialog').close(); await loadRaids();
  } catch (error) {
    form.elements.password.value = ''; message.className = 'form-message error'; message.textContent = error.message;
  }
});

$('#profileForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('#profileMessage'); message.className = 'form-message'; message.textContent = 'Sparar…';
  try {
    state.profile = await api('/api/profile', { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    saveLocalProfile(localStorage, state.profile); updateProfileLabel();
    message.textContent = 'Sparad.'; updateControls(); $('#profileDialog').close();
    if (state.pendingStart) { state.pendingStart = false; await startSearch(); }
  } catch (error) {
    message.className = 'form-message error';
    message.textContent = error.data?.errors ? Object.values(error.data.errors).join(' ') : error.message;
  }
});

async function startSearch() {
  if (!profileReady()) {
    state.pendingStart = true; $('#profileMessage').textContent = 'Fyll i profilen för att starta sökningen.'; $('#profileDialog').showModal(); return;
  }
  persistSelection();
  const bosses = [...state.selected.values()];
  const selection = {
    strategy: 'hybrid', profile: state.profile,
    ranks: [...new Set(bosses.map((boss) => String(boss.rank)))],
    pokemon: [...new Set(bosses.flatMap((boss) => boss.pokemon))],
    hostLevel: Number($('#hostLevel').value || 0), weatherBoost: Number($('#weatherBoost').value || 0)
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

$('#leaveRaid').addEventListener('click', async () => {
  if (!window.confirm('Vill du lämna den aktiva raiden?')) return;
  const button = $('#leaveRaid'); button.disabled = true;
  try {
    renderStatus(await api('/api/active-raid/leave', { method: 'POST', body: '{}' }));
    $('#searchMessage').className = 'form-message'; $('#searchMessage').textContent = 'Du har lämnat raiden.';
  } catch (error) {
    $('#activeRaidMeta').textContent = `Kunde inte lämna raiden: ${error.message}`;
  } finally { button.disabled = false; }
});

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
$('#hostLevel').addEventListener('change', persistSelection);
$('#weatherBoost').addEventListener('change', persistSelection);
$('#settingsButton').addEventListener('click', () => $('#profileDialog').showModal());
$('#filterButton').addEventListener('click', () => $('#filterDialog').showModal());

function closeBrowserResources() {
  const events = state.eventSource;
  if (events) events.close();
  if (state.activeRaidTimer) clearInterval(state.activeRaidTimer);
  state.eventSource = null;
  state.activeRaidTimer = null;
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
  if (state.eventSource) return;
  const events = new EventSource('/api/events');
  state.eventSource = events;
  events.addEventListener('status', (event) => renderStatus(JSON.parse(event.data)));
  events.addEventListener('matched', () => {
    // Server-side Web Push owns background notifications; SSE only updates the visible UI.
  });
}

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
  connectEvents();
}

init().catch((error) => { $('#statusTitle').textContent = 'Tjänsten svarar inte'; $('#statusText').textContent = error.message; });
