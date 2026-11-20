import { spawn } from 'node:child_process';

const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_STDIN_BYTES = 16 * 1024;
const MAX_ARGUMENTS = 256;
const MAX_STRING_BYTES = 4096;
const TERMINATION_GRACE_MS = 100;

export class CliRunnerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CliRunnerError';
    this.code = code;
  }
}

export class CliCommandError extends Error {
  constructor({ code, exitCode, command, status, message }) {
    super(message);
    this.name = 'CliCommandError';
    this.code = code;
    this.exitCode = exitCode;
    this.command = command;
    this.status = status;
    this.writeOutcomeUnknown = exitCode === 9;
  }
}

function invalidInput() {
  return new CliRunnerError('CLI_INVALID_INPUT', 'Invalid CLI runner input.');
}

function validateString(value, { allowEmpty = true } = {}) {
  if (typeof value !== 'string'
    || (!allowEmpty && value.length === 0)
    || value.includes('\0')
    || Buffer.byteLength(value) > MAX_STRING_BYTES) {
    throw invalidInput();
  }
  return value;
}

function validateArguments(value) {
  if (!Array.isArray(value) || value.length > MAX_ARGUMENTS) throw invalidInput();
  return value.map((argument) => validateString(argument));
}

function validatePositiveInteger(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw invalidInput();
  return value;
}

function validateStdin(stdin) {
  if (stdin === null || stdin === undefined) return null;
  if (typeof stdin !== 'string' && !Buffer.isBuffer(stdin)) throw invalidInput();
  if (Buffer.byteLength(stdin) > MAX_STDIN_BYTES) throw invalidInput();
  return stdin;
}

function abortError(signal) {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}

function protocolError() {
  return new CliRunnerError('CLI_PROTOCOL_ERROR', 'The CLI returned an invalid response.');
}

function execError() {
  return new CliRunnerError('CLI_EXEC_ERROR', 'The CLI process could not be executed.');
}

function parseEnvelope(stdout) {
  let envelope;
  try {
    envelope = JSON.parse(stdout.toString('utf8').trim());
  } catch {
    throw protocolError();
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
    || envelope.schemaVersion !== 1
    || typeof envelope.ok !== 'boolean'
    || typeof envelope.command !== 'string'
    || typeof envelope.status !== 'string'
    || envelope.command.length === 0
    || envelope.status.length === 0
    || envelope.command.includes('\0')
    || envelope.status.includes('\0')) {
    throw protocolError();
  }
  if (envelope.ok) {
    if (!Object.hasOwn(envelope, 'data') || !Array.isArray(envelope.warnings)) {
      throw protocolError();
    }
  } else if (!envelope.error || typeof envelope.error !== 'object'
    || Array.isArray(envelope.error)
    || typeof envelope.error.code !== 'string'
    || envelope.error.code.length === 0
    || typeof envelope.error.message !== 'string'
    || envelope.error.message.length === 0) {
    throw protocolError();
  }
  return envelope;
}

function safeEnvelopeString(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!sanitized) return fallback;
  return sanitized.slice(0, 512);
}

export class CliProcessRunner {
  #executable;
  #baseArgs;
  #maxOutputBytes;
  #defaultTimeoutMs;

  constructor({
    executable,
    baseArgs = [],
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    defaultTimeoutMs = DEFAULT_TIMEOUT_MS
  } = {}) {
    this.#executable = validateString(executable, { allowEmpty: false });
    this.#baseArgs = validateArguments(baseArgs);
    this.#maxOutputBytes = validatePositiveInteger(maxOutputBytes);
    this.#defaultTimeoutMs = validatePositiveInteger(defaultTimeoutMs);
  }

  async run({ args = [], stdin = null, signal, timeoutMs } = {}) {
    const invocationArgs = validateArguments(args);
    const input = validateStdin(stdin);
    const timeout = timeoutMs === undefined
      ? this.#defaultTimeoutMs
      : validatePositiveInteger(timeoutMs);
    if (signal !== undefined
      && (!signal || typeof signal.aborted !== 'boolean'
        || typeof signal.addEventListener !== 'function'
        || typeof signal.removeEventListener !== 'function')) {
      throw invalidInput();
    }
    if (signal?.aborted) throw abortError(signal);

    return new Promise((resolve, reject) => {
      let child;
      let timeoutTimer;
      let killTimer;
      let pendingError = null;
      let closed = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const stdout = [];

      const requestTermination = (error) => {
        if (pendingError || closed) return;
        pendingError = error;
        if (child?.pid) {
          child.kill('SIGTERM');
          killTimer = setTimeout(() => {
            if (!closed) child.kill('SIGKILL');
          }, TERMINATION_GRACE_MS);
          killTimer.unref?.();
        }
      };

      const onAbort = () => requestTermination(abortError(signal));
      const cleanup = () => {
        clearTimeout(timeoutTimer);
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', onAbort);
      };

      try {
        child = spawn(this.#executable, [...this.#baseArgs, ...invocationArgs], {
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch {
        reject(execError());
        return;
      }

      timeoutTimer = setTimeout(() => {
        requestTermination(new CliRunnerError('CLI_TIMEOUT', 'The CLI process timed out.'));
      }, timeout);
      timeoutTimer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });

      const capture = (streamName, chunks = null) => (chunk) => {
        const length = chunk.length;
        if (streamName === 'stdout') stdoutBytes += length;
        else stderrBytes += length;
        const total = streamName === 'stdout' ? stdoutBytes : stderrBytes;
        if (total > this.#maxOutputBytes) {
          requestTermination(new CliRunnerError('CLI_OUTPUT_LIMIT', 'The CLI output limit was exceeded.'));
          return;
        }
        if (!pendingError && chunks) chunks.push(chunk);
      };

      child.stdout.on('data', capture('stdout', stdout));
      child.stderr.on('data', capture('stderr'));
      child.stdin.on('error', () => {});
      child.on('error', () => requestTermination(execError()));
      child.on('close', (exitCode, exitSignal) => {
        closed = true;
        cleanup();
        if (pendingError) {
          reject(pendingError);
          return;
        }
        if (exitSignal || exitCode === null) {
          reject(execError());
          return;
        }
        if (stderrBytes !== 0) {
          reject(protocolError());
          return;
        }

        let envelope;
        try {
          envelope = parseEnvelope(Buffer.concat(stdout));
        } catch (error) {
          reject(error);
          return;
        }

        if (exitCode === 0) {
          if (!envelope.ok) {
            reject(protocolError());
            return;
          }
          resolve(envelope);
          return;
        }

        if (envelope.ok) {
          reject(protocolError());
          return;
        }
        reject(new CliCommandError({
          code: safeEnvelopeString(envelope.error.code, 'CLI_COMMAND_FAILED'),
          exitCode,
          command: envelope.command,
          status: envelope.status,
          message: safeEnvelopeString(envelope.error.message, 'CLI command failed.')
        }));
      });

      child.stdin.end(input ?? undefined);
    });
  }
}
