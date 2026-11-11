import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class JsonStore {
  #path;
  #state;
  #writeQueue = Promise.resolve();

  static async open(path, defaults = {}) {
    await mkdir(dirname(path), { recursive: true });
    let state = structuredClone(defaults);
    try {
      state = { ...state, ...JSON.parse(await readFile(path, 'utf8')) };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const store = new JsonStore(path, state);
    await store.#persist();
    return store;
  }

  constructor(path, state) {
    this.#path = path;
    this.#state = state;
  }

  get() {
    return structuredClone(this.#state);
  }

  async update(patch) {
    this.#state = { ...this.#state, ...structuredClone(patch) };
    this.#writeQueue = this.#writeQueue.then(() => this.#persist());
    await this.#writeQueue;
    return this.get();
  }

  async #persist() {
    const temporary = `${this.#path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.#state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.#path);
  }
}
