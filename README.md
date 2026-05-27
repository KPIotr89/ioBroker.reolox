<p align="center">
  <img src="admin/reolox.svg" width="120" alt="ReoLox"/>
</p>

<h1 align="center">ioBroker.reolox</h1>

<p align="center">
  <b>ReoLox</b> — Reolink camera bridge for ioBroker with first-class Loxone Miniserver integration
</p>

<p align="center">
  <a href="https://github.com/KPIotr89/ioBroker.reolox/releases"><img src="https://img.shields.io/github/v/release/KPIotr89/ioBroker.reolox?style=flat-square&color=0071e3" alt="Release"/></a>
  <a href="https://github.com/KPIotr89/ioBroker.reolox/blob/main/LICENSE"><img src="https://img.shields.io/github/license/KPIotr89/ioBroker.reolox?style=flat-square&color=34c759" alt="License"/></a>
  <img src="https://img.shields.io/node/v/iobroker.reolox?style=flat-square&color=ff9500" alt="Node.js"/>
  <a href="https://github.com/KPIotr89/ioBroker.reolox/actions"><img src="https://img.shields.io/github/actions/workflow/status/KPIotr89/ioBroker.reolox/test-and-release.yml?style=flat-square&label=CI" alt="CI"/></a>
</p>

---

## Table of contents

- [What it does](#what-it-does)
- [Features](#features)
- [Architecture](#architecture)
- [Compatibility](#compatibility)
- [Installation](#installation)
- [Configuration](#configuration)
  - [Cameras tab](#cameras-tab)
  - [Loxone tab](#loxone-tab)
  - [Webhook tab](#webhook-tab)
  - [Advanced tab](#advanced-tab)
- [Object tree](#object-tree)
- [Loxone integration](#loxone-integration)
  - [Virtual Input naming](#virtual-input-naming)
  - [Token Auth vs Basic](#token-auth-vs-basic)
  - [Loxone Intercom (RTSP on ring)](#loxone-intercom-rtsp-on-ring)
- [Webhook server](#webhook-server)
- [Snapshot capture](#snapshot-capture)
- [PTZ control](#ptz-control)
- [White LED & spotlight](#white-led--spotlight)
- [Gate trigger](#gate-trigger)
- [Auto-discovery](#auto-discovery)
- [Camera-specific notes](#camera-specific-notes)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Development](#development)
- [License](#license)

---

## What it does

ReoLox connects every Reolink camera on your local network to ioBroker and Loxone. No cloud, no Node-RED bridge, no MQTT round-trip. The adapter speaks the local Reolink HTTP API directly, exposes every camera state in ioBroker's object tree, and forwards events to your Loxone Miniserver in real time via Virtual Inputs (Token Auth over HTTP or UDP).

It is built around a hardened webhook server that accepts Reolink push events on a local port, a poll scheduler that batches all periodic reads with jitter and backoff, and a Loxone bridge that supports modern Token Auth as well as legacy Basic. Camera passwords are stored encrypted by ioBroker (`protectedNative` / `encryptedNative`).

## Features

**Camera control**

- Motion detection (`GetMdState`)
- AI detection: person, vehicle, animal, face (`GetAiState`)
- Doorbell button press (`GetDoorbell`)
- IR lights — Auto / On / Off
- White LED spotlight (state read + on/off control with brightness)
- PTZ control: pan, tilt, zoom, focus, presets, patrol, stop
- ISP settings: brightness, contrast, saturation, sharpness
- Snapshot capture (JPEG written to disk, base64 in state, timestamp)
- Stream URLs: RTSP main / sub (with and without credentials), RTMP, FLV
- Reboot

**Loxone bridge**

- HTTP Virtual Inputs (recommended) — Token Auth via HMAC-SHA1, proactive refresh at 80 % of token lifetime, automatic fallback to Basic if the Miniserver does not support tokens
- UDP transport (token-less)
- Configurable Virtual Input prefix (default `ReoLox`)
- Loxone Intercom integration: the RTSP stream URL is delivered to a dedicated VI on doorbell ring so the Loxone Touch panel can display the camera feed

**Push webhook**

- Dedicated HTTP server on a configurable port (default `7777`)
- Source-IP allowlist (`auto` = derived from configured camera hosts)
- Shared-secret authentication via `?secret=…` query parameter or `X-ReoLox-Secret` header, constant-time comparison
- 64 KB body cap (oversize requests get `413 Payload Too Large`)
- Path namespaced under `/reolox/<camera>` — anything else returns 404
- CRLF and control characters sanitised in every log line

**Reliability**

- `PollScheduler` with start-up jitter (so N cameras don't all log in at the same instant), per-task mutex (no overlapping cycles), exponential backoff on failure, capped retries
- `TimerManager` tracks every `setTimeout` / `setInterval` so unload cancels them deterministically — no `setStateAsync` after destroy
- `ReolinkAPI` singleflight login (concurrent callers share one network round-trip), exponential backoff on `ECONNRESET` / `ETIMEDOUT` / 5xx
- `CapabilityCache` persists `GetAbility` responses on disk — cold start does not re-query every camera
- Camera id uniqueness validated at startup

**Security**

- `loxonePassword` and `webhookSharedSecret` in `encryptedNative`
- `cameras` (with their passwords) in `protectedNative`
- Public stream URL states (`streams.rtspMainPublic`, `streams.rtspSubPublic`) carry **no** credentials — safe to read from scripts or external dashboards
- Webhook server rejects unknown source IPs by default

**Tooling**

- ONVIF auto-discovery in Admin UI
- 53 unit tests (parsePayload, safe-log, TimerManager, PollScheduler, LoxoneBridge, WebhookServer HTTP integration, CapabilityCache, ReolinkAPI with `nock`)
- 39 package validation tests
- CI runs on Ubuntu / Windows / macOS × Node 18 / 20 / 22

## Architecture

```
                     ┌─────────────────────────────────────────────────┐
                     │                  ReoLox adapter                 │
                     │                                                 │
   ┌───────────┐     │   ┌──────────────┐   ┌────────────────────┐     │   ┌────────────────────┐
   │  Reolink  │     │   │ ReolinkAPI   │   │ LoxoneBridge       │     │   │ Loxone Miniserver  │
   │  camera   │◄────┼──►│ - login SF   │   │ - HTTP token auth  │◄────┼──►│ - Virtual Inputs   │
   │  (HTTP)   │     │   │ - retry/backoff│ │ - UDP              │     │   │ - Intercom panel   │
   └───────────┘     │   └──────────────┘   └────────────────────┘     │   └────────────────────┘
                     │                                                 │
   ┌───────────┐     │   ┌──────────────┐   ┌────────────────────┐     │
   │  Reolink  │─POST│──►│ WebhookServer│   │ PollScheduler      │     │
   │  push     │     │   │ - allowlist  │   │ - jitter, mutex    │     │
   │  events   │     │   │ - secret     │   │ - exp. backoff     │     │
   └───────────┘     │   │ - 64 KB cap  │   └────────────────────┘     │
                     │   └──────────────┘                              │
                     │                                                 │
                     │   ┌──────────────┐   ┌────────────────────┐     │
                     │   │ TimerManager │   │ CapabilityCache    │     │
                     │   │ - tracked    │   │ - disk, TTL 24h    │     │
                     │   │   setTimeout │   └────────────────────┘     │
                     │   └──────────────┘                              │
                     └─────────────────────────────────────────────────┘
                                            │
                                            ▼
                                    ioBroker objects
                                  (reolox.0.<cam>.*)
```

Source layout:

```
main.js                         # adapter orchestrator (~600 lines)
lib/
  reolink-api.js                # HTTP client per camera
  loxone-bridge.js              # Loxone HTTP (token/basic) + UDP
  webhook-server.js             # /reolox/<cam> push receiver + parser
  poll-scheduler.js             # periodic task supervisor
  timer-manager.js              # tracked setTimeout/setInterval
  capability-cache.js           # GetAbility disk cache
  discovery.js                  # ONVIF WS-Discovery probe
  safe-log.js                   # CRLF / password / token redaction
admin/
  jsonConfig.json               # admin UI (i18n-ready)
  reolox.svg                    # adapter icon
  i18n/{en,pl,de}/translations.json
test/
  unit/*.test.js                # mocha + chai + nock
  package/manifest.test.js      # @iobroker/testing
```

## Compatibility

| Component              | Tested with                                         |
|------------------------|-----------------------------------------------------|
| ioBroker js-controller | ≥ 5.0                                               |
| ioBroker admin         | ≥ 6.0                                               |
| Node.js                | 18, 20, 22                                          |
| Reolink firmware       | v3.x — CX810, Video Doorbell PoE, RLC-810A          |
| Loxone Miniserver      | Gen 1 (Basic Auth) / Gen 2 (Token Auth, HMAC-SHA1)  |
| Platforms              | Linux / macOS / Windows                             |

Older Reolink firmwares (`v2.x` and below) may work but are not actively tested. PoE and Wi-Fi cameras are equally supported.

## Installation

From the GitHub repo:

```bash
iobroker url https://github.com/KPIotr89/ioBroker.reolox
```

Then **Admin → Adapters → ReoLox → Add instance**. Open the instance configuration and start with the *Cameras* tab.

The adapter does not require any external services (no go2rtc, no Node-RED, no MQTT broker). If you want a re-stream layer for the Loxone Intercom you can deploy `go2rtc` separately, but it is not part of ReoLox.

## Configuration

### Cameras tab

Add a row per camera. Fields:

| Field | Notes |
|---|---|
| **On** | Enable / disable polling for this camera without removing the row |
| **Name** | Used as the ioBroker state id and the camera component of every Loxone VI name. Allowed characters: `a–z A–Z 0–9 _ -` and space. Must be unique across the camera list |
| **IP / Host** | LAN address of the camera |
| **Port** | HTTP(S) port, default 80 (or 443 for TLS) |
| **User / Password** | Account configured on the camera. **Admin** role required for WhiteLed and most setters |
| **Ch** | Channel index — `0` for standalone cameras, `0–15` for NVR channels |
| **TLS** | Use HTTPS (self-signed certs accepted) |
| **Poll s** | Status polling interval. Default 5 s. Per-camera override of the *Default poll interval* below |
| **Gate** | Enable fast-poll WhiteLed knock-pattern gate trigger for this camera (see [Gate trigger](#gate-trigger)) |
| **Doorbell** | Mark this camera as a doorbell. Forces `caps.visitor + caps.doorbell = true` even when firmware misreports `GetDoorbell`. Visitor events arrive via webhook push and pulse `<prefix>_<cam>_Visitor` for 1 s |

Two helpers under the table:

- **🔍 Discover** runs an ONVIF WS-Discovery probe and lists every Reolink device on the LAN
- **Default poll interval** is the fallback when *Poll s* is empty on a row
- **Capability cache TTL (hours)** controls how long `GetAbility` results are cached on disk (default 24 h, set 0 to disable)

### Loxone tab

| Field | Notes |
|---|---|
| **Enable Loxone integration** | Master switch |
| **Miniserver IP address** | LAN address of the Miniserver |
| **HTTP port** | Default 80 |
| **Username / Password** | Loxone user that may write Virtual Inputs. Password is encrypted at rest |
| **Authentication** | `Token` (recommended) — HMAC-SHA1, refreshed proactively at 80 % of the token lifetime, auto-fallback to Basic on unsupported firmware; or `Basic` — legacy, sends credentials on every request |
| **Communication mode** | `HTTP Virtual Inputs` (default), `UDP`, or both |
| **UDP port** | Visible only in UDP modes, default 7000 |
| **Virtual Input prefix** | Default `ReoLox`. All generated VI names are prefixed with this string |
| **Enable Loxone Intercom integration** | When the doorbell rings, the RTSP stream URL is sent to `<prefix>_<camera>_intercom` so the Loxone Touch panel can show the live feed |

A help panel at the bottom lists every VI name pattern using the current prefix.

### Webhook tab

The webhook server receives Reolink push events so the adapter does **not** have to poll for doorbell or visitor detection (1 s polling is too slow to catch a button press).

| Field | Notes |
|---|---|
| **Enable webhook server** | Master switch |
| **Listen port** | Default 7777 |
| **ioBroker IP (visible to cameras)** | LAN address the cameras can reach. The adapter auto-configures each camera's push URL at startup using this value |
| **Shared secret** | Strongly recommended. Every webhook POST must include `?secret=…` or an `X-ReoLox-Secret` header. Auto-configured push URLs embed it automatically. Encrypted at rest |
| **Source IP allowlist** | `auto` (default) accepts only the IPs of cameras configured in the *Cameras* tab. You can also set an explicit comma-separated list (e.g. `192.168.0.48, 192.168.0.49`) |

Server validation order on every request:

1. Method must be `POST`
2. Path must start with `/reolox/`
3. Source IP must be in the allowlist
4. Shared secret must match (constant-time comparison)
5. Body must be ≤ 64 KB (oversize → `413`)

If any of these fail the request is rejected without invoking the event dispatcher.

### Advanced tab

| Field | Notes |
|---|---|
| **Auto-capture snapshot on motion** | Save a JPEG snapshot whenever motion is detected |
| **Snapshot retention (hours)** | Snapshots older than this are deleted automatically. Default 24 h |
| **Verbose logging (debug mode)** | Log all API calls and raw payloads. Passwords and tokens remain masked |

## Object tree

For a camera named `<cam>` the adapter creates the following objects under `reolox.0.<cam>`:

```
info/
  connection           bool   live connection state
  model                string camera model
  name                 string camera reported name
  firmware             string firmware version
  serial               string serial number
  hardwareVersion      string hardware revision
  channelCount         number number of channels reported

status/
  motionDetected       bool   motion right now
  personDetected       bool   AI person right now
  vehicleDetected      bool   AI vehicle right now
  animalDetected       bool   AI animal right now
  faceDetected         bool   AI face right now
  lastMotionTime       number timestamp of last motion start
  visitorDetected      bool   doorbell ring / visitor AI
  doorbellRing         bool   physical doorbell button state
  whiteLed             bool   live WhiteLed state (if supported)
  whiteLedTrigger      bool   gate trigger pulse (if Gate enabled)

control/
  snapshot             button  trigger snapshot capture
  reboot               button  reboot camera
  irLights             enum    Auto / On / Off
  whiteLed             bool    write WhiteLed state (if supported)
  siren                button  trigger siren (if supported)

ptz/                          (only if camera supports PTZ)
  command              enum    Left, Right, Up, Down, LeftUp, ..., Stop, Auto
  speed                number  1-64
  goToPreset           number  preset index
  patrol               bool    start/stop patrol
  stop                 button  stop any PTZ movement

image/
  brightness           number  0-255
  contrast             number  0-255
  saturation           number  0-255
  sharpness            number  0-255

streams/
  rtspMainPublic       string  rtsp://<host>:554/h264Preview_01_main      (no credentials)
  rtspSubPublic        string  rtsp://<host>:554/h264Preview_01_sub       (no credentials)
  snapshotProxy        string  absolute path of the last snapshot file

snapshot/
  image                string  last snapshot as data: URL (base64)
  timestamp            number  capture time
  file                 string  absolute path of the saved JPEG

storage/
  hddCapacity          number  SD/HDD total in MB
  hddUsed              number  SD/HDD used in MB

loxone/                       (only if Loxone integration enabled)
  viMotion             string  Loxone VI name for motion
  viPerson             string  Loxone VI name for AI person
  viVehicle            string  Loxone VI name for AI vehicle
  viOnline             string  Loxone VI name for online state
  viVisitor            string  Loxone VI name for visitor/doorbell
  viIntercom           string  Loxone VI name carrying the RTSP URL on ring
  viGateTrigger        string  Loxone VI name for gate trigger pulse
```

Writable states (`control.*`, `ptz.*`, `image.*`) accept commands the moment they are set. The adapter debounces user writes to `control.whiteLed` for 3 seconds so the polled state does not immediately overwrite the user's intent.

## Loxone integration

### Virtual Input naming

Every VI uses the pattern `<prefix>_<camera>_<event>`. The prefix is configurable (default `ReoLox`); the camera name comes from the Cameras tab; the event is a fixed string.

For a camera named `garaz` and the default prefix create these inputs in Loxone Config — names are case-sensitive:

```
ReoLox_garaz_Motion           digital     1 = motion, 0 = none
ReoLox_garaz_AI_person        digital     1 = person, 0 = none
ReoLox_garaz_AI_vehicle       digital     1 = vehicle, 0 = none
ReoLox_garaz_AI_animal        digital     1 = animal, 0 = none
ReoLox_garaz_Online           digital     1 = camera reachable
ReoLox_garaz_Visitor          digital     1 = doorbell pressed (auto-pulses 1 s)
ReoLox_garaz_gate_trigger     digital     1 = gate trigger pattern (auto-pulses 1 s)
ReoLox_garaz_whiteLed         digital     mirrors the WhiteLed state
ReoLox_garaz_intercom         text        RTSP URL string on ring (Intercom)
```

The exact VI names per camera are also written to `reolox.0.<cam>.loxone.vi*` once the instance starts — so you can copy them straight from there.

### Token Auth vs Basic

`Token` mode does the Loxone v10.2+ handshake:

1. `GET /jdev/sys/getkey2/<user>` → returns `{ key, salt, hashAlg }`
2. Compute `pwHash = uppercase(SHA1(password + ":" + salt))`
3. Compute `hmac = HMAC-SHA1(key, user + ":" + pwHash)`
4. `GET /jdev/sys/getjwt/<hmac>/<user>/4/iobroker-reolox/iobroker` → returns the token + `validUntil`
5. Subsequent calls add `?autht=<token>&user=<user>` instead of a Basic header

The token is refreshed at 80 % of its lifetime by the adapter, in the background. If any step fails (typically on Gen 1 Miniservers without token support) the bridge silently falls back to Basic for the remainder of the session.

### Loxone Intercom (RTSP on ring)

When `Enable Loxone Intercom integration` is on and a doorbell ring arrives (either via webhook push or `GetDoorbell` polling), the bridge sends the **public** RTSP URL of the main stream to `<prefix>_<camera>_intercom` (e.g. `rtsp://192.168.0.48:554/h264Preview_01_main`). On ring-end the VI is reset to `0`. The Loxone Touch panel can be configured to subscribe to that VI and display the feed.

The URL does **not** carry credentials — your camera must allow anonymous RTSP (default) or you need to expose a credentialed re-stream separately. Storing user/password in the VI would be a security risk and is intentionally not supported.

## Webhook server

Each camera supports `SetPushV20`, which configures an HTTP URL the camera POSTs to whenever an event fires. With ReoLox the URL is:

```
http://<ioBroker-IP>:<port>/reolox/<cameraName>?secret=<shared-secret>
```

The adapter sets this URL automatically on every enabled camera at startup. If the camera firmware does not support `SetPushV20` (Reolink Doorbell PoE FW `v3.0.0.4662` does not — the adapter falls back to polling for that camera). You can also configure the URL manually in the camera web UI under **Alarm → Push** if needed.

Recognised event types on the receiver:

| Type | What it does |
|---|---|
| `visitor` / `doorbell` / `ring` | sets `status.visitorDetected` + `status.doorbellRing` (auto-pulses 1 s) and sends `Visitor` to Loxone. If Intercom is enabled, also sends the RTSP URL |
| `md` / `motion` | sets `status.motionDetected` + `lastMotionTime` and sends `Motion` to Loxone |
| `people` / `person` | sets `status.personDetected` and sends `AI_person` |
| `vehicle` | sets `status.vehicleDetected` and sends `AI_vehicle` |
| `dog_cat` / `animal` | sets `status.animalDetected` and sends `AI_animal` |

If the POST has an empty body (some doorbell firmwares do this on press) the request is treated as a `visitor` pulse — the source IP confirms which camera it came from.

## Snapshot capture

`control.snapshot` is a momentary button: write `true` to capture a JPEG. The result is:

- saved to `<iobroker-data>/reolox.0/snapshots/<cam>.jpg` (same filename per camera, so the URL is hot-linkable)
- mirrored as a `data:image/jpeg;base64,…` string in `snapshot.image`
- timestamp recorded in `snapshot.timestamp`
- file path published in `snapshot.file`

When *Auto-capture snapshot on motion* is enabled in the Advanced tab a snapshot is captured on every motion start. Snapshots older than the configured retention are pruned automatically.

## PTZ control

Available only for cameras whose `GetAbility` reports PTZ support. Write to `ptz.command` to issue a movement (`Left`, `Right`, `Up`, `Down`, `LeftUp`, etc.). The current `ptz.speed` value (1–64) is applied. To jump to a preset write the index to `ptz.goToPreset`. To stop any motion write `true` to `ptz.stop`. `ptz.patrol` toggles auto patrol on or off.

## White LED & spotlight

If the camera reports `ledControl.permit > 0` in `GetAbility` (i.e. the API user has admin-level permission), the adapter exposes:

- `status.whiteLed` — live state polled from the camera
- `control.whiteLed` — write target state (the adapter debounces user writes so the next poll does not flicker the value back)

`SetWhiteLed` is called via the token-less direct-auth endpoint because some firmwares (notably CX810) reject the token form for this command.

If `ledControl.permit` is `0`, change the camera's API user to **Admin** role in the camera's web UI under *Device Settings → User Management*. Guest accounts cannot toggle the WhiteLed.

## Gate trigger

The intent is: someone approaches the gate, taps something simple, the gate opens via Loxone. ReoLox currently ships **one** mechanism for this — the *WhiteLed knock-pattern*. It works but has limitations worth knowing about.

**How it works.** With *Gate* enabled in the Cameras tab the adapter polls `GetWhiteLed` on that camera at 1 Hz. If the WhiteLed turns ON and then OFF within 3 seconds the adapter treats the brief flash as an intentional knock and:

- sets `status.whiteLedTrigger` to `true` (pulsed for 1 s)
- sends `gate_trigger=1` to Loxone on `<prefix>_<camera>_gate_trigger`

A user in front of the camera triggers it by tapping the WhiteLed in the Reolink mobile app (briefly turn ON, then OFF).

**Limitations.**

- The Reolink API does not push WhiteLed state changes — the adapter has to poll. With a 1 s interval a very short tap can be missed if it falls between two samples.
- `SetWhiteLed` requires the camera user to be Admin. Guest accounts cannot toggle it.
- Cameras that do not expose `ledControl` (no spotlight hardware) cannot use this method.
- App round-trip latency varies — 1–3 s from tap to detection is typical.

**Recommended alternatives** if knock-pattern is too unreliable for you:

- **HTTP shortcut from phone.** Create an iOS *Shortcut* or Android *Tasker* action that POSTs to a small ioBroker REST endpoint or directly to the Loxone Miniserver Virtual Input. One tap from your home-screen — no polling, no camera involvement, latency under 200 ms.
- **NFC tag at the gate.** Same idea, triggered by tapping a tag with the phone. Works without unlocking on most Android devices.
- **Loxone Geofencing.** Configure a geo-zone in the Loxone app — the Miniserver receives the enter/exit event natively. Best for hands-free.
- **AI-person detection in a zone.** Set up a motion zone covering only the approach path and use `status.personDetected` as the trigger. Works hands-free but is prone to false positives from delivery / neighbours.

If you want a dedicated webhook endpoint on the adapter (e.g. `POST /reolox/gate/<camera>?secret=…`) so the iOS Shortcut talks straight to ReoLox instead of Loxone — file an issue and it can be added.

## Auto-discovery

The Cameras tab has a *🔍 Discover* button that runs an ONVIF WS-Discovery probe (UDP multicast to `239.255.255.250:3702`) and lists every Reolink device that responds. Each candidate is then probed with `GetDevInfo` to extract model, firmware and serial.

The discovery feature only finds devices — it does not add them to the camera list automatically. Copy the IP and add a row manually.

## Camera-specific notes

**Reolink CX810 / CX820**

- AI detection is reported as available by `GetAbility` but the firmware exposes no usable AI states (`GetAiState` returns all-zero). The adapter creates the AI states for consistency but they never go true.
- WhiteLed works only with an Admin user.

**Reolink Video Doorbell PoE (FW v3.0.0.4662)**

- `GetDoorbell` returns `rspCode = -9 not supported`. The adapter detects this and falls back to webhook push for ring events. Make sure to enable the webhook server and point the camera's push URL at `http://<ioBroker>:7777/reolox/<cam>?secret=…`.
- Two-way audio (intercom) is not part of ReoLox — use Loxone Intercom with the RTSP URL the bridge provides.

**Reolink RLC-810A and other PoE cameras**

- Standard behaviour. Motion + AI + snapshots + RTSP all work via the Reolink HTTP API.

**ONVIF PullPoint** is **not** supported by current Reolink firmware (v3.x returns `SOAP-ENV:Client`). Earlier ReoLox versions tried to use it; the current release uses only the Reolink HTTP API plus optional push webhook.

## Troubleshooting

**Camera shows offline / login fails.** Confirm the camera user role is **Admin** (Guest accounts cannot log in via the HTTP API on most firmwares). Check the IP, port and TLS settings. Try `iobroker logs reolox --watch` and look for `Login error`.

**WhiteLed control does nothing.** The camera reports `ledControl.permit = 0`. Change the API user to Admin in the camera's web UI: *Device Settings → User Management*.

**AI detection always false.** CX810 / CX820 firmware does not expose AI states. RLC-810A and Doorbell PoE do.

**Doorbell button events not arriving.** Either `GetDoorbell` returns `-9 not supported` on this firmware, or polling is too slow. Enable the *Webhook server*, set the *ioBroker IP* and a *Shared secret*; the adapter will configure the camera's push URL automatically. Verify in the logs that the camera POSTs reach the server.

**Webhook POST returns 403.** Source IP not in the allowlist. Either set *Source IP allowlist* to `auto` (the default) so it follows the camera list, or add the IP explicitly.

**Webhook POST returns 401.** Missing or wrong shared secret. The auto-configured push URLs include it; if you changed the secret after first start, click *Save & Close* on the adapter config to re-push the URLs.

**Snapshot fails.** Permission issue — confirm the API user has snapshot rights on the camera (most Admin users do).

**Loxone events not arriving.** Check the *Loxone* tab is enabled, the host is reachable, and credentials are correct. With Token Auth turned on the first call performs the HMAC handshake — look for `Token acquired` in the debug logs. If you see `Token auth failed (… ), falling back to Basic` your Miniserver is Gen 1 or pre-v10.2; that's fine, Basic still works.

**Adapter restarts on shutdown / unload.** Should not happen — all timers and the webhook server are tracked and cancelled deterministically. If you see it please file an issue with the full log.

## Known limitations

- **ONVIF PullPoint** unsupported by Reolink firmware v3.x — removed from the adapter
- **`GetDoorbell`** returns `-9 not supported` on Reolink Video Doorbell PoE FW v3.0.0.4662 — webhook push covers this
- **AI** on CX810 / CX820 not implemented in firmware
- **Loxone Cloud Remote Connect** does not proxy local URLs — Intercom RTSP needs VPN or port forwarding to be reachable away from home
- **MJPEG re-streaming** is not part of ReoLox; if Loxone Intercom needs MJPEG (some Touch panels do) deploy a separate `go2rtc` instance and point Loxone at it directly
- **Reolink HTTP API** is undocumented officially; this adapter is reverse-engineered from the official mobile app and community knowledge. Firmware updates can change behaviour without notice

## Development

```bash
git clone https://github.com/KPIotr89/ioBroker.reolox.git
cd ioBroker.reolox
npm install
npm run lint
npm test            # unit tests + package validation
```

Test layout:

```
test/unit/           mocha + chai + nock — lib/ modules
test/package/        @iobroker/testing — io-package.json + package.json sanity
.mocharc.yml         shared mocha config
```

CI (`.github/workflows/test-and-release.yml`) runs `lint` then the test matrix on every push and PR.

To wire up a fresh instance against a real ioBroker for integration tests use `npm run test:integration` — this requires the adapter to be installed in a local ioBroker.

## License

MIT © Piotr Kalbarczyk
