import { randomBytes } from 'node:crypto';
import { chmod, link, lstat, open, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const MAX_TOKEN_BYTES = 4096;

function sessionTokenError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function fileError() {
  return sessionTokenError('SESSION_TOKEN_FILE', 'Session token file is invalid.');
}

function invalidToken() {
  return sessionTokenError('SESSION_TOKEN_INVALID', 'Session token is invalid.');
}

function validUnicodeString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validateToken(value) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_TOKEN_BYTES
    || !validUnicodeString(value) || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) {
    throw invalidToken();
  }
  return value;
}

async function secureExisting(tokenFile) {
  let info;
  try {
    info = await lstat(tokenFile);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw fileError();
  }
  if (!info.isFile()) throw fileError();
  try {
    await chmod(tokenFile, 0o600);
  } catch {
    throw fileError();
  }
  return true;
}

export async function ensureSessionToken({ runner, tokenFile } = {}) {
  if (!runner || typeof runner.run !== 'function' || typeof tokenFile !== 'string' || tokenFile.length === 0) {
    throw fileError();
  }
  if (await secureExisting(tokenFile)) return tokenFile;

  let envelope;
  try {
    envelope = await runner.run({ args: ['--json', 'token', 'get'] });
  } catch {
    throw invalidToken();
  }
  if (envelope?.command !== 'token get' || envelope?.status !== 'secret'
    || !envelope.data || typeof envelope.data !== 'object' || Array.isArray(envelope.data)
    || envelope.data.containsSecret !== true) {
    throw invalidToken();
  }
  const token = validateToken(envelope.data.token);
  const tempFile = join(dirname(tokenFile), `${basename(tokenFile)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await open(tempFile, 'wx', 0o600);
    await handle.writeFile(`${token}\n`, 'utf8');
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await link(tempFile, tokenFile);
    } catch (error) {
      if (error?.code !== 'EEXIST' || !await secureExisting(tokenFile)) throw fileError();
    }
    await unlink(tempFile);
    return tokenFile;
  } catch (error) {
    try { await handle?.close(); } catch {}
    try { await unlink(tempFile); } catch {}
    if (error?.code === 'SESSION_TOKEN_FILE') throw error;
    throw fileError();
  }
}
