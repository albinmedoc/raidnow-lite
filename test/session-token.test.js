import test from 'node:test';
import assert from 'node:assert/strict';
import { access, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSessionToken } from '../src/adapters/session-token.js';

test('uses an existing regular token file without reading or bootstrapping it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-session-token-'));
  const tokenFile = join(root, `${'a'.repeat(64)}.token`);
  await writeFile(tokenFile, 'opaque\n', { mode: 0o644 });
  const runner = { async run() { throw new Error('must not run'); } };
  try {
    assert.equal(await ensureSessionToken({ runner, tokenFile }), tokenFile);
    assert.equal((await lstat(tokenFile)).mode & 0o777, 0o600);
    assert.equal(await readFile(tokenFile, 'utf8'), 'opaque\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bootstraps one valid token into an owner-only session file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-session-token-create-'));
  const tokenFile = join(root, `${'b'.repeat(64)}.token`);
  const calls = [];
  const runner = {
    async run(call) {
      calls.push(call);
      return { schemaVersion: 1, command: 'token get', status: 'secret', data: { containsSecret: true, token: 'opaque-value' }, warnings: [] };
    }
  };
  try {
    assert.equal(await ensureSessionToken({ runner, tokenFile }), tokenFile);
    assert.deepEqual(calls, [{ args: ['--json', 'token', 'get'] }]);
    assert.equal(await readFile(tokenFile, 'utf8'), 'opaque-value\n');
    assert.equal((await lstat(tokenFile)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(root), [`${'b'.repeat(64)}.token`]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects symlink token files without invoking the runner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-session-token-link-'));
  const target = join(root, 'target');
  const tokenFile = join(root, `${'c'.repeat(64)}.token`);
  await writeFile(target, 'opaque\n', { mode: 0o600 });
  await symlink(target, tokenFile);
  let calls = 0;
  try {
    await assert.rejects(
      ensureSessionToken({ runner: { async run() { calls += 1; } }, tokenFile }),
      (error) => error.code === 'SESSION_TOKEN_FILE' && !error.message.includes('opaque')
    );
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects bootstrap envelopes for the wrong command or status without creating a token file', async () => {
  const invalid = [
    { schemaVersion: 1, command: 'bosses list', status: 'secret', data: { containsSecret: true, token: 'opaque-value' }, warnings: [] },
    { schemaVersion: 1, command: 'token get', status: 'ok', data: { containsSecret: true, token: 'opaque-value' }, warnings: [] }
  ];
  for (let index = 0; index < invalid.length; index += 1) {
    const root = await mkdtemp(join(tmpdir(), 'raidnow-session-token-envelope-'));
    const tokenFile = join(root, `${index.toString(16).padStart(64, 'e')}.token`);
    try {
      await assert.rejects(
        ensureSessionToken({ runner: { async run() { return invalid[index]; } }, tokenFile }),
        (error) => error.code === 'SESSION_TOKEN_INVALID' && error.message === 'Session token is invalid.'
      );
      await assert.rejects(access(tokenFile));
      assert.deepEqual(await readdir(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('rejects invalid bootstrap data with sanitized errors and no file artifacts', async () => {
  const invalid = [
    null,
    {},
    { containsSecret: false, token: 'value' },
    { containsSecret: true, token: '' },
    { containsSecret: true, token: 'bad\nvalue' },
    { containsSecret: true, token: 'bad\u0085value' },
    { containsSecret: true, token: 'bad\u2028value' },
    { containsSecret: true, token: '\ud800' },
    { containsSecret: true, token: 'x'.repeat(4097) }
  ];
  for (let index = 0; index < invalid.length; index += 1) {
    const root = await mkdtemp(join(tmpdir(), 'raidnow-session-token-invalid-'));
    const tokenFile = join(root, `${index.toString(16).padStart(64, '0')}.token`);
    let calls = 0;
    try {
      await assert.rejects(
        ensureSessionToken({
          runner: { async run() { calls += 1; return { schemaVersion: 1, command: 'token get', status: 'secret', data: invalid[index], warnings: [] }; } },
          tokenFile
        }),
        (error) => error.code === 'SESSION_TOKEN_INVALID'
          && error.message === 'Session token is invalid.'
          && !error.message.includes('value')
      );
      assert.equal(calls, 1);
      await assert.rejects(access(tokenFile));
      assert.deepEqual(await readdir(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('does not overwrite a safe final file that appears during bootstrap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raidnow-session-token-race-'));
  const tokenFile = join(root, `${'d'.repeat(64)}.token`);
  const runner = {
    async run() {
      await writeFile(tokenFile, 'winner\n', { mode: 0o644 });
      return { schemaVersion: 1, command: 'token get', status: 'secret', data: { containsSecret: true, token: 'loser' }, warnings: [] };
    }
  };
  try {
    assert.equal(await ensureSessionToken({ runner, tokenFile }), tokenFile);
    assert.equal(await readFile(tokenFile, 'utf8'), 'winner\n');
    assert.equal((await lstat(tokenFile)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(root), [`${'d'.repeat(64)}.token`]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
