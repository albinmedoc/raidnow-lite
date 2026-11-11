import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonStore } from './json-store.js';

const COOKIE_NAME = 'raidnow_session';
const ACTIVE_STATES = new Set(['starting', 'searching', 'retrying']);

function cookieValue(header = '', name) {
  for (const part of String(header).split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return '';
}

function validSessionId(value) {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

export class SessionManager {
  #rootDir;
  #adapterFactory;
  #workerFactory;
  #contexts = new Map();
  #pendingContexts = new Map();
  #defaults;
  #initializePromise;

  constructor({ rootDir, adapterFactory, workerFactory, defaults = { account: null, autoJoin: null } }) {
    this.#rootDir = rootDir;
    this.#adapterFactory = adapterFactory;
    this.#workerFactory = workerFactory;
    this.#defaults = defaults;
    this.#initializePromise = this.#initialize();
  }

  async resolve(request, response) {
    await this.#initializePromise;
    let sessionId = cookieValue(request.headers?.cookie, COOKIE_NAME);
    if (!validSessionId(sessionId)) {
      sessionId = randomBytes(32).toString('base64url');
      response.setHeader('Set-Cookie', `${COOKIE_NAME}=${sessionId}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`);
    }
    const key = createHash('sha256').update(sessionId).digest('hex');
    if (this.#contexts.has(key)) return this.#contexts.get(key);
    if (this.#pendingContexts.has(key)) return this.#pendingContexts.get(key);

    const pending = this.#createContext(key).finally(() => this.#pendingContexts.delete(key));
    this.#pendingContexts.set(key, pending);
    return pending;
  }

  async #createContext(key) {
    const store = await JsonStore.open(join(this.#rootDir, `${key}.json`), this.#defaults);
    const adapter = this.#adapterFactory({ token: store.get().account?.token || '', store, sessionKey: key });
    const worker = this.#workerFactory({ adapter, store, sessionKey: key });
    const clients = new Set();
    const context = { sessionKey: key, store, adapter, worker, clients };
    this.#contexts.set(key, context);

    if (typeof worker.on === 'function') {
      worker.on('state', (state) => {
        store.update({ autoJoin: state }).catch(() => {});
        this.publish(context, 'status', state);
      });
      worker.on('matched', (raid) => this.publish(context, 'matched', raid));
    }

    const saved = store.get().autoJoin;
    if (!worker.restore?.(saved) && ACTIVE_STATES.has(saved?.state) && worker.recover) {
      try {
        await worker.recover({ profile: saved.profile, selection: saved.selection });
      } catch {
        // The browser can restart the search explicitly if upstream recovery fails.
      }
    }
    return context;
  }

  async #initialize() {
    await mkdir(this.#rootDir, { recursive: true, mode: 0o700 });
    await chmod(this.#rootDir, 0o700);
  }

  publish(context, event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of context.clients) client.write(payload);
  }

  async shutdown() {
    for (const context of this.#contexts.values()) context.worker.shutdown?.();
    this.#contexts.clear();
  }
}
