# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.5.9] — 2026-06-01

### Fixed
- **SIGKILL on stop/restart — fixed properly in code.** `common.stopTimeout` (added in 2.5.8) was not honoured by the existing instance object, so restarts still hit the ~1 s default and the adapter was force-killed mid-shutdown — confirmed live with 6 cameras (the 2 s parallel logout wait never finished in time, so the 2.5.7 held-siren stop never ran). `onUnload` is restructured to finish well under 1 s regardless of js-controller settings: it now (1) releases the held siren **first**, before any `await` or `timers.dispose()`; (2) disposes scheduler/bridge/timers; (3) caps webhook-stop at 300 ms and each camera logout at 500 ms. Leftover HTTP sockets / camera sessions are reclaimed by the OS or time out server-side. `stopTimeout = 4000` stays as a backstop for fresh installs.

## [2.5.8] — 2026-06-01

### Fixed
- **Graceful shutdown — adapter was SIGKILLed on restart.** Real-world restart logs showed js-controller force-killing the instance after its 1 s default stop timeout, while `onUnload` (camera logout, capped at 2 s, plus the 2.5.7 held-siren stop) needs longer. As a result the 2.5.7 clean-up code never ran on a controlled restart. Added `common.stopTimeout = 4000` (ms) so `onUnload` completes — camera logout and the held-siren stop now finish cleanly on stop/restart. io-package.json-only change; no code logic touched.

## [2.5.7] — 2026-06-01

Pre-production hardening pass following an independent adversarial code review. No new features, no functional regressions — `67` unit + `39` package tests pass, lint clean.

### Fixed
- **`SetAudioAlarmV20` wrote under the wrong wrapper key.** `setAudioAlarm` / `setAudioAlarmConfig` sent the config under `AudioAlarmV20`, but the camera returns (and expects) it under `Audio` — so on firmware that supports a settable alarm sound/duration those writes silently failed. Both setters now use the `Audio` key (matching the already-correct `setAudioAlarmEnabled`). Added a regression test.
- **Held-siren re-fire loops are now stopped on adapter unload.** `onUnload` explicitly stops every active siren-hold loop before disposing timers; the last 1-repeat pulse rings out within ~2.5 s (fail-safe — the siren can never latch on across a restart).
- **`control.sirenManual` is reset to OFF on every (re)start.** The software-held loop never survives a restart, so the switch is forced to `false` during initial state sync — no stale "ON" that isn't actually wailing, and the siren never auto-resumes after a restart.

### Changed
- **`control.audioAlarmDuration` is now a pure local value** (the repeat-count read by the timed-pulse siren at trigger time) and no longer attempts a camera-side config write — current CX-series firmware has no settable duration field, so the write only produced a spurious warning.

## [2.5.6] — 2026-05-29

### Changed
- **Merged the redundant visitor / doorbell signals into one.** On the Reolink Video Doorbell PoE the button press arrives as a `visitor` webhook (no `GetDoorbell`), so `status.doorbellRing` and the `<cam>_doorbellRing` VI were always identical to `status.visitorDetected` / `<cam>_Visitor`. The `doorbellRing` state and VI are removed; use `Visitor` for the ring. (Existing `status.doorbellRing` objects on upgraded instances remain as harmless orphans — delete them manually if you like.)

### Notes
- The ~20 s before a fresh doorbell press registers again is the camera's own push debounce (Reolink rate-limits button pushes), not the adapter — the adapter's visitor pulse is 1 s.

## [2.5.5] — 2026-05-29

### Fixed
- **WhiteLed (spotlight) capability detection corrected.** It was based on `ledControl.permit`, which on a Reolink Video Doorbell PoE is the doorbell-ring light (`permit=6`) — so doorbells wrongly got `whiteLed` states/VIs/VOs, while a CX820 (`ledControl=0`) only worked via a loose `GetWhiteLed` probe. Detection now uses **`supportWLLightAlarm`** (CX-series spotlight) / **`floodLight`** (RLC floodlights), and the probe is skipped for `isDoorbell` rows. The **VI and VO generators are gated by the capability** too, so cameras without a spotlight no longer emit `whiteLed` / `gate_trigger` entries.

## [2.5.4] — 2026-05-29

### Added
- **Armed siren** — new `control.sirenOnDetect` (`SetAudioAlarmV20` enable 0/1, schedule preserved): the camera sounds its siren on AI/motion detection. Works on CX820 (and CX810). Ideal for a Loxone "away → arm" automation.

### Changed
- **`control.sirenManual` is now a software-held siren** that works on every model. The native held `AudioAlarmPlay` mode (`manul`) is honoured only by some firmware (CX810 v3.1.x); CX820 v3.2.x accepts it but does not hold and cannot stop a pulse early. So ON re-fires a 1-repeat pulse (~2.5 s each) every 2.8 s, OFF stops the loop — and it is fail-safe: if the adapter stops, the last pulse rings out (~2.5 s) instead of latching the siren on.

### Notes
- Reolink's `AudioAlarmPlay` `times` is the number of sound **repetitions** (~2.5 s each), not seconds, despite some docs labelling it "seconds".

## [2.5.3] — 2026-05-29

### Fixed
- **Sustained siren on/off** (`control.sirenManual`) on models such as **CX820** (firmware v3.2.x): the `AudioAlarmPlay` manual command no longer includes `times`, which those firmwares interpreted as "play once" (so only the timed pulse worked). It now matches the official on/off examples — `alarm_mode:"manul"` with `manual_switch` only. CX810 is unaffected (it already worked).

## [2.5.2] — 2026-05-29

### Fixed
- Loxone-tab help panels (VI / VO step-by-step guides and the naming convention) now render as readable multi-line lists. jsonConfig `staticText` shows plain text, not markdown — the markup was removed and line breaks are forced with `white-space: pre-line`.

## [2.5.1] — 2026-05-29

### Added
- The **VI and VO list tables** now have an **Export** button (save the generated list to a file), each with its own **step-by-step guide** in the Loxone tab — for creating the Virtual Inputs and the Virtual Output in Loxone Config.

## [2.5.0] — 2026-05-29

### Added
- **Loxone tab → Generate VO list** — a table of Virtual Output commands (`CmdOn` / `CmdOff` paths, digital/analog) for every control state, ready to recreate in a Loxone Virtual Output pointed at `/reolox/cmd`.
- **Loxone tab → Generate VO import XML** — produces a ready-to-import Loxone Virtual Output template (`<VirtualOut>`) for the configured cameras and shows it in a copyable, read-only field. Address is taken from the Webhook tab (ioBroker IP + port).

### Changed
- **VI list table tidied** for readability: wider *Virtual Input name* column, and the redundant *Camera* column dropped (the name already starts with the camera).

### Fixed
- Removed an invalid **`noAdd`** property from the VI table — admin's jsonConfig schema rejected it (`must NOT have additional properties`), which made the whole config fail validation.

## [2.4.1] — 2026-05-29

### Changed
- **Control endpoint secret made trust-aware.** The Loxone Miniserver IP (trusted via the *Loxone* tab) and loopback no longer need the webhook shared secret on `/reolox/cmd/…`, so a Virtual Output works out of the box without `?secret=` on every command. Any **other** source IP still must present the secret, and the webhook **push** path is unchanged (secret still enforced there).

## [2.4.0] — 2026-05-29

### Added
- **`control.sirenManual`** — sustained siren on/off (`AudioAlarmPlay` with `alarm_mode:"manul"`, `manual_switch` 1/0). Loxone can hold the siren on while an alarm condition lasts and clear it afterwards, in addition to the existing timed `control.siren` pulse.

### Changed
- **`control.siren`** (timed pulse) now uses the configured `control.audioAlarmDuration` instead of a hardcoded 5 s.

### Fixed
- **`AudioAlarmPlay` payload corrected** to the official API shape: a **flat** `param` with `alarm_mode` (`"times"` / `"manul"`), `manual_switch` and `times` (seconds). The previous `{ AudioAlarmPlay: { manualSwitch, duration } }` wrapper did not match the documented API and could be rejected by firmware.

## [2.3.1] — 2026-05-29

### Changed
- **Webhook IP allowlist** now accepts `auto` and explicit IPs **together** (e.g. `auto, 192.168.0.175`). Previously it was one mode or the other, so adding an admin/test host meant losing automatic camera detection.

### Added
- The control endpoint (`/reolox/cmd/…`) always trusts loopback (`127.0.0.1` / `::1`), so it can be tested with `curl` from the ioBroker host without widening the allowlist.

## [2.3.0] — 2026-05-28

### Added
- **Built-in HTTP control endpoint** — the existing webhook server now also accepts control commands, so a **Loxone Virtual Output can drive any control state directly**, with no `simple-api`/`rest-api` adapter in between:
  - `GET|POST http://<iobroker>:<port>/reolox/cmd/<state.path>/<value>`
  - digital example: `…/cmd/taras.control.whiteLed/1`
  - analog example (Loxone substitutes `<v>`): `…/cmd/taras.control.whiteLedBrightness/<v>`
  - NVR channel: `…/cmd/nvr.ch3.control.recording/0`
  - The value is coerced to the target state's type and written with `ack=false`, so it flows through the normal `onStateChange` → camera pipeline.
- New option **`controlApiEnabled`** (default `true`, Webhook tab) to enable/disable the control endpoint.

### Security
- The control endpoint is guarded by the **webhook shared secret** (constant-time check) and an IP check: the **Loxone Miniserver IP** (from the Loxone tab) is trusted automatically, in addition to the camera allowlist. Only ids containing `.control.` that resolve to an existing **writable** state are accepted — arbitrary state writes are rejected.

## [2.2.0] — 2026-05-28

### Added
- **Standalone camera control** (Phase 1) under `reolox.0.<cam>.control.*`: front status LED (PowerLed), SD recording, master push + per-type push (motion / person / vehicle / animal / visitor), WhiteLed on/off + brightness + mode, OSD overlay text and date/time, motion-detection sensitivity, audio-alarm duration and sound.
- **NVR per-channel control** (Phase 2) under `reolox.0.<nvr>.chN.control.*`: recording, motion-detection, AI-detection (master) and push toggles, with initial state synced from the NVR at startup.

### Changed
- **WhiteLed on/off** now sends the minimal `SetWhiteLed` payload (`channel` + `state` only) instead of the full config object. CX810/CX820 reject the full payload (`LightingSchedule` / `mode=1`) with `rspCode=-13`; brightness and mode are left untouched.
- **State subscription narrowed** to `*.control.*`, `*.ptz.*`, `*.image.*` — read-only `info` / `status` / `streams` states no longer raise redundant change events.

### Fixed
- **Standalone offline detection**: a camera that stops responding now correctly reports `info.connection = false` and `Online = 0` to Loxone. Previously every per-command failure was swallowed and the connection flag stayed `true`, so a dead camera looked online indefinitely.
- **NVR token expiry**: `_batchCmd` re-logins once on `rspCode = -6` / HTTP 401 (these surface per-entry in a batch, not as an exception). A batch that still returns no valid entries now marks the NVR offline instead of silently reporting every channel quiet with `Online = 1`.
- **Capability cache** is now firmware-aware: a changed `firmVer` invalidates the cached `GetAbility`, so a firmware upgrade can no longer pin stale capabilities for the whole TTL.
- **Loxone VI generator** derives the NVR id the same way as the init path (`cam_<host>` fallback), so unnamed NVR rows no longer get stuck on "restart adapter, then click Generate again".

### Removed
- Unused **Advanced tab** options that were present in the UI/README but never implemented: *Auto-capture snapshot on motion*, *Snapshot retention*, *Verbose logging (debug mode)*. On-demand snapshot capture via `control.snapshot` is unchanged.

## [2.1.0] — 2026-05-28

### Added
- **NVR support** (Reolink RLN8/RLN16/RLN36) — new `isNvr` flag per row. On startup ReoLox pulls the device info and `GetChannelstatus` and builds a per-channel state tree under `reolox.0.<nvr>.chN.{info,status}.*`. Per-channel polling fires `GetMdState` + `GetAiState` for every online channel in a single batch HTTP call. Loxone VIs named `<prefix>_<nvr>_<channel>_<event>`.
- **`pushToLoxone` flag per row** (default `true`) — disable Loxone bridge for selected cameras/NVRs without removing the device or its polling. Useful when an NVR row would duplicate VIs already produced by standalone cameras.
- **`isDoorbell` flag per row** — marks the row as a doorbell so the adapter trusts the webhook button-press path even when the firmware misreports `GetDoorbell` (e.g. Reolink Video Doorbell PoE v3.0.0.4662).
- **VI list generator** in the Loxone tab — interactive table (camera / VI / type / note) populated from the live configuration. NVR rows expand into per-channel entries so a single click produces the full Loxone Config name list.
- **Online heartbeat** every 60 s — Loxone Miniserver restarts no longer leave the `_Online` VI stuck on a stale 0; the adapter refreshes the value even when the connection state has not changed.
- **Active `doorbellRing` events** — the doorbell ring state is now actively pushed to Loxone (`<prefix>_<cam>_doorbellRing`) in addition to the legacy `_Visitor` pulse.

### Changed
- **AI-only motion**: `GetMdState` polling dropped. The Motion VI now fires whenever any AI alarm fires (`person`, `vehicle`, `animal`, `face`). Reolink CX-series often reports `GetMdState = 0` even with AI active, so the previous logic was unreliable.
- **Default poll interval lowered from 5 s to 1 s** — short events (a hand wave) used to slip between polls.
- Per-camera initialisation pipeline split: standalone goes through `initCamera`, NVR rows go through the new `_initNvr`.

### Fixed
- **Auth retry on `rspCode = -6`** when the error is reported in `data.error.rspCode` rather than `data.code`. Previously caused permanent `Camera "front" init failed: please login first` after a token expired between login and the first command on some firmware revisions.
- **`SetPushV20 ability error (-26)`** root cause documented: the camera account needs Admin role (`push.permit = 6` in `GetAbility`). The README and admin help text now call this out.
- **`jsonConfig` validation warnings**: `_cameraHelp` empty `label` removed; `_discoverBtn.result` and `_generateVIs.result` switched to the object-form mapping.
- **`_discoverBtn`** now returns a `message` field so the Admin UI toast shows the discovery result.

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
