import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');

test('server wires one per-session CLI token adapter in live mode', () => {
  assert.match(source, /CliProcessRunner/);
  assert.match(source, /CliRaidNowAdapter/);
  assert.match(source, /ensureSessionToken/);
  assert.match(source, /RAIDNOW_CLI_PATH\s*\|\|\s*'\/usr\/local\/bin\/raidnow'/);
  assert.match(source, /adapterFactory:\s*async\s*\(\{\s*sessionKey\s*\}\)/);
  assert.match(source, /`\$\{sessionKey\}\.token`/);
  assert.match(source, /allowWrites:\s*liveWrites/);
  assert.match(source, /anonymousOnly:\s*mode\s*===\s*'live'/);
  assert.doesNotMatch(source, /\bRaidNowAdapter\b/);
  assert.doesNotMatch(source, /RAIDNOW_TOKEN|RAIDNOW_CSRF_TOKEN/);
});
