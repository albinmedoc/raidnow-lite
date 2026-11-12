# Reliability, PWA and QR Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make Raid NOW Lite recoverable across network/process failures, bound anonymous session resources, preserve and restore the active boss selection, support installable HTTPS push notifications, and show a locally generated host trainer-code QR without removing copy.

**Architecture:** Keep the existing per-browser backend contexts and fixed hybrid worker. Add abortable adapter operations, durable structured reconciliation and eager session restore before readiness. Add bounded inactive-session cleanup, browser-local selection persistence, a service worker/Web Push subscription API, and a local QR renderer. Bind Node to `127.0.0.1:4173` and expose it only through private Tailscale Serve HTTPS at `https://hermesagent.tail96d10.ts.net/`; do not use Funnel.

**Tech Stack:** Node.js 22, built-in test runner, HTTP/SSE, browser Service Worker/Push API, Web Push VAPID, local QR generation, Tailscale Serve.

---

### Task 1: Recoverable worker starts and abortable upstream operations

**Objective:** A failed or hung Raid NOW call must never leave the worker stuck and stop/shutdown must cancel in-flight work.

**Files:**
- Modify: `src/adapters/raidnow-adapter.js`
- Modify: `src/core/autojoin-worker.js`
- Test: `test/raidnow-adapter.test.js`
- Test: `test/autojoin-worker.test.js`

**Steps:**
1. Add failing tests for createMatching rejection, operation timeout, stop abort and restart after failure.
2. Run focused tests and verify they fail.
3. Add operation-specific timeout/AbortSignal handling in the adapter and worker lifecycle.
4. Ensure start transitions to recoverable `error`, clears timers/in-flight work, and permits a later start. Abort first and invalidate the generation before any stop reconciliation.
5. Test deferred stale completions after timeout, stop, shutdown and a subsequent restart, including timeout while reading the response body.
6. Run focused and full tests.

### Task 2: Persistent hybrid queue-cancel reconciliation and eager restore

**Objective:** Restore active searches at server startup and keep retrying queue cancellation after a direct match until confirmed.

**Files:**
- Modify: `src/core/autojoin-worker.js`
- Modify: `src/core/session-manager.js`
- Modify: `src/server.js`
- Test: `test/autojoin-worker.test.js`
- Test: `test/session-manager.test.js`

**Steps:**
1. Add failing restart/reconciliation tests.
2. Persist structured `queueCancelPending`, retry count, last attempt/error and next retry time alongside matched raid state.
3. Add an awaited persistence boundary for match and queue-cancellation transitions before push or externally visible completion.
4. Resume reconciliation after process restart without browser activity, including matched workers whose public state remains `matched`.
5. Enumerate only exact hashed session JSON filenames at startup and restore active/matched contexts with bounded construction and upstream concurrency before readiness.
6. Ignore/quarantine malformed JSON and stale temporary files safely; never follow unrelated names or symlinks.
7. Run focused and full tests.

### Task 3: Bounded session lifecycle and reset endpoint

**Objective:** Prevent unbounded anonymous session growth without deleting active searches or matched raids.

**Files:**
- Modify: `src/core/session-manager.js`
- Modify: `src/app.js`
- Test: `test/session-manager.test.js`
- Test: `test/app.test.js`

**Steps:**
1. Add failing tests for selective API session resolution, max contexts, inactive TTL cleanup, SSE limits and reset.
2. Resolve sessions only for stateful API/SSE routes, not health/static assets.
3. Track last access, evict only inactive idle contexts, and remove expired idle state files.
4. Add a per-browser reset route that rejects with `409` while searching, matched, hung or reconciling; idle reset removes local backend state and expires the cookie with matching attributes.
5. Add rate/body/input limits and standard security headers.
6. Run focused and full tests.

### Task 4: Restore and lock boss selection in the browser

**Objective:** Make the UI accurately reflect the server-owned active search and retain the last local selection.

**Files:**
- Create: `public/selection-storage.js`
- Modify: `public/app.js`
- Modify: `public/index.html`
- Modify: `public/styles.css`
- Test: `test/selection-storage.test.js`

**Steps:**
1. Add failing tests for versioned local selection storage and reconciliation against the current catalog.
2. Persist selected boss IDs and filter values locally.
3. Hydrate selection from active `status.selection` after reload, otherwise from local storage.
4. Lock boss cards and filters while searching and display `Söker efter …`.
5. Add a profile/reset action showing current trainer name.
6. Run focused and full tests.

### Task 5: Private HTTPS PWA and Web Push

**Objective:** Make the app installable and capable of notifying after the page is closed.

**Files:**
- Create: `public/manifest.webmanifest`
- Create: `public/service-worker.js`
- Create: PWA icon assets
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `src/app.js`
- Modify: `src/server.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `Dockerfile`
- Modify: `compose.yaml`
- Modify: `README.md`
- Test: `test/app.test.js`

**Steps:**
1. Add failing API/static tests for manifest, service worker and per-session push subscriptions.
2. Add pinned Web Push dependency and VAPID configuration; persist one stable keypair in an owner-only external environment file and validate it at startup.
3. Store push subscriptions only in the matching protected session state.
4. Send push on `matched`, removing expired subscriptions without affecting the raid.
5. Register the service worker and implement notification click handling.
6. Bind Node to loopback, set a secure session cookie explicitly, configure private Tailscale HTTPS Serve, and require/advertise HTTPS for notifications.
7. Verify manifest, service worker, subscription behavior and HTTPS endpoint without joining/leaving/cancelling a live raid.

### Task 6: Local host trainer-code QR while preserving copy

**Objective:** Display a scannable Pokémon GO friend QR derived locally from the host trainer code and keep the copy button.

**Files:**
- Add pinned local QR dependency or vendored browser module
- Create: `public/trainer-code-qr.js`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Test: `test/trainer-code-qr.test.js`

**Steps:**
1. Use the verified Raid NOW payload contract: exactly the host raid's unspaced 12 ASCII digits from `raid.rpl_code`; no URL, JSON, trainer name or prefix.
2. Add failing tests for normalization, invalid values and payload generation.
3. Render QR locally from a pinned vendored browser module with no third-party request, an adequate quiet zone and accessible text fallback.
4. Keep `Kopiera trainer code` and add `Visa QR-kod`.
5. Hide/clear QR when no valid host code exists.
6. Verify QR decode returns the expected payload.

### Task 7: Integration, deployment and publication

**Objective:** Verify all changes as a working release candidate and deploy safely.

**Files:**
- Modify: `README.md`
- Modify deployment/service configuration as required

**Steps:**
1. Run syntax checks, full tests, coverage and secret scan.
2. Exercise two isolated browser sessions in demo/read-only mode.
3. Restart the service and verify eager restore using synthetic state only.
4. Verify health, private HTTPS, PWA assets and QR rendering.
5. Restart production without live join/leave/cancel smoke tests.
6. Commit, push, wait for GitHub Actions, and report any deployment limitation honestly.
