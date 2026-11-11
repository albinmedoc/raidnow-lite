import { loadLocalProfile, saveLocalProfile } from './profile-storage.js';

const state = { config: null, profile: {}, raids: [], bosses: [], selected: new Map(), autoJoin: null, activeRaidTimer: null, pendingStart: false };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.message || `HTTP ${response.status}`), { data });
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

function updateControls() {
  const active = ['starting', 'searching', 'retrying'].includes(state.autoJoin?.state);
  $('#quickStartSearch').disabled = state.selected.size === 0 || active || (state.config?.mode === 'live' && !state.config.liveWrites);
  $('#stopSearch').disabled = !active;
}

function renderSelection() {
  $('#quickSelection').textContent = state.selected.size
    ? [...state.selected.values()].map((boss) => boss.displayName).join(', ')
    : 'Välj minst en Pokémon';
  updateControls();
}

function renderRaids() {
  const grid = $('#raidGrid');
  grid.replaceChildren();
  if (!state.bosses.length) {
    const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'Inga raidbossar hittades.'; grid.append(empty); return;
  }
  for (const boss of state.bosses) {
    const key = boss.id;
    const card = document.createElement('article');
    card.className = `raid-card boss-card${state.selected.has(key) ? ' selected' : ''}`;
    card.tabIndex = 0;
    card.setAttribute('role', 'checkbox');
    card.setAttribute('aria-checked', String(state.selected.has(key)));
    const top = document.createElement('div'); top.className = 'raid-top';
    const tier = document.createElement('span'); tier.className = 'tier'; tier.textContent = rankLabel(boss.rank);
    top.append(tier);
    if (boss.image) {
      const image = document.createElement('img');
      image.className = 'boss-image';
      image.src = boss.image;
      image.alt = '';
      image.loading = 'lazy';
      card.append(top, image);
    } else {
      card.append(top);
    }
    const title = document.createElement('h3'); title.textContent = boss.displayName || 'Okänd boss';
    const meta = document.createElement('div'); meta.className = 'meta';
    const description = document.createElement('span'); description.textContent = 'Sök automatiskt efter denna Pokémon';
    meta.append(description);
    const mark = document.createElement('span'); mark.className = 'select-mark'; mark.textContent = state.selected.has(key) ? '✓' : '+';
    card.append(title, meta, mark);
    const toggle = () => {
      state.selected.has(key) ? state.selected.delete(key) : state.selected.set(key, boss);
      renderRaids(); renderSelection();
    };
    card.addEventListener('click', toggle);
    card.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); } });
    grid.append(card);
  }
}

async function loadRaids() {
  $('#raidUpdated').textContent = 'Hämtar raider…';
  try {
    const data = await api(`/api/raids?rank=${encodeURIComponent($('#rankFilter').value)}`);
    state.raids = data.raids;
    state.bosses = data.bosses || [];
    $('#raidUpdated').textContent = `Senast uppdaterad ${formatTime(data.fetchedAt)} · välj en eller flera Pokémon`;
    renderRaids();
  } catch (error) {
    $('#raidUpdated').textContent = `Kunde inte hämta raider: ${error.message}`;
    if (error.data?.message && /session|log in/i.test(error.data.message)) $('#connectionDialog').showModal();
  }
}

async function loadActiveRaid() {
  try {
    const details = await api('/api/active-raid');
    $('#matchedBoss').textContent = details.raid.display_name || details.raid.rpl_pokemon || 'Raid hittad';
    $('#activeRaidHost').textContent = details.raid.rpl_tid || 'Okänd host';
    $('#activeRaidCount').textContent = String(details.count ?? details.players.length);
    $('#activeRaidReady').textContent = `${details.readyCount ?? 0}/${details.count ?? details.players.length}`;
    $('#activeRaidMeta').textContent = `Uppdaterad ${formatTime(details.fetchedAt)}`;
    $('#copyCode').dataset.code = details.raid.rpl_code || '';
    const list = $('#activeRaidPlayers');
    list.replaceChildren();
    for (const player of details.players) {
      const row = document.createElement('div'); row.className = 'player-row';
      const name = document.createElement('div'); name.className = 'player-name';
      const strong = document.createElement('strong'); strong.textContent = player.trainerName || 'Okänd spelare';
      name.append(strong);
      if (player.isMe) {
        const me = document.createElement('span'); me.className = 'player-me'; me.textContent = 'Du'; name.append(me);
      }
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

function renderStatus(status) {
  state.autoJoin = status;
  const fast = status.selection?.strategy === 'fast';
  const hybrid = status.selection?.strategy === 'hybrid';
  const labels = {
    idle: ['Auto Join är av', 'Välj raidbossar och starta sökningen.'],
    starting: ['Startar sökning', hybrid ? 'Ställer dig i kö och startar lobbybevakningen…' : fast ? 'Förbereder snabbanslutning…' : 'Skickar inställningarna till Raid NOW…'],
    searching: ['Söker i bakgrunden', hybrid ? 'Du står i kö samtidigt som nya lobbyer bevakas varje sekund.' : fast ? 'Bevakar nya lobbyer och ansluter direkt när en plats blir ledig.' : 'Sökningen fortsätter även utan en öppen eller fokuserad flik.'],
    retrying: ['Anslutningen återställs', status.error || 'Nytt försök schemalagt.'],
    matched: ['Matchning klar', status.raid?.rpl_pokemon || 'En raid har hittats.'],
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
  const showSearchStatus = ['starting', 'searching', 'retrying', 'error'].includes(status.state);
  $('#statusCard').classList.toggle('hidden', !showSearchStatus);
  $('#matchedPanel').classList.toggle('hidden', !matched);
  updateActiveRaidPolling(matched);
  if (matched) {
    const selectedBoss = [...state.selected.values()].find((boss) => boss.pokemon.includes(status.raid.rpl_pokemon));
    $('#matchedBoss').textContent = selectedBoss?.displayName || status.raid.rpl_pokemon || 'Raid hittad';
    $('#copyCode').dataset.code = status.raid.rpl_code || '';
  }
  updateControls();
}

async function loadProfile() {
  state.profile = loadLocalProfile();
  const form = $('#profileForm');
  for (const [key, value] of Object.entries(state.profile)) if (form.elements[key]) form.elements[key].value = value;
  updateControls();
}

$('#sessionForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('#sessionMessage');
  const form = event.currentTarget;
  message.className = 'form-message';
  message.textContent = 'Ansluter…';
  try {
    await api('/api/session/import', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    form.elements.token.value = '';
    state.config.loggedIn = true;
    message.textContent = 'Anonym session ansluten.';
    $('#connectionDialog').close();
    await loadRaids();
  } catch (error) {
    form.elements.token.value = '';
    message.className = 'form-message error';
    message.textContent = error.message;
  }
});

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('#loginMessage');
  message.className = 'form-message';
  message.textContent = 'Loggar in…';
  const form = event.currentTarget;
  try {
    const result = await api('/api/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    state.profile = saveLocalProfile(localStorage, result.profile);
    state.config.loggedIn = true;
    const profileForm = $('#profileForm');
    for (const [key, value] of Object.entries(state.profile)) if (profileForm.elements[key]) profileForm.elements[key].value = value;
    form.elements.password.value = '';
    message.textContent = 'Inloggad.';
    updateControls();
    $('#connectionDialog').close();
    await loadRaids();
  } catch (error) {
    form.elements.password.value = '';
    message.className = 'form-message error';
    message.textContent = error.message;
  }
});

$('#profileForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('#profileMessage'); message.className = 'form-message'; message.textContent = 'Sparar…';
  try {
    state.profile = await api('/api/profile', { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    saveLocalProfile(localStorage, state.profile);
    message.textContent = 'Sparad.'; updateControls();
    $('#profileDialog').close();
    await loadRaids();
    if (state.pendingStart) {
      state.pendingStart = false;
      await startSearch();
    }
  } catch (error) {
    message.className = 'form-message error';
    message.textContent = error.data?.errors ? Object.values(error.data.errors).join(' ') : error.message;
  }
});

async function startSearch() {
  if (!profileReady()) {
    state.pendingStart = true;
    $('#profileMessage').textContent = 'Fyll i profilen för att starta sökningen.';
    $('#profileDialog').showModal();
    return;
  }
  const bosses = [...state.selected.values()];
  const selection = {
    strategy: 'hybrid',
    profile: state.profile,
    ranks: [...new Set(bosses.map((boss) => String(boss.rank)))],
    pokemon: [...new Set(bosses.flatMap((boss) => boss.pokemon))],
    hostLevel: Number($('#hostLevel').value || 0),
    weatherBoost: Number($('#weatherBoost').value || 0)
  };
  $('#searchMessage').textContent = 'Startar…';
  try {
    renderStatus(await api('/api/autojoin/start', { method: 'POST', body: JSON.stringify(selection) }));
    $('#searchMessage').textContent = 'Sökningen körs i tjänsten. Du kan stänga sidan.';
  } catch (error) {
    $('#searchMessage').className = 'form-message error'; $('#searchMessage').textContent = error.message;
  }
}

$('#quickStartSearch').addEventListener('click', startSearch);

$('#stopSearch').addEventListener('click', async () => {
  renderStatus(await api('/api/autojoin/stop', { method: 'POST', body: '{}' }));
});

$('#leaveRaid').addEventListener('click', async () => {
  if (!window.confirm('Vill du lämna den aktiva raiden?')) return;
  const button = $('#leaveRaid');
  button.disabled = true;
  try {
    renderStatus(await api('/api/active-raid/leave', { method: 'POST', body: '{}' }));
    $('#searchMessage').className = 'form-message';
    $('#searchMessage').textContent = 'Du har lämnat raiden.';
  } catch (error) {
    $('#activeRaidMeta').textContent = `Kunde inte lämna raiden: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});

$('#copyCode').addEventListener('click', async (event) => {
  const code = event.currentTarget.dataset.code;
  if (!code) return;
  await navigator.clipboard.writeText(code);
  event.currentTarget.textContent = 'Kopierad';
  setTimeout(() => event.currentTarget.textContent = 'Kopiera trainer code', 1500);
});

function configureNotificationButton() {
  const button = $('#notificationButton');
  if (!isSecureContext) {
    button.textContent = 'Notiser kräver HTTPS';
    button.disabled = true;
    button.title = 'Den här sidan körs över vanlig HTTP. Webbläsarnotiser kräver HTTPS.';
    return;
  }
  if (!('Notification' in window)) {
    button.textContent = 'Notiser stöds inte här';
    button.disabled = true;
    return;
  }
  button.textContent = Notification.permission === 'granted' ? 'Notifieringar aktiverade' : 'Aktivera notifieringar';
}

$('#notificationButton').addEventListener('click', async () => {
  if (!isSecureContext || !('Notification' in window)) return;
  const result = await Notification.requestPermission();
  $('#notificationButton').textContent = result === 'granted' ? 'Notifieringar aktiverade' : 'Notifieringar blockerade';
});

$('#refreshRaids').addEventListener('click', loadRaids);
$('#rankFilter').addEventListener('change', loadRaids);
$('#settingsButton').addEventListener('click', () => $('#profileDialog').showModal());
$('#filterButton').addEventListener('click', () => $('#filterDialog').showModal());

function connectEvents() {
  const events = new EventSource('/api/events');
  events.addEventListener('status', (event) => renderStatus(JSON.parse(event.data)));
  events.addEventListener('matched', (event) => {
    const raid = JSON.parse(event.data);
    const selectedBoss = [...state.selected.values()].find((boss) => boss.pokemon.includes(raid.rpl_pokemon));
    const name = selectedBoss?.displayName || raid.rpl_pokemon || 'Raid hittad';
    if (isSecureContext && 'Notification' in window && Notification.permission === 'granted') {
      new Notification('Din raid är redo', { body: `${name} har matchats. Öppna Raid NOW Lite för trainer code och spelare.` });
    }
  });
}

async function init() {
  state.config = await api('/api/config');
  const demo = state.config.mode === 'demo';
  $('#modeBadge').textContent = demo ? 'Demo · säkert testläge' : state.config.liveWrites ? 'Live' : 'Live · endast läsning';
  configureNotificationButton();
  if (!demo && !state.config.liveWrites) $('#searchMessage').textContent = 'Live Auto Join är låst tills RAIDNOW_LIVE_WRITES=true har aktiverats.';
  await loadProfile();
  if (demo || state.config.loggedIn) {
    await loadRaids();
  } else {
    $('#raidUpdated').textContent = 'Raid NOW-sessionen behöver återställas.';
    $('#connectionDialog').showModal();
  }
  renderStatus(await api('/api/autojoin/status'));
  connectEvents();
}

init().catch((error) => { $('#statusTitle').textContent = 'Tjänsten svarar inte'; $('#statusText').textContent = error.message; });
