import process from 'node:process';

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

switch (mode) {
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
