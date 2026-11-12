import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const publicUrl = new URL('../public/', import.meta.url);
const rootUrl = new URL('../', import.meta.url);

async function asset(name) {
  return readFile(new URL(name, publicUrl), 'utf8');
}

test('container configuration exposes secure Web Push settings without embedding secrets', async () => {
  const [dockerfile, compose, example] = await Promise.all([
    readFile(new URL('Dockerfile', rootUrl), 'utf8'),
    readFile(new URL('compose.yaml', rootUrl), 'utf8'),
    readFile(new URL('.env.example', rootUrl), 'utf8')
  ]);
  assert.match(dockerfile, /HOST=0\.0\.0\.0/);
  for (const name of ['HOST', 'PUBLIC_ORIGIN', 'RAIDNOW_COOKIE_SECURE', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'PUSH_ALLOWED_HOSTS']) {
    assert.match(compose, new RegExp(`${name}:`));
    assert.match(example, new RegExp(`^${name}=`, 'm'));
  }
  assert.match(example, /^VAPID_PRIVATE_KEY=$/m);
  assert.doesNotMatch(example, /BEGIN PRIVATE KEY|eyJ[A-Za-z0-9_-]+\./);
});

test('PWA manifest and HTML expose installable Swedish metadata and local icons', async () => {
  const [html, manifestSource, icon192, icon512, apple] = await Promise.all([
    asset('index.html'),
    asset('manifest.webmanifest'),
    readFile(new URL('icons/icon-192.png', publicUrl)),
    readFile(new URL('icons/icon-512.png', publicUrl)),
    readFile(new URL('icons/apple-touch-icon.png', publicUrl))
  ]);
  const manifest = JSON.parse(manifestSource);
  assert.equal(manifest.lang, 'sv');
  assert.equal(manifest.name, 'Raid NOW Lite');
  assert.equal(manifest.short_name, 'Raid NOW');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192' && icon.purpose.includes('maskable')));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512' && icon.purpose.includes('maskable')));
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png"/);
  for (const image of [icon192, icon512, apple]) assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(icon192.length > 1000);
  assert.ok(icon512.length > 1000);
});

test('service worker caches only an explicit shell and bypasses APIs, SSE, mutations, and external images', async () => {
  const source = await asset('service-worker.js');
  assert.match(source, /raidnow-shell-v2/);
  assert.match(source, /const SHELL_ASSETS = \[/);
  assert.match(source, /request\.method !== 'GET'/);
  assert.match(source, /url\.origin !== self\.location\.origin/);
  assert.match(source, /url\.pathname\.startsWith\('\/api\/'\)/);
  assert.match(source, /event\.respondWith\(networkFirstNavigation/);
  assert.match(source, /caches\.delete/);
  assert.doesNotMatch(source, /cache\.put\([^\n]*(api|events)/i);
});

test('notification setup requires a direct tap, registers push with the server, and includes iOS guidance', async () => {
  const [html, source] = await Promise.all([asset('index.html'), asset('app.js')]);
  assert.match(html, /iOS\/iPadOS 16\.4\+/);
  assert.match(html, /hemskärmen/i);
  assert.match(html, /id="installButton"/);
  assert.match(source, /beforeinstallprompt/);
  assert.match(source, /installPrompt\.prompt\(\)/);
  assert.match(source, /navigator\.serviceWorker\.register\('\/service-worker\.js'\)/);
  assert.match(source, /pushManager\.subscribe/);
  assert.match(source, /\/api\/push\/config/);
  assert.match(source, /\/api\/push\/subscriptions/);
  const click = source.indexOf("$('#notificationButton').addEventListener('click'");
  const permission = source.indexOf('Notification.requestPermission()');
  assert.ok(click >= 0 && permission > click);
  assert.doesNotMatch(source.slice(0, click), /Notification\.requestPermission/);
  assert.doesNotMatch(source, /new Notification\(/);
});

test('browser UI exposes local boss search, trainer identity, and safe reset controls', async () => {
  const html = await asset('index.html');
  assert.match(html, /id="bossSearch"/);
  assert.match(html, /id="trainerNameLabel"/);
  assert.match(html, /id="resetBrowser"/);
  assert.match(html, /Återställ denna webbläsare/);
  assert.match(html, /id="activeSelection"/);
});

test('browser app loads the full catalog and owns selection/reset lifecycle locally', async () => {
  const source = await asset('app.js');
  assert.match(source, /\/api\/raids\?rank=0/);
  assert.match(source, /reconcileSelection/);
  assert.match(source, /catalogForWorkerView/);
  assert.match(source, /active:\s*Boolean\(activeServerSelection\(\)\)/);
  assert.match(source, /nextStaleWarningCount/);
  assert.match(source, /staleWarningCount:\s*0/);
  assert.match(source, /loadRaids\(\{ dismissStaleWarning: true \}\)/);
  assert.match(source, /saveLocalSelection/);
  assert.match(source, /clearLocalSelection/);
  assert.match(source, /clearLocalProfile/);
  assert.match(source, /\/api\/session\/reset/);
  assert.match(source, /createBrowserResetController/);
  assert.match(source, /suspend:\s*closeBrowserResources/);
  assert.match(source, /resume:\s*resumeBrowserResources/);
  assert.match(source, /events\.close\(\)/);
});

test('live startup loads raids anonymously and only opens recovery after an upstream session error', async () => {
  const [html, source, serverSource] = await Promise.all([
    asset('index.html'),
    asset('app.js'),
    readFile(new URL('../src/app.js', import.meta.url), 'utf8')
  ]);
  const init = source.slice(source.indexOf('async function init()'));
  assert.match(init, /await loadProfile\(\);\s*await loadRaids\(\);/);
  assert.doesNotMatch(init, /config\.loggedIn[^\n]*loadRaids|connectionDialog[^\n]*showModal/);
  assert.match(source, /error\.status === 401[^\n]*connectionDialog[^\n]*showModal/);
  assert.doesNotMatch(serverSource, /hasToken[^\n]*return sendJson\(response, 401/);
  assert.doesNotMatch(html, /copy\(document\.querySelector/);
  assert.match(html, /<details[^>]*id="sessionPanel"/);
  assert.match(html, /diagnostik|avancerad återställning/i);
});

test('browser copy control exposes a selectable grouped code and safe fallback', async () => {
  const [html, source] = await Promise.all([asset('index.html'), asset('app.js')]);
  assert.match(html, /id="activeRaidCode"/);
  assert.match(html, /class="trainer-code"/);
  assert.match(source, /qr\?\.grouped/);
  assert.match(source, /const button = event\.currentTarget;/);
  assert.doesNotMatch(source, /await copyText\(code\);\s*\n\s*event\.currentTarget/);
  assert.match(source, /execCommand\('copy'\)/);
  assert.match(source, /Kopiering misslyckades.*markera koden/);
});

test('matched raid UI keeps copy and exposes an accessible local QR dialog', async () => {
  const [html, source] = await Promise.all([asset('index.html'), asset('app.js')]);
  assert.match(html, /id="copyCode"/);
  assert.match(html, /id="showQrCode"/);
  assert.match(html, />Visa QR-kod</);
  assert.match(html, /<dialog id="trainerCodeQrDialog"/);
  assert.match(html, /id="trainerCodeQrImage"/);
  assert.match(html, /id="trainerCodeQrFallback"/);
  assert.match(html, /id="copyQrCode"/);
  assert.match(source, /createTrainerCodeQrController/);
  assert.match(source, /setHostTrainerCode\(details\.raid\.rpl_code\)/);
  assert.match(source, /setHostTrainerCode\(status\.raid\.rpl_code\)/);
  assert.match(source, /setHostTrainerCode\(null\)/);
  assert.doesNotMatch(source, /state\.profile\.trainerCode[^\n]*createTrainerCodeQr/);
});

test('production files contain no external QR image service URL', async () => {
  const roots = [new URL('../public/', import.meta.url), new URL('../src/', import.meta.url)];
  const files = [];
  async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) await collect(url);
      else files.push(url);
    }
  }
  for (const root of roots) await collect(root);
  const production = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
  assert.doesNotMatch(production, /api\.qrserver\.com|quickchart\.io\/qr|chart\.googleapis\.com/i);
});

test('the vendored QR browser module is served with a JavaScript MIME type', async () => {
  const serverSource = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(serverSource, /'\.mjs':\s*'text\/javascript; charset=utf-8'/);
});

test('320px cascade keeps the toolbar within the viewport and trainer identity visible', async () => {
  const css = await asset('styles.css');
  const tabletRule = css.lastIndexOf('@media(max-width:800px)');
  const mobileRule = css.lastIndexOf('@media(max-width:520px)');

  assert.ok(tabletRule >= 0, 'expected a <=800px toolbar rule');
  assert.ok(mobileRule > tabletRule, 'the final <=520px rule must follow the final <=800px rule');

  const mobileCss = css.slice(mobileRule);
  assert.match(mobileCss, /\.toolbar\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(mobileCss, /\.toolbar>\*\{[^}]*min-width:0/);
  assert.match(mobileCss, /\.toolbar input\[type=search\],#rankFilter\{[^}]*width:100%[^}]*grid-column:1\/-1/);
  assert.match(mobileCss, /\.header-actions\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(mobileCss, /\.header-actions \.icon-text-button\{[^}]*min-width:0[^}]*overflow:hidden/);
  assert.match(mobileCss, /\.trainer-name\{[^}]*display:inline-block[^}]*min-width:12px[^}]*max-width:/);
  assert.doesNotMatch(mobileCss, /\.trainer-name\{[^}]*display:none/);
  assert.match(css, /\.trainer-code\{[^}]*user-select:text/);
});
