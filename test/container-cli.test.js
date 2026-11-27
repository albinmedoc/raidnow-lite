import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const rootUrl = new URL('../', import.meta.url);
const cliRef = '1903356bc0533df16af900775f6f3eaa0ca98cb5';

test('container builds and verifies the exact pinned Raid NOW CLI source', async () => {
  const dockerfile = await readFile(new URL('Dockerfile', rootUrl), 'utf8');

  assert.match(dockerfile, new RegExp(`^ARG RAIDNOW_CLI_REF=${cliRef}$`, 'm'));
  assert.equal((dockerfile.match(/^ARG RAIDNOW_CLI_REF=/gm) ?? []).length, 1);
  assert.match(dockerfile, /^FROM golang:1\.27\.4-alpine AS raidnow-cli-builder$/m);
  assert.match(dockerfile, /git rev-parse HEAD/);
  assert.match(dockerfile, /go mod verify/);
  assert.match(dockerfile, /CGO_ENABLED=0/);
  assert.match(dockerfile, /-trimpath/);
  assert.match(dockerfile, /-X github\.com\/albinmedoc\/raidnow-cli\/internal\/cli\.Version=\$\{RAIDNOW_CLI_REF\}/);
  assert.doesNotMatch(dockerfile, /@latest/);
});

test('final Node Alpine image contains only the pinned CLI binary and verifies its JSON version', async () => {
  const dockerfile = await readFile(new URL('Dockerfile', rootUrl), 'utf8');

  assert.match(dockerfile, /^FROM node:22-alpine$/m);
  assert.match(dockerfile, /COPY --from=raidnow-cli-builder \/usr\/local\/bin\/raidnow \/usr\/local\/bin\/raidnow/);
  assert.match(dockerfile, /RAIDNOW_CLI_PATH=\/usr\/local\/bin\/raidnow/);
  assert.match(dockerfile, /\/usr\/local\/bin\/raidnow --json version/);
  assert.match(dockerfile, /\\"schemaVersion\\":1/);
  assert.match(dockerfile, /\\"command\\":\\"version\\"/);
  assert.match(dockerfile, /\\"status\\":\\"shown\\"/);
  assert.match(dockerfile, /\\"version\\":\\"\$\{RAIDNOW_CLI_REF\}\\"/);
  for (const command of ['history joined', 'history kicked', 'blocks list', 'host create', 'host status', 'host start', 'host kick', 'host close']) {
    assert.match(dockerfile, new RegExp(`/usr/local/bin/raidnow ${command} --help`));
  }

  const finalStage = dockerfile.slice(dockerfile.lastIndexOf('FROM node:22-alpine'));
  assert.doesNotMatch(finalStage, /apk add[^\n]*(?:git|go)|COPY --from=[^\n]+\/(?:go|src|root\/\.cache)/);
});

test('CI checks the pinned CLI version before the container health smoke', async () => {
  const workflow = await readFile(new URL('.github/workflows/ci.yml', rootUrl), 'utf8');
  const versionCheck = workflow.indexOf('raidnow --json version');
  const healthCheck = workflow.indexOf('/api/health');

  assert.ok(versionCheck >= 0, 'expected an in-container CLI version smoke');
  assert.ok(healthCheck > versionCheck, 'CLI version smoke must run before health smoke');
  assert.match(workflow, /expected_ref=.*RAIDNOW_CLI_REF/);
  assert.match(workflow, /\\"version\\":\\"\$\{expected_ref\}\\"/);
  assert.match(workflow, /\\"schemaVersion\\":1/);
  assert.match(workflow, /\\"command\\":\\"version\\"/);
  assert.match(workflow, /\\"status\\":\\"shown\\"/);
});
