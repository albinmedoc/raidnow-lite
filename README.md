# Raid NOW Lite

A small, self-hosted, mobile-friendly client for Raid NOW. It keeps raid searching in the Node.js process instead of tying it to an open or focused browser tab.

> [!WARNING]
> This is an unofficial community project. It is not affiliated with, endorsed by, or supported by Raid NOW, Leek Duck, Niantic, or The Pokémon Company. Upstream APIs are undocumented and may change without notice. Review the code and the upstream service rules before enabling live writes.

## Features

- Lists the full currently selectable Auto Join boss pool.
- Works anonymously by default; browsing the boss catalog does not require an account, token, or DevTools copy command.
- Loads Pokémon display names and images from Raid NOW's own page metadata instead of maintaining a local Japanese-to-English mapping.
- Selects one or several raid bosses from a compact responsive interface.
- Runs a fixed hybrid search strategy:
  - creates a normal Auto Join queue entry; and
  - scans suitable live lobbies once per second for a faster direct join.
- Keeps searching in the server process when the page is closed.
- Shows search state, matched raid, host, players, levels, ready state, and trainer code with both copy and a scannable QR view.
- Supports leaving an active raid after confirmation.
- Isolates every browser with a random `HttpOnly`, `SameSite=Strict` session cookie.
- Uses separate tokens, workers, search state, active raids, SSE clients, and state files per browser session.
- Stores the permanent trainer profile in that browser's `localStorage`.
- Includes a deterministic demo mode that performs no live Raid NOW writes.
- Installs as a private PWA and supports per-browser-session Web Push when served over HTTPS.

## Requirements

Choose one of the following:

- Docker with Docker Compose, or
- Node.js 22 or newer.

## Quick start with Docker Compose

```bash
git clone https://github.com/albinmedoc/raidnow-lite.git
cd raidnow-lite
cp .env.example .env
docker compose up -d
```

Open `http://localhost:4173`.

The included Compose configuration starts in **demo mode** and persists session state in a named volume.

### Use the published image directly

```bash
docker run -d \
  --name raidnow-lite \
  --restart unless-stopped \
  -p 4173:4173 \
  -e RAIDNOW_MODE=demo \
  -v raidnow-data:/app/data \
  ghcr.io/albinmedoc/raidnow-lite:latest
```

Images are published for `linux/amd64` and `linux/arm64` when a GitHub release is published.

## Run with Node.js

The application uses the pinned `web-push` runtime dependency. QR generation uses a vendored, pinned copy of the MIT-licensed `qrcode-generator` 2.0.4 browser module. Its attribution and license are included under `public/vendor/qrcode-generator/`.

```bash
npm test
npm start
```

The default address outside Docker is `http://127.0.0.1:4173`.

## Operating modes

### Demo mode

Demo mode is the default and is safe for UI and deployment testing.

```bash
RAIDNOW_MODE=demo npm start
```

- Uses deterministic local data.
- Simulates matching.
- Does not perform live Raid NOW writes.

### Live read-only mode

```bash
RAIDNOW_MODE=live npm start
```

This reads supported upstream data anonymously by default but blocks Auto Join and other mutating operations. No account login or token import is required to load the boss catalog.

### Live mode with writes enabled

```bash
RAIDNOW_MODE=live \
RAIDNOW_LIVE_WRITES=true \
npm start
```

Or with Docker Compose:

```yaml
services:
  raidnow-lite:
    image: ghcr.io/albinmedoc/raidnow-lite:latest
    restart: unless-stopped
    ports:
      - "4173:4173"
    environment:
      RAIDNOW_MODE: live
      RAIDNOW_LIVE_WRITES: "true"
    volumes:
      - raidnow-data:/app/data

volumes:
  raidnow-data:
```

Live mode can create or cancel Auto Join entries, join a lobby, and leave a raid. Start in demo or read-only mode first.

## Configuration

- `HOST` — bind address. Defaults to `127.0.0.1` with Node.js and is set to `0.0.0.0` in the container.
- `PORT` — HTTP port. Defaults to `4173`.
- `RAIDNOW_MODE` — `demo` or `live`. Defaults to `demo`.
- `RAIDNOW_LIVE_WRITES` — set to `true` to permit mutating upstream operations. Defaults to `false`.
- `RAIDNOW_POLL_INTERVAL_MS` — queue polling interval. Defaults to `3000` in demo mode and `15000` in live mode.
- `RAIDNOW_TOKEN` — optional diagnostic/recovery token. Normal anonymous catalog use does not require it; per-browser manual import is available only in the advanced recovery dialog after a real upstream session error.
- `RAIDNOW_CSRF_TOKEN` — optional upstream CSRF token if required.
- `PUBLIC_ORIGIN` — canonical private HTTPS origin, for example `https://hermesagent.tail96d10.ts.net`. Required when Web Push is enabled.
- `RAIDNOW_COOKIE_SECURE` — set to `true` behind trusted HTTPS ingress so session cookies carry `Secure`.
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` — stable Web Push credentials. Set all three or none. Keep the private key outside the repository; do not generate or rotate keys at process startup.
- `PUSH_ALLOWED_HOSTS` — optional comma-separated exact Web Push hostnames added to the built-in FCM, Mozilla, Apple, and Windows provider allowlist. Prefix the value with `=` to replace the defaults. IP addresses, wildcards, localhost-style names, CIDRs, ports, and paths are rejected.

Do not commit tokens, passwords, browser cookies, or the contents of `data/`.

Account login is optional. Manual token import is an advanced diagnostic fallback, not part of normal setup; do not copy a token from browser DevTools unless anonymous upstream access has actually failed and you intentionally need to recover that browser session.

## Multi-user and storage model

Raid NOW Lite has no application-level user accounts. Isolation is browser-session based:

1. The server creates a cryptographically random session identifier.
2. The identifier is stored in an `HttpOnly`, `SameSite=Strict` cookie.
3. Each session receives a separate adapter, token, worker, persisted state file, active raid, and SSE client set.
4. Trainer profiles are stored in the browser rather than in shared backend profile state.

Persistent files are stored under `/app/data` in the container:

- session directory permissions: `0700`;
- state file permissions: `0600`.

Back up this volume only if you intentionally want to preserve session tokens and active searches. Treat backups as sensitive.

## Reverse proxy and HTTPS

The built-in server exposes HTTP. Web Push deployments must terminate HTTPS at a trusted private ingress and set `PUBLIC_ORIGIN` to that exact HTTPS origin. Do not use Tailscale Funnel for this app.

### Docker Compose behind Tailscale Serve or another reverse proxy

Keep the published container port on host loopback with a small Compose override:

```yaml
services:
  raidnow-lite:
    ports:
      - "127.0.0.1:4173:4173"
```

Set these values in `.env`, start Compose, and point Tailscale Serve (or your private reverse proxy) at `http://127.0.0.1:4173`:

```bash
HOST=0.0.0.0
PUBLIC_ORIGIN=https://raidnow.your-tailnet.ts.net
RAIDNOW_COOKIE_SECURE=true
VAPID_PUBLIC_KEY=<generated-public-key>
VAPID_PRIVATE_KEY=<generated-private-key>
VAPID_SUBJECT=mailto:admin@example.com
PUSH_ALLOWED_HOSTS=
```

Keep the generated VAPID values in the local `.env` or a secrets manager, never in Compose YAML or source control. Restrict the HTTPS hostname to the intended tailnet/users.

### Native Node/systemd deployment

A native service is separate from the container defaults: bind Node directly to loopback and let the reverse proxy own external/Tailscale listeners.

```ini
[Service]
WorkingDirectory=/opt/raidnow-lite
Environment=HOST=127.0.0.1
Environment=PORT=4173
Environment=PUBLIC_ORIGIN=https://raidnow.your-tailnet.ts.net
Environment=RAIDNOW_COOKIE_SECURE=true
EnvironmentFile=/etc/raidnow-lite.env
ExecStart=/usr/bin/node src/server.js
```

Web Push is disabled cleanly when all VAPID variables and `PUBLIC_ORIGIN` are absent; raid searching remains functional. A partial or incoherent Web Push configuration fails startup instead of silently rotating keys or accepting an unsafe HTTP origin.

On iPhone/iPad, install the PWA with **Share → Add to Home Screen**, launch it from the Home Screen, then tap the notification button. Web Push requires iOS/iPadOS 16.4 or newer. Permission and subscription are requested only from that direct tap.

Do not expose live mode publicly without adding an appropriate authentication layer and network restrictions.

## Development

Run all tests:

```bash
npm test
```

Build the container locally:

```bash
docker build -t raidnow-lite:local .
```

Run it in demo mode:

```bash
docker run --rm -p 4173:4173 raidnow-lite:local
```

The test suite covers adapters, the hybrid worker, storage, profile validation, browser-session isolation, and HTTP routes. Tests use mocks and do not intentionally join or leave real raids.

## Container publishing

`.github/workflows/publish-docker.yml` runs when a GitHub release is published. It:

- builds multi-platform images for AMD64 and ARM64;
- publishes them to GitHub Container Registry;
- creates semantic-version tags plus `latest` for non-prereleases;
- publishes provenance and an SBOM;
- uses the GitHub Actions cache.

For example, publishing release `v1.2.3` produces:

- `ghcr.io/albinmedoc/raidnow-lite:v1`
- `ghcr.io/albinmedoc/raidnow-lite:v1.2`
- `ghcr.io/albinmedoc/raidnow-lite:v1.2.3`
- `ghcr.io/albinmedoc/raidnow-lite:latest`

## Security notes

- Passwords are forwarded only for the login request and are not persisted.
- Tokens are never returned by the API and are stored only in protected per-session state files.
- The session cookie is intentionally inaccessible to frontend JavaScript.
- Live join, cancel, and leave operations should not be used as deployment smoke tests.
- Host trainer-code QR images are generated entirely in the browser from the matched raid's exact 12-digit `rpl_code`. The code is not sent to a QR service, CDN, analytics endpoint, or other third party; invalid or unavailable host codes clear the QR and copy state.
- A browser session cookie grants access to that browser's server-side raid state. Use HTTPS when traffic can cross an untrusted network.

Please report security issues privately rather than including credentials or session values in a public issue.

## License

MIT. See [LICENSE](LICENSE).
