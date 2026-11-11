import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AutoJoinWorker } from './core/autojoin-worker.js';
import { normalizeProfile, validateProfile } from './core/validation.js';
import { buildRaidBossCatalog, enrichRaids, groupRaidBosses } from './core/raid-catalog.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error('Request body is too large.');
  }
  return body ? JSON.parse(body) : {};
}

export function createApp({ adapter, store, sessionManager = null, pollIntervalMs = 15_000, publicDir, mode = 'demo', liveWrites = false }) {
  const defaultWorker = sessionManager ? null : new AutoJoinWorker({ adapter, pollIntervalMs });
  const defaultClients = new Set();
  const publicPath = publicDir instanceof URL ? fileURLToPath(publicDir) : publicDir;

  function publish(clients, event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) client.write(payload);
  }

  if (defaultWorker) {
    defaultWorker.on('state', (state) => {
      store.update({ autoJoin: state }).catch(() => {});
      publish(defaultClients, 'status', state);
    });
    defaultWorker.on('matched', (raid) => publish(defaultClients, 'matched', raid));
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');

      if (request.method === 'GET' && url.pathname === '/api/health') {
        return sendJson(response, 200, { ok: true });
      }

      const context = sessionManager
        ? await sessionManager.resolve(request, response)
        : { adapter, store, worker: defaultWorker, clients: defaultClients };
      const { adapter: activeAdapter, store: activeStore, worker, clients } = context;

      if (request.method === 'GET' && url.pathname === '/api/profile') {
        const profile = activeStore.get().profile ?? {};
        if (sessionManager && Object.keys(profile).length) await activeStore.update({ profile: {} });
        return sendJson(response, 200, profile);
      }
      if (request.method === 'POST' && url.pathname === '/api/login') {
        const credentials = await readJson(request);
        if (!credentials.email || !credentials.password) return sendJson(response, 400, { message: 'Email and password are required.' });
        if (!activeAdapter.login) return sendJson(response, 400, { message: 'Login is unavailable in this mode.' });
        const result = await activeAdapter.login({ email: credentials.email, password: credentials.password });
        if (result?.status !== 'success' || !result.token) return sendJson(response, 401, { message: result?.text || 'Raid NOW login failed.' });
        const current = activeStore.get().profile ?? {};
        const profile = normalizeProfile({
          trainerName: result.rplu_tid || current.trainerName,
          trainerCode: result.rplu_code || current.trainerCode,
          level: result.rplu_level || current.level,
          countryCode: result.rplu_country_code || current.countryCode || 'world'
        });
        await activeStore.update(sessionManager
          ? { account: { token: result.token, email: credentials.email } }
          : { profile, account: { token: result.token, email: credentials.email } });
        return sendJson(response, 200, { profile });
      }
      if (request.method === 'POST' && url.pathname === '/api/session/import') {
        const input = await readJson(request);
        const token = String(input.token || '').trim();
        if (!token) return sendJson(response, 400, { message: 'A Raid NOW session token is required.' });
        if (!activeAdapter.setToken) return sendJson(response, 400, { message: 'Session import is unavailable in this mode.' });
        activeAdapter.setToken(token);
        await activeStore.update({ account: { token, type: 'anonymous' } });
        return sendJson(response, 200, { connected: true });
      }
      if (request.method === 'GET' && url.pathname === '/api/config') {
        return sendJson(response, 200, { mode, liveWrites, pollIntervalMs, loggedIn: activeAdapter.hasToken ? activeAdapter.hasToken() : true });
      }
      if (request.method === 'PUT' && url.pathname === '/api/profile') {
        const profile = normalizeProfile(await readJson(request));
        const errors = validateProfile(profile);
        if (Object.keys(errors).length) return sendJson(response, 400, { errors });
        if (activeAdapter.updateProfile) await activeAdapter.updateProfile(profile);
        if (!sessionManager) await activeStore.update({ profile });
        return sendJson(response, 200, profile);
      }
      if (request.method === 'GET' && url.pathname === '/api/raids') {
        if (activeAdapter.listCurrentRaidBosses) {
          if (activeAdapter.hasToken && !activeAdapter.hasToken()) return sendJson(response, 401, { message: 'Raid NOW-sessionen behöver återställas.' });
          let bosses = buildRaidBossCatalog(await activeAdapter.listCurrentRaidBosses());
          const rank = String(url.searchParams.get('rank') || '0');
          if (rank !== '0') bosses = bosses.filter((boss) => boss.rank === rank);
          return sendJson(response, 200, { raids: [], bosses, fetchedAt: new Date().toISOString() });
        }
        const raids = enrichRaids(await activeAdapter.listRaids({
          page: Number(url.searchParams.get('page') || 1),
          rank: url.searchParams.get('rank') || 0
        }));
        return sendJson(response, 200, { raids, bosses: groupRaidBosses(raids), fetchedAt: new Date().toISOString() });
      }
      if (request.method === 'GET' && url.pathname === '/api/autojoin/status') {
        return sendJson(response, 200, worker.status());
      }
      if (request.method === 'GET' && url.pathname === '/api/active-raid') {
        const status = worker.status();
        if (status.state !== 'matched' || !status.raid?.rpl_id) return sendJson(response, 404, { message: 'There is no active raid.' });
        if (!activeAdapter.listRaidPlayers) return sendJson(response, 501, { message: 'Player details are unavailable in this mode.' });
        const details = await activeAdapter.listRaidPlayers(status.raid.rpl_id);
        return sendJson(response, 200, { raid: enrichRaids([status.raid])[0], ...details, fetchedAt: new Date().toISOString() });
      }
      if (request.method === 'POST' && url.pathname === '/api/autojoin/start') {
        const selection = await readJson(request);
        const profile = sessionManager
          ? normalizeProfile(selection.profile ?? {})
          : activeStore.get().profile ?? {};
        delete selection.profile;
        const errors = validateProfile(profile);
        if (Object.keys(errors).length) return sendJson(response, 400, { message: 'Complete your profile first.', errors });
        if (!Array.isArray(selection.ranks) || !selection.ranks.length || !Array.isArray(selection.pokemon) || !selection.pokemon.length) {
          return sendJson(response, 400, { message: 'Select at least one raid tier and one boss.' });
        }
        const status = await worker.start({ profile, selection });
        return sendJson(response, 200, status);
      }
      if (request.method === 'POST' && url.pathname === '/api/autojoin/stop') {
        return sendJson(response, 200, await worker.stop());
      }
      if (request.method === 'POST' && url.pathname === '/api/active-raid/leave') {
        return sendJson(response, 200, await worker.leaveRaid());
      }
      if (request.method === 'GET' && url.pathname === '/api/events') {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        });
        clients.add(response);
        response.write(`event: status\ndata: ${JSON.stringify(worker.status())}\n\n`);
        request.on('close', () => clients.delete(response));
        return;
      }

      if (request.method !== 'GET') return sendJson(response, 404, { message: 'Not found.' });
      const requested = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
      const safe = normalize(requested).replace(/^(\.\.[/\\])+/, '');
      const filePath = join(publicPath, safe);
      try {
        const content = await readFile(filePath);
        response.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
        response.end(content);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const content = await readFile(join(publicPath, 'index.html'));
        response.writeHead(200, { 'content-type': MIME['.html'] });
        response.end(content);
      }
    } catch (error) {
      sendJson(response, 500, { message: error.message || String(error) });
    }
  });

  return { server, worker: sessionManager || defaultWorker };
}
