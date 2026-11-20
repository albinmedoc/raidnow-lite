import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CliCommandError,
  CliProcessRunner,
  CliRunnerError
} from '../src/adapters/cli-process-runner.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-raidnow-cli.js', import.meta.url));

function createRunner(options = {}) {
  return new CliProcessRunner({
    executable: process.execPath,
    baseArgs: [fixture],
    maxOutputBytes: 1024,
    defaultTimeoutMs: 500,
    ...options
  });
}

test('returns a valid successful CLI envelope', async () => {
  const result = await createRunner().run({ args: ['success', 'value'] });
  assert.equal(result.ok, true);
  assert.equal(result.schemaVersion, 1);
  assert.deepEqual(result.data.args, ['value']);
  assert.deepEqual(result.warnings, []);
});

test('accepts a success envelope whose required data value is null', async () => {
  const result = await createRunner().run({ args: ['success-null-data'] });
  assert.ok(Object.hasOwn(result, 'data'));
  assert.equal(result.data, null);
});

test('throws safe typed command fields from a valid nested failure error', async () => {
  await assert.rejects(
    () => createRunner().run({ args: ['failure'] }),
    (error) => {
      assert.ok(error instanceof CliCommandError);
      assert.equal(error.code, 'RAID_REJECTED');
      assert.equal(error.exitCode, 7);
      assert.equal(error.command, 'failure');
      assert.equal(error.status, 'rejected');
      assert.equal(error.writeOutcomeUnknown, false);
      assert.equal(error.message, 'Command was rejected.');
      return true;
    }
  );
});

test('marks exit code 9 command failures as an unknown write outcome', async () => {
  await assert.rejects(
    () => createRunner().run({ args: ['uncertain'] }),
    (error) => error instanceof CliCommandError
      && error.exitCode === 9
      && error.writeOutcomeUnknown === true
  );
});

for (const mode of ['malformed', 'two-json', 'trailing', 'wrong-schema', 'wrong-shape']) {
  test(`rejects ${mode} output as a sanitized protocol error`, async () => {
    await assert.rejects(
      () => createRunner().run({ args: [mode] }),
      (error) => error instanceof CliRunnerError
        && error.code === 'CLI_PROTOCOL_ERROR'
        && !error.message.includes('not json')
    );
  });
}

for (const mode of ['failure-exit-zero', 'success-exit-nonzero']) {
  test(`rejects inconsistent ${mode} exit and envelope state`, async () => {
    await assert.rejects(
      () => createRunner().run({ args: [mode] }),
      (error) => error instanceof CliRunnerError && error.code === 'CLI_PROTOCOL_ERROR'
    );
  });
}

for (const mode of ['success-missing-data', 'success-missing-warnings', 'success-invalid-warnings']) {
  test(`rejects malformed success envelope ${mode}`, async () => {
    await assert.rejects(
      () => createRunner().run({ args: [mode] }),
      (error) => error instanceof CliRunnerError && error.code === 'CLI_PROTOCOL_ERROR'
    );
  });
}

for (const mode of ['failure-missing-error', 'failure-array-error', 'failure-invalid-code', 'failure-invalid-message']) {
  test(`rejects malformed failure envelope ${mode}`, async () => {
    await assert.rejects(
      () => createRunner().run({ args: [mode] }),
      (error) => error instanceof CliRunnerError && error.code === 'CLI_PROTOCOL_ERROR'
    );
  });
}

test('rejects success output that also writes stderr without exposing stderr', async () => {
  await assert.rejects(
    () => createRunner().run({ args: ['success-stderr'] }),
    (error) => error.code === 'CLI_PROTOCOL_ERROR'
      && !error.message.includes('diagnostic secret')
  );
});

test('rejects a valid nonzero failure that writes stderr without exposing stderr', async () => {
  await assert.rejects(
    () => createRunner().run({ args: ['failure-stderr'] }),
    (error) => error instanceof CliRunnerError
      && error.code === 'CLI_PROTOCOL_ERROR'
      && !error.message.includes('failure diagnostic secret')
  );
});

test('rejects stdout and stderr independently when either exceeds the limit', async () => {
  for (const mode of ['stdout-overflow', 'stderr-overflow']) {
    await assert.rejects(
      () => createRunner({ maxOutputBytes: 32 }).run({ args: [mode, '128'] }),
      (error) => error.code === 'CLI_OUTPUT_LIMIT' && !error.message.includes('xxxxx')
    );
  }
});

test('sanitizes spawn failures', async () => {
  const missing = path.join(os.tmpdir(), `missing-raidnow-${process.pid}`);
  await assert.rejects(
    () => createRunner({ executable: missing, baseArgs: [] }).run({ args: ['secret-path'] }),
    (error) => error.code === 'CLI_EXEC_ERROR'
      && !error.message.includes(missing)
      && !error.message.includes('secret-path')
  );
});

test('times out and terminates a hung child', async () => {
  const started = Date.now();
  await assert.rejects(
    () => createRunner().run({ args: ['sleep', '1000'], timeoutMs: 30 }),
    (error) => error.code === 'CLI_TIMEOUT'
  );
  assert.ok(Date.now() - started < 500);
});

test('aborts promptly and preserves an Error abort reason', async () => {
  const controller = new AbortController();
  const reason = new Error('worker stopped');
  const pending = createRunner().run({ args: ['sleep', '1000'], signal: controller.signal });
  setTimeout(() => controller.abort(reason), 20);
  await assert.rejects(pending, (error) => error === reason);
});

test('uses a generic AbortError for a non-Error abort reason', async () => {
  const controller = new AbortController();
  controller.abort('stop');
  await assert.rejects(
    () => createRunner().run({ args: ['sleep', '1000'], signal: controller.signal }),
    (error) => error.name === 'AbortError' && !error.message.includes('stop')
  );
});

test('writes bounded stdin once, closes it, and never exposes it in errors', async () => {
  const secret = 'trainer-code-secret';
  const result = await createRunner().run({ args: ['stdin'], stdin: Buffer.from(secret) });
  assert.equal(result.data.input, secret);
  await assert.rejects(
    () => createRunner().run({ args: ['stdin-failure'], stdin: secret }),
    (error) => error.code === 'CLI_PROTOCOL_ERROR' && !error.message.includes(secret)
  );
});

test('rejects invalid constructor and invocation values locally', async () => {
  for (const create of [
    () => new CliProcessRunner({ executable: '' }),
    () => new CliProcessRunner({ executable: 'bad\0path' }),
    () => new CliProcessRunner({ executable: process.execPath, baseArgs: ['bad\0arg'] }),
    () => new CliProcessRunner({ executable: process.execPath, maxOutputBytes: 0 }),
    () => new CliProcessRunner({ executable: process.execPath, defaultTimeoutMs: 0 })
  ]) {
    assert.throws(create, (error) => error instanceof CliRunnerError && error.code === 'CLI_INVALID_INPUT');
  }
  const runner = createRunner();
  await assert.rejects(() => runner.run({ args: ['bad\0arg'] }), (error) => error.code === 'CLI_INVALID_INPUT');
  await assert.rejects(() => runner.run({ args: ['success'], stdin: 'x'.repeat(16 * 1024 + 1) }), (error) => error.code === 'CLI_INVALID_INPUT');
  await assert.rejects(() => runner.run({ args: ['success'], timeoutMs: 0 }), (error) => error.code === 'CLI_INVALID_INPUT');
});

test('passes argv literally without shell interpretation', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'raidnow-runner-'));
  const marker = path.join(directory, 'shell-marker');
  const shellText = `$(touch ${marker})`;
  try {
    const result = await createRunner().run({ args: ['success', shellText] });
    assert.equal(result.data.args[0], shellText);
    await assert.rejects(fs.access(marker));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
