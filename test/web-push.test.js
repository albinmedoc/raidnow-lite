import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import {
  canonicalizePushSubscription,
  createPushNotifier,
  loadPushConfig,
  pushSubscriptionId
} from '../src/core/web-push.js';

const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const validSubscription = {
  endpoint: 'https://fcm.googleapis.com/send/abc',
  expirationTime: null,
  keys: {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: Buffer.alloc(16, 7).toString('base64url')
  }
};

test('push config is disabled only when every VAPID variable is absent', () => {
  assert.deepEqual(loadPushConfig({}), { enabled: false, publicKey: null, publicOrigin: null, vapid: null });
  assert.deepEqual(loadPushConfig({ PUBLIC_ORIGIN: 'https://raid.example.test' }), { enabled: false, publicKey: null, publicOrigin: 'https://raid.example.test', vapid: null });
  assert.throws(() => loadPushConfig({ VAPID_PUBLIC_KEY: 'public' }), /all be set/i);
  assert.throws(() => loadPushConfig({
    VAPID_PUBLIC_KEY: 'public', VAPID_PRIVATE_KEY: 'private', VAPID_SUBJECT: 'mailto:admin@example.test'
  }), /PUBLIC_ORIGIN/i);
  assert.throws(() => loadPushConfig({
    VAPID_PUBLIC_KEY: 'public', VAPID_PRIVATE_KEY: 'private', VAPID_SUBJECT: 'mailto:admin@example.test', PUBLIC_ORIGIN: 'http://example.test'
  }), /HTTPS/i);
  assert.deepEqual(loadPushConfig({
    VAPID_PUBLIC_KEY: 'public',
    VAPID_PRIVATE_KEY: 'private',
    VAPID_SUBJECT: 'mailto:admin@example.test',
    PUBLIC_ORIGIN: 'https://raid.example.test/'
  }), {
    enabled: true,
    publicKey: 'public',
    publicOrigin: 'https://raid.example.test',
    vapid: { publicKey: 'public', privateKey: 'private', subject: 'mailto:admin@example.test' }
  });
});

test('canonicalizes valid HTTPS push subscriptions and derives a non-secret stable id', () => {
  const canonical = canonicalizePushSubscription(validSubscription);
  assert.deepEqual(canonical, validSubscription);
  assert.match(pushSubscriptionId(canonical.endpoint), /^[a-f0-9]{32}$/);
  assert.equal(pushSubscriptionId(canonical.endpoint), pushSubscriptionId(canonical.endpoint));
});

test('push endpoint allowlist rejects SSRF and URL parser bypasses', () => {
  const accepted = [
    'https://FCM.GOOGLEAPIS.COM/send/a',
    'https://updates.push.services.mozilla.com/wpush/v2/a',
    'https://web.push.apple.com/Q123/a',
    'https://db5.notify.windows.com/w/?token=a'
  ];
  for (const endpoint of accepted) assert.doesNotThrow(() => canonicalizePushSubscription({ ...validSubscription, endpoint }));

  const rejected = [
    'https://localhost/push',
    'https://127.0.0.1/push',
    'https://[::1]/push',
    'https://10.0.0.1/push',
    'https://user@fcm.googleapis.com/push',
    'https://fcm.googleapis.com:444/push',
    'https://fcm.googleapis.com./push',
    'https://fcm.googleapis.com.evil.test/push',
    'https://evilfcm.googleapis.com/push',
    'https://%66cm.googleapis.com/push'
  ];
  for (const endpoint of rejected) {
    assert.throws(() => canonicalizePushSubscription({ ...validSubscription, endpoint }), /endpoint|host|HTTPS/i, endpoint);
  }
});

test('PUSH_ALLOWED_HOSTS supports validated additive and explicit override hosts', () => {
  const additive = loadPushConfig({ PUSH_ALLOWED_HOSTS: 'push.example.test' });
  assert.doesNotThrow(() => canonicalizePushSubscription({ ...validSubscription, endpoint: 'https://push.example.test/a' }, additive));
  assert.doesNotThrow(() => canonicalizePushSubscription(validSubscription, additive));

  const override = loadPushConfig({ PUSH_ALLOWED_HOSTS: '=push.example.test' });
  assert.doesNotThrow(() => canonicalizePushSubscription({ ...validSubscription, endpoint: 'https://push.example.test/a' }, override));
  assert.throws(() => canonicalizePushSubscription(validSubscription, override), /host/i);

  for (const value of ['localhost', '127.0.0.1', '10.0.0.1', '*.example.test', '.example.test', 'example.test.', 'a/b']) {
    assert.throws(() => loadPushConfig({ PUSH_ALLOWED_HOSTS: value }), /PUSH_ALLOWED_HOSTS/i, value);
  }
});

test('validates canonical Web Push key material and real prime256v1 points', () => {
  assert.deepEqual(canonicalizePushSubscription(validSubscription), validSubscription);
  const invalid = [
    { p256dh: Buffer.alloc(64, 1).toString('base64url'), auth: validSubscription.keys.auth },
    { p256dh: Buffer.concat([Buffer.from([3]), Buffer.alloc(64, 1)]).toString('base64url'), auth: validSubscription.keys.auth },
    { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 0)]).toString('base64url'), auth: validSubscription.keys.auth },
    { p256dh: `${validSubscription.keys.p256dh}=`, auth: validSubscription.keys.auth },
    { p256dh: validSubscription.keys.p256dh, auth: Buffer.alloc(15, 1).toString('base64url') },
    { p256dh: validSubscription.keys.p256dh, auth: `${validSubscription.keys.auth}=` }
  ];
  for (const keys of invalid) assert.throws(() => canonicalizePushSubscription({ ...validSubscription, keys }), /p256dh|auth/i);
});

test('rejects malformed, oversized, non-HTTPS, and non-canonical subscriptions', () => {
  assert.throws(() => canonicalizePushSubscription({ ...validSubscription, endpoint: 'http://push.example.test/send/abc' }), /HTTPS/i);
  assert.throws(() => canonicalizePushSubscription({ ...validSubscription, extra: true }), /shape/i);
  assert.throws(() => canonicalizePushSubscription({ ...validSubscription, keys: { ...validSubscription.keys, extra: 'x' } }), /shape/i);
  assert.throws(() => canonicalizePushSubscription({ ...validSubscription, endpoint: `https://push.example.test/${'x'.repeat(9000)}` }), /large|long/i);
  assert.throws(() => canonicalizePushSubscription({ ...validSubscription, keys: { p256dh: 'not base64!', auth: 'a'.repeat(22) } }), /p256dh/i);
});

test('push notifier uses a generic privacy-safe payload and bounded delivery options', async () => {
  const calls = [];
  const notifier = createPushNotifier({
    config: loadPushConfig({
      VAPID_PUBLIC_KEY: 'public', VAPID_PRIVATE_KEY: 'private', VAPID_SUBJECT: 'mailto:admin@example.test', PUBLIC_ORIGIN: 'https://raid.example.test'
    }),
    webPush: { async sendNotification(...args) { calls.push(args); } }
  });
  const result = await notifier.send(validSubscription);
  assert.deepEqual(result, { delivered: true, terminal: false, statusCode: null });
  assert.equal(calls.length, 1);
  const [subscription, payload, options] = calls[0];
  assert.deepEqual(subscription, validSubscription);
  assert.deepEqual(JSON.parse(payload), { title: 'Raid hittad', body: 'Öppna Raid NOW Lite för att se raiden.', url: '/' });
  assert.equal(payload.includes('Giratina'), false);
  assert.equal(payload.includes('123456789012'), false);
  assert.equal(options.TTL, 60);
  assert.equal(options.urgency, 'high');
  assert.equal(options.topic, 'raidnow-match');
  assert.equal(options.timeout, 10_000);
  assert.deepEqual(options.vapidDetails, {
    subject: 'mailto:admin@example.test', publicKey: 'public', privateKey: 'private'
  });
});

test('push notifier classifies only 404 and 410 as terminal without exposing error details', async () => {
  for (const [statusCode, terminal] of [[404, true], [410, true], [429, false], [503, false], [undefined, false]]) {
    const notifier = createPushNotifier({
      config: { enabled: true, publicKey: 'public', publicOrigin: 'https://raid.example.test', vapid: { publicKey: 'public', privateKey: 'private', subject: 'mailto:a@example.test' } },
      webPush: { async sendNotification() { throw Object.assign(new Error('secret endpoint response'), { statusCode, body: 'secret body' }); } }
    });
    assert.deepEqual(await notifier.send(validSubscription), { delivered: false, terminal, statusCode: statusCode ?? null });
  }
});
