import { CliCommandError } from '../adapters/cli-process-runner.js';

const WRITE_OPERATIONS = new Set(['createQueue', 'cancelQueue', 'joinRaid', 'leaveRaid']);
const DEFINITE_CLI_EXITS = new Set([2, 3, 4, 5, 6, 7]);
const CLI_REJECTION_PREFIX = /^Upstream avvisade begäran:\s*/i;

function freeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value) || seen.has(value)) return value;
  seen.add(value);
  for (const field of Object.values(value)) freeze(field, seen);
  return Object.freeze(value);
}

export class AdapterCapabilityError extends Error {
  constructor(message) {
    super(message);
    this.status = 501;
    this.code = 'AUTOJOIN_UNAVAILABLE';
    this.writeOutcome = 'not-dispatched';
  }
}

function rawMessage(error) {
  return error?.message || String(error);
}

function sanitizedMessage(value, operation) {
  let message = String(value ?? 'Unknown Auto Join error.')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim();
  const trainerCode = operation.input?.profile?.trainerCode;
  if (trainerCode) {
    const escapedTrainerCode = String(trainerCode).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    message = message.replace(new RegExp(`(^|[^A-Za-z0-9])${escapedTrainerCode}(?=$|[^A-Za-z0-9])`, 'g'), '$1[REDACTED]');
  }
  message = message.replace(/\b(?:gofriend_token|token)\s*[:=]\s*[^\s,;]+/gi, (match) => `${match.slice(0, match.search(/[:=]/) + 1)}[REDACTED]`);
  message = message.replace(/[A-Za-z0-9_-]{40,128}/g, '[REDACTED]');
  message = message.replace(/(^|[^A-Za-z0-9])(?:\d{12}|\d{4}(?:[ -]\d{4}){2})(?=$|[^A-Za-z0-9])/g, '$1[REDACTED]');
  return message.slice(0, 512);
}

function sanitizedDiagnosticString(value, maxLength) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/(^|[^A-Za-z0-9])(?:\d{12}|\d{4}(?:[ -]\d{4}){2})(?=$|[^A-Za-z0-9])/g, '$1[REDACTED]')
    .replace(/\b(?:gofriend[_-]?token|token|authorization|api[_-]?key|secret|trainer[_ -]?code)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, (match) => `${match.slice(0, match.search(/[:=]/) + 1)}[REDACTED]`)
    .replace(/[A-Za-z0-9_-]{40,128}/g, '[REDACTED]')
    .trim()
    .slice(0, maxLength);
}

function certainty(error) {
  if (error?.writeOutcome === 'not-dispatched') return 'not-dispatched';
  if (!(error instanceof CliCommandError)) return 'unknown';
  if (error.exitCode === 8) return 'not-dispatched';
  if (DEFINITE_CLI_EXITS.has(error.exitCode)) return 'definite';
  return 'unknown';
}

function rejectionPhrase(error, directText) {
  if (typeof directText === 'string') return directText.trim().replace(/\.\s*$/, '').trim().toLowerCase();
  if (!(error instanceof CliCommandError) || error.code !== 'UPSTREAM_REJECTION' || error.exitCode !== 7) return null;
  return rawMessage(error).replace(CLI_REJECTION_PREFIX, '').trim().replace(/\.\s*$/, '').trim().toLowerCase();
}

function rejectionReason(error, directText) {
  const phrase = rejectionPhrase(error, directText);
  if (phrase === 'the raid has been declared started and you cannot leave') return 'raidAlreadyStarted';
  if (phrase === 'the maximum number of participants has been exceeded. use auto join' || phrase === 'lobby is full') return 'lobbyFull';
  if (phrase === 'the host has declared the start of the raid and you cannot participate. use auto join') return 'lobbyStarted';
  return undefined;
}

function failure(operation, error, { directText, direct = false } = {}) {
  const upstreamMessage = !direct && error instanceof CliCommandError && error.code === 'UPSTREAM_REJECTION' && error.exitCode === 7
    ? rawMessage(error).replace(CLI_REJECTION_PREFIX, '')
    : rawMessage(error);
  const outcome = {
    ok: false,
    message: sanitizedMessage(direct ? directText : upstreamMessage, operation),
    certainty: direct ? 'definite' : certainty(error)
  };
  const reason = rejectionReason(error, directText);
  if (reason) outcome.reason = reason;
  if (typeof error?.code === 'string') outcome.code = error.code;
  else if (direct) outcome.code = 'UPSTREAM_REJECTION';
  if (Number.isInteger(error?.exitCode)) outcome.exitCode = error.exitCode;
  if (typeof error?.command === 'string') outcome.command = error.command;
  if (typeof error?.status === 'string' || Number.isFinite(error?.status)) outcome.status = error.status;
  return freeze(outcome);
}

export function normalizeAdapterSettlement(operation, settlement) {
  if (settlement.status === 'fulfilled') {
    const value = settlement.value;
    if (value && typeof value === 'object' && !Array.isArray(value) && value.status === 'error') {
      const directText = typeof value.text === 'string' ? value.text : 'Raid NOW rejected the request.';
      return failure(operation, value, { directText, direct: true });
    }
    return freeze({ ok: true, value: structuredClone(value) });
  }
  return failure(operation, settlement.reason);
}

export function reducerEventFromOutcome(operation, outcome) {
  if (outcome.ok) return freeze({ type: 'operationSucceeded', opId: operation.opId, value: outcome.value });
  const definite = !WRITE_OPERATIONS.has(operation.kind) || outcome.certainty !== 'unknown';
  return freeze({
    type: 'operationRejected',
    opId: operation.opId,
    error: outcome.message,
    code: outcome.code,
    status: outcome.status,
    definite,
    retryableLobbyJoin: outcome.reason === 'lobbyFull' || outcome.reason === 'lobbyStarted',
    blockLobbyJoin: outcome.reason === 'lobbyStarted',
    raidAlreadyStarted: outcome.reason === 'raidAlreadyStarted'
  });
}

export function diagnosticFieldsFromOutcome(outcome) {
  const fields = {
    result: outcome.ok ? 'succeeded' : 'rejected',
    writeOutcome: outcome.ok ? 'confirmed' : outcome.certainty
  };
  if (!outcome.ok) {
    fields.code = outcome.code ?? 'UNCLASSIFIED_ERROR';
    if (outcome.exitCode !== undefined) fields.exitCode = outcome.exitCode;
    if (outcome.command !== undefined) fields.command = outcome.command;
    if (outcome.status !== undefined) fields.status = outcome.status;
    fields.message = outcome.message;
    if (outcome.reason) fields.reason = outcome.reason;
  }
  return freeze(fields);
}

export function sanitizeDiagnosticEvent(event) {
  const sanitized = { ...event };
  const limits = { message: 512, raidId: 128, command: 256, code: 128, status: 128 };
  for (const [field, limit] of Object.entries(limits)) {
    if (typeof sanitized[field] === 'string') sanitized[field] = sanitizedDiagnosticString(sanitized[field], limit);
  }
  return freeze(sanitized);
}

export function isWriteOperation(kind) {
  return WRITE_OPERATIONS.has(kind);
}
