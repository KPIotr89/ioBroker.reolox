# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] — 2026-05-27

**Breaking** — rebrand from `iobroker.reolink-loxone` to `iobroker.reolox` (display name **ReoLox**). State paths move from `reolink-loxone.0.*` to `reolox.0.*` and the Loxone Virtual Input prefix changes from `Reolink_*` to `ReoLox_*` (configurable via `loxoneViPrefix`). See README for migration steps.

### Added
- **Token Auth for Loxone HTTP** (HMAC-SHA1 via `jdev/sys/getkey2` + `getjwt`) with proactive refresh at 80 % of token lifetime; auto-fallback to Basic on unsupported firmware.
- **Webhook hardening**: dedicated `lib/webhook-server.js` with IP allowlist (auto = camera hosts), shared-secret auth (`?secret=` or `X-ReoLox-Secret`), 64 KB body cap, constant-time secret comparison, sanitised logs.
- **`PollScheduler`** with start-up jitter, per-task mutex, exponential backoff and capped retries.
- **`TimerManager`** tracks every `setTimeout` / `setInterval` so unload cancels them deterministically.
- **`CapabilityCache`** persists `GetAbility` results on disk (TTL configurable, default 24 h) — cold start no longer hits every camera.
- **`safe-log`** helpers (`sanitize`, `mask`, `maskUrl`) — passwords, tokens and CRLF can no longer appear in logs.
- Configurable Loxone VI prefix (`loxoneViPrefix`, default `ReoLox`).
- Per-camera `<camId>.loxone.vi*` read-only states showing the exact Virtual Input names ReoLox will send to.
- Public credential-free stream states (`streams.rtspMainPublic`, `streams.rtspSubPublic`).
- Unit tests for `parseReolinkPushPayload`, `safe-log`, `TimerManager`, `PollScheduler`, `LoxoneBridge.inputName`, `WebhookServer` (HTTP integration), `CapabilityCache`, `ReolinkAPI` (with `nock`).

### Changed
- `main.js` is now a thin orchestrator (~600 lines) — every cross-cutting concern lives in `lib/`.
- `ReolinkAPI`: singleflight login (concurrent callers share one network round-trip), exponential backoff on `ECONNRESET` / `ETIMEDOUT` / 5xx, URLs and bodies are scrubbed before logging.
- Snapshot files now use a stable filename (`<camId>.jpg`) so external consumers can hot-link them; the timestamp is exposed separately.
- Webhook URL changed from `/reolink/<cam>` to `/reolox/<cam>` and auto-config now embeds the shared secret as `?secret=…`.

### Fixed
- **getRtmpUrl literal bug**: `bcs/channel${ch}_sub.bcs` was a string literal (single quotes) — sub-stream RTMP URL produced an unusable `…channel${ch}_sub.bcs…` path. Now properly interpolated.
- Camera id uniqueness is validated at startup — two cameras can no longer share an id.
- `setTimeout`-driven auto-resets are now tracked and cleared on unload (no more `setStateAsync` after destroy).
- Loxone Basic Auth no longer sends the password on every event when the Miniserver supports tokens.
- Credentials are stripped from public state values (`streams.snapshotUrl` removed in favour of an in-instance snapshot file).
- Webhook log lines are sanitised — control characters in `type` no longer inject log lines.

### Security
- `loxonePassword` and `webhookSharedSecret` declared in `encryptedNative`; cameras (with their passwords) declared in `protectedNative`.
- Webhook IP allowlist enabled by default (`auto` derives the list from configured camera hosts).
- Body cap on webhook prevents trivial DoS via large POSTs.

## [1.3.0] — 2025-04
- WhiteLed knock-pattern gate trigger (≤ 3 s ON→OFF detected via Reolink app → `gate_trigger` event).

## [1.2.0] — 2025-03
- `SetWhiteLed` fix: read current config from camera, `ledControl` permission detection, WhiteLed state polling.

## [1.1.0] — 2025-03
- Capability detection via `GetAbility` (auto-detect WhiteLed / PTZ / Siren / AI).

## [1.0.0] — 2025-03
- Initial release. Full Reolink HTTP API coverage and a direct Loxone bridge.
