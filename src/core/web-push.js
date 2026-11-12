import { createHash, ECDH } from 'node:crypto';
import { isIP } from 'node:net';

export const MAX_PUSH_SUBSCRIPTIONS = 4;
export const MAX_PUSH_SUBSCRIPTION_BYTES = 8_192;
const ENDPOINT_MAX_LENGTH = 4_096;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;
const DEFAULT_ALLOWED_HOSTS = Object.freeze([
  { hostname: 'fcm.googleapis.com', suffix: false },
  { hostname: 'updates.push.services.mozilla.com', suffix: false },
  { hostname: 'web.push.apple.com', suffix: false },
  { hostname: 'notify.windows.com', suffix: true }
]);

function validAllowedHostname(hostname) {
  return HOSTNAME.test(hostname) && hostname.includes('.') && /[a-z]/.test(hostname) && !isIP(hostname) && hostname !== 'localhost' &&
    !hostname.endsWith('.localhost') && !hostname.endsWith('.local') && !hostname.endsWith('.internal');
}

function pushAllowedHosts(value) {
  const input = String(value || '').trim();
  const override = input.startsWith('=');
  const custom = (override ? input.slice(1) : input).split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  for (const hostname of custom) {
    if (!validAllowedHostname(hostname)) throw new Error('PUSH_ALLOWED_HOSTS must contain only safe, exact hostnames.');
  }
  return override ? custom.map((hostname) => ({ hostname, suffix: false })) : [...DEFAULT_ALLOWED_HOSTS, ...custom.map((hostname) => ({ hostname, suffix: false }))];
}

function withAllowedHosts(config, env) {
  Object.defineProperty(config, 'allowedHosts', { value: pushAllowedHosts(env.PUSH_ALLOWED_HOSTS), enumerable: false });
  return config;
}

function decodeCanonicalBase64url(value, name) {
  if (typeof value !== 'string' || !BASE64URL.test(value)) throw new Error(`Invalid ${name} key.`);
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) throw new Error(`Invalid ${name} key.`);
  return decoded;
}

function allowedEndpointHost(hostname, rules) {
  return rules.some((rule) => hostname === rule.hostname || (rule.suffix && hostname.endsWith(`.${rule.hostname}`)));
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

export function loadPushConfig(env = process.env) {
  const publicKey = String(env.VAPID_PUBLIC_KEY || '').trim();
  const privateKey = String(env.VAPID_PRIVATE_KEY || '').trim();
  const subject = String(env.VAPID_SUBJECT || '').trim();
  const publicOriginInput = String(env.PUBLIC_ORIGIN || '').trim();
  if (!publicKey && !privateKey && !subject) {
    let publicOrigin = null;
    if (publicOriginInput) {
      try {
        const url = new URL(publicOriginInput);
        if (url.protocol !== 'https:') throw new Error('not HTTPS');
        publicOrigin = url.origin;
      } catch {
        throw new Error('PUBLIC_ORIGIN must be a valid HTTPS origin.');
      }
    }
    return withAllowedHosts({ enabled: false, publicKey: null, publicOrigin, vapid: null }, env);
  }
  if (!publicKey || !privateKey || !subject) throw new Error('VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT must all be set.');
  if (!publicOriginInput) throw new Error('PUBLIC_ORIGIN is required when Web Push is enabled.');
  if (!/^mailto:[^\s@]+@[^\s@]+$/i.test(subject) && !/^https:\/\//i.test(subject)) {
    throw new Error('VAPID_SUBJECT must be a mailto: or HTTPS URL.');
  }
  let origin;
  try {
    const url = new URL(publicOriginInput);
    if (url.protocol !== 'https:') throw new Error('not HTTPS');
    origin = url.origin;
  } catch {
    throw new Error('PUBLIC_ORIGIN must be a valid HTTPS origin.');
  }
  return withAllowedHosts({
    enabled: true,
    publicKey,
    publicOrigin: origin,
    vapid: { publicKey, privateKey, subject }
  }, env);
}

export function canonicalizePushSubscription(input, config = {}) {
  if (!exactKeys(input, ['endpoint', 'expirationTime', 'keys']) || !exactKeys(input.keys, ['auth', 'p256dh'])) {
    throw new Error('Push subscription must use the canonical shape.');
  }
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MAX_PUSH_SUBSCRIPTION_BYTES) throw new Error('Push subscription is too large.');
  if (typeof input.endpoint !== 'string' || input.endpoint.length > ENDPOINT_MAX_LENGTH) throw new Error('Push endpoint is too long.');
  let endpoint;
  try {
    const authority = input.endpoint.match(/^https:\/\/([^/?#]*)/i)?.[1] ?? '';
    if (authority.includes('%')) throw new Error('encoded authority');
    const url = new URL(input.endpoint);
    const hostname = url.hostname.toLowerCase();
    const bareHostname = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    const rules = config.allowedHosts ?? DEFAULT_ALLOWED_HOSTS;
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port ||
        hostname.endsWith('.') || isIP(bareHostname) || !validAllowedHostname(hostname) || !allowedEndpointHost(hostname, rules)) {
      throw new Error('invalid');
    }
    endpoint = url.href;
  } catch {
    throw new Error('Push endpoint hostname must be a valid allowed HTTPS Web Push provider.');
  }
  const expirationTime = input.expirationTime;
  if (expirationTime !== null && (!Number.isFinite(expirationTime) || expirationTime <= 0)) throw new Error('Invalid push expirationTime.');
  const p256dh = input.keys.p256dh;
  const auth = input.keys.auth;
  const publicKey = decodeCanonicalBase64url(p256dh, 'p256dh');
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) throw new Error('Invalid p256dh key.');
  try {
    ECDH.convertKey(publicKey, 'prime256v1');
  } catch {
    throw new Error('Invalid p256dh key.');
  }
  if (decodeCanonicalBase64url(auth, 'auth').length !== 16) throw new Error('Invalid auth key.');
  return { endpoint, expirationTime, keys: { p256dh, auth } };
}

export function pushSubscriptionId(endpoint) {
  return createHash('sha256').update(String(endpoint)).digest('hex').slice(0, 32);
}

export function raidNotificationMarker(raid) {
  const identity = raid?.rpl_id ?? raid?.id;
  if (identity === undefined || identity === null || String(identity) === '') return null;
  return createHash('sha256').update(String(identity)).digest('hex');
}

export function createPushNotifier({ config, webPush }) {
  if (config?.enabled && typeof webPush?.setVapidDetails === 'function') {
    webPush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);
  }
  return {
    enabled: Boolean(config?.enabled),
    publicConfig() {
      return { enabled: Boolean(config?.enabled), publicKey: config?.enabled ? config.publicKey : null };
    },
    canonicalizeSubscription(input) {
      return canonicalizePushSubscription(input, config);
    },
    async send(subscription) {
      if (!config?.enabled) return { delivered: false, terminal: false, statusCode: null, disabled: true };
      const payload = JSON.stringify({ title: 'Raid hittad', body: 'Öppna Raid NOW Lite för att se raiden.', url: '/' });
      try {
        await webPush.sendNotification(subscription, payload, {
          TTL: 60,
          urgency: 'high',
          topic: 'raidnow-match',
          timeout: 10_000,
          vapidDetails: {
            subject: config.vapid.subject,
            publicKey: config.vapid.publicKey,
            privateKey: config.vapid.privateKey
          }
        });
        return { delivered: true, terminal: false, statusCode: null };
      } catch (error) {
        const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : null;
        return { delivered: false, terminal: statusCode === 404 || statusCode === 410, statusCode };
      }
    }
  };
}
