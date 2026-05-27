# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] — 2026-05-27

Initial public release of **ReoLox** — Reolink camera bridge for ioBroker with direct Loxone Miniserver integration.

### Features
- Full Reolink HTTP API coverage: motion / AI detection (person, vehicle, animal, face), doorbell button, PTZ with presets, IR lights, WhiteLed spotlight, ISP image settings, snapshots, RTSP / RTMP / FLV stream URLs.
- **Loxone bridge** with HTTP (Token Auth via HMAC-SHA1, proactive refresh at 80 % of token lifetime; auto-fallback to Basic) and UDP transport. Virtual Input prefix configurable, default `ReoLox`.
- **Push webhook**: dedicated HTTP server receives Reolink push events. IP allowlist (auto = camera hosts), shared-secret auth (`?secret=` or `X-ReoLox-Secret`, constant-time comparison), 64 KB body cap.
- **Gate trigger over WhiteLed**: brief `≤3 s` ON→OFF flash triggers a `gate_trigger=1` event to Loxone.
- **Loxone Intercom**: doorbell ring sends the RTSP stream URL to a dedicated Virtual Input for the Loxone Touch panel.
- **Auto-discovery** via ONVIF WS-Discovery.

### Architecture
- `PollScheduler` with start-up jitter, per-task mutex, exponential backoff.
- `TimerManager` tracks every `setTimeout` / `setInterval` for deterministic unload.
- `CapabilityCache` persists `GetAbility` results on disk (TTL configurable, default 24 h).
- `ReolinkAPI` with singleflight login, exponential backoff on `ECONNRESET` / `ETIMEDOUT` / 5xx, URLs and bodies scrubbed before logging.
- `safe-log` helpers — passwords, tokens and CRLF are masked / stripped from log lines.
- `WebhookServer` extracted to its own module.

### Security
- `loxonePassword` and `webhookSharedSecret` declared in `encryptedNative`; cameras (with their passwords) declared in `protectedNative`.
- Webhook IP allowlist enabled by default.
- Body cap on webhook prevents DoS via large POSTs.
- Credentials never appear in public state values (separate `streams.rtspMainPublic` / `streams.rtspSubPublic` states for credential-free URLs).

### Quality
- 53 unit tests (parsePayload, safe-log, TimerManager, PollScheduler, LoxoneBridge, WebhookServer HTTP integration, CapabilityCache, ReolinkAPI with `nock`).
- 39 package validation tests.
- CI runs on Ubuntu / Windows / macOS × Node 18 / 20 / 22.
