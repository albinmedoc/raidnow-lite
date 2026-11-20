import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const [mode, ...args] = process.argv.slice(2);

if (!mode) process.exit(0);

function successEnvelope(overrides = {}) {
  return {
    schemaVersion: 1,
    ok: true,
    command: mode,
    status: 'success',
    data: { args },
    warnings: [],
    ...overrides
  };
}

function failureEnvelope(overrides = {}) {
  return {
    schemaVersion: 1,
    ok: false,
    command: mode,
    status: 'failed',
    error: {
      code: 'CLI_COMMAND_FAILED',
      message: 'CLI command failed.'
    },
    ...overrides
  };
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function serviceSuccess(command, status, data) {
  writeJson({ schemaVersion: 1, ok: true, command, status, data, warnings: [] });
}

function serviceFailure(command, code, message, exitCode) {
  writeJson({ schemaVersion: 1, ok: false, command, status: 'failed', error: { code, message } });
  process.exitCode = exitCode;
}

function sameArgs(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

async function readStdin(limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size <= limit) chunks.push(chunk);
  }
  return size <= limit ? Buffer.concat(chunks).toString('utf8') : null;
}

async function runService(argv) {
  if (sameArgs(argv, ['--json', 'token', 'get'])) {
    serviceSuccess('token get', 'secret', {
      token: `anonymous-${randomBytes(24).toString('base64url')}`,
      containsSecret: true
    });
    return;
  }

  if (argv[0] !== '--json' || argv[1] !== '--token-file' || !argv[2]) {
    serviceFailure('unknown', 'INVALID_ARGUMENTS', 'Invalid command arguments.', 2);
    return;
  }
  const tokenFile = argv[2];
  const commandArgs = argv.slice(3);
  try {
    if (!(await readFile(tokenFile, 'utf8')).trim()) throw new Error('empty token');
  } catch {
    serviceFailure('unknown', 'INVALID_ARGUMENTS', 'Invalid command arguments.', 2);
    return;
  }
  const command = commandArgs.slice(0, 2).join(' ');

  switch (command) {
    case 'bosses list':
      if (!sameArgs(commandArgs, ['bosses', 'list'])) break;
      serviceSuccess(command, 'listed', [{
        rank: '5', pokemonId: '487', pokemonName: 'Giratina',
        imageUrl: 'https://example.test/giratina.png', waitingCount: 7
      }]);
      return;
    case 'queue check':
      if (!sameArgs(commandArgs, ['queue', 'check', '--pokemon', '487'])) break;
      serviceSuccess(command, 'absent', { present: false, waiting: [] });
      return;
    case 'queue join':
      if (!sameArgs(commandArgs, [
        'queue', 'join', '--rank', '5', '--pokemon', '487',
        '--trainer-name', 'ProcessUser', '--trainer-level', '50', '--trainer-country', 'se',
        '--trainer-code-file', '-', '--guest-score', '', '--min-host-rating', '3',
        '--host-country', '0', '--weather-boost', '0', '--host-level', '0'
      ])) break;
      if (await readStdin(64) !== '123456789012') break;
      serviceSuccess(command, 'created', { created: true });
      return;
    case 'queue status':
      if (!sameArgs(commandArgs, ['queue', 'status', '--rank', '5', '--pokemon', '487'])) break;
      serviceSuccess(command, 'matched', { state: 'matched', raidId: 'raid-process-1' });
      return;
    case 'lobbies list':
      if (!sameArgs(commandArgs, [
        'lobbies', 'list', '--page', '1', '--rank', '5', '--host-level', '0',
        '--min-host-rating', '3', '--include-metadata=false'
      ])) break;
      serviceSuccess(command, 'listed', [{
        id: 'raid-process-1', rank: '5', pokemonId: '487', hostName: 'FixtureHost',
        hostLevel: 48, country: 'se', weather: 2, maxUsers: 10, count: 3,
        readyCount: 2, joinState: 1, deleted: false, isMe: false, minimumGuestLevel: 40
      }]);
      return;
    case 'queue cancel':
      if (!sameArgs(commandArgs, ['queue', 'cancel', '--verify=false'])) break;
      serviceSuccess(command, 'requested', { requested: true, verified: false });
      return;
    case 'raid players':
      if (!sameArgs(commandArgs, ['raid', 'players', '--raid-id', 'raid-process-1'])) break;
      serviceSuccess(command, 'listed', {
        players: [{
          id: 'player-process-1', trainerName: 'ZeroRated', level: 50,
          country: 'se', rating: 0, ready: false, isMe: true
        }],
        count: 1,
        readyCount: 0,
        raidDeleted: false
      });
      return;
    case 'raid leave':
      if (!sameArgs(commandArgs, ['raid', 'leave', '--raid-id', 'raid-process-1', '--verify=false'])) break;
      serviceSuccess(command, 'requested', { requested: true, verified: false, raidId: 'raid-process-1' });
      return;
    case 'raid get':
      if (!sameArgs(commandArgs, ['raid', 'get', '--raid-id', 'raid-process-1'])) break;
      serviceFailure(command, 'NOT_FOUND', 'Raid was not found.', 5);
      return;
  }
  serviceFailure('unknown', 'INVALID_ARGUMENTS', 'Invalid command arguments.', 2);
}

switch (mode) {
  case 'service':
    await runService(args);
    break;
  case 'success':
    writeJson(successEnvelope());
    break;
  case 'success-null-data':
    writeJson(successEnvelope({ data: null }));
    break;
  case 'failure':
    writeJson(failureEnvelope({
      status: 'rejected',
      error: { code: ' RAID_REJECTED\u0000 ', message: ' Command was\nrejected. ' }
    }));
    process.exitCode = 7;
    break;
  case 'uncertain':
    writeJson(failureEnvelope({
      status: 'unknown',
      error: { code: 'WRITE_UNKNOWN', message: 'Write outcome is unknown.' }
    }));
    process.exitCode = 9;
    break;
  case 'malformed':
    process.stdout.write('{not json}\n');
    break;
  case 'two-json':
    writeJson(successEnvelope());
    writeJson(successEnvelope());
    break;
  case 'trailing':
    process.stdout.write(`${JSON.stringify(successEnvelope())} trailing\n`);
    break;
  case 'wrong-schema':
    writeJson(successEnvelope({ schemaVersion: 2 }));
    break;
  case 'wrong-shape':
    writeJson({ schemaVersion: 1, ok: 'yes', command: mode, status: 'success' });
    break;
  case 'failure-exit-zero':
    writeJson(failureEnvelope({
      status: 'rejected',
      error: { code: 'BAD_STATE', message: 'Inconsistent result.' }
    }));
    break;
  case 'success-exit-nonzero':
    writeJson(successEnvelope());
    process.exitCode = 3;
    break;
  case 'success-missing-data': {
    const value = successEnvelope();
    delete value.data;
    writeJson(value);
    break;
  }
  case 'success-missing-warnings': {
    const value = successEnvelope();
    delete value.warnings;
    writeJson(value);
    break;
  }
  case 'success-invalid-warnings':
    writeJson(successEnvelope({ warnings: {} }));
    break;
  case 'failure-missing-error': {
    const value = failureEnvelope();
    delete value.error;
    writeJson(value);
    process.exitCode = 7;
    break;
  }
  case 'failure-array-error':
    writeJson(failureEnvelope({ error: [] }));
    process.exitCode = 7;
    break;
  case 'failure-invalid-code':
    writeJson(failureEnvelope({ error: { code: '', message: 'Failed.' } }));
    process.exitCode = 7;
    break;
  case 'failure-invalid-message':
    writeJson(failureEnvelope({ error: { code: 'FAILED', message: 42 } }));
    process.exitCode = 7;
    break;
  case 'stdout-overflow':
    process.stdout.write('x'.repeat(Number(args[0] || 1024)));
    break;
  case 'stderr-overflow':
    process.stderr.write('x'.repeat(Number(args[0] || 1024)));
    break;
  case 'success-stderr':
    process.stderr.write('diagnostic secret\n');
    writeJson(successEnvelope());
    break;
  case 'failure-stderr':
    process.stderr.write('failure diagnostic secret\n');
    writeJson(failureEnvelope({ error: { code: 'FAILED', message: 'Failed.' } }));
    process.exitCode = 7;
    break;
  case 'sleep':
    setTimeout(() => writeJson(successEnvelope()), Number(args[0] || 1000));
    break;
  case 'stdin': {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      const input = Buffer.concat(chunks).toString('utf8');
      writeJson(successEnvelope({ data: { input } }));
    });
    break;
  }
  case 'stdin-failure':
    process.stdin.resume();
    process.stdin.on('end', () => {
      process.stdout.write('{not json}\n');
    });
    break;
  default:
    writeJson(successEnvelope({ data: { args: [mode, ...args] } }));
}
