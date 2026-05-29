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

ReoLox connects every Reolink camera and NVR on your LAN to ioBroker and Loxone over the local Reolink HTTP API — **no cloud, no MQTT, no Node-RED bridge**. Events flow to the Miniserver as Virtual Inputs in real time; control flows back from Loxone Virtual Outputs straight into the cameras. Camera passwords are stored encrypted by ioBroker.

## Features

**Events → ioBroker & Loxone**
- Motion (AI-derived) and AI person / vehicle / animal / face
- Doorbell ring & visitor — polling **and** push webhook
- Online heartbeat, WhiteLed gate-trigger, Intercom RTSP-URL on ring

**Camera & NVR control** — ioBroker states *and* Loxone Virtual Outputs
- Status LED, SD recording, push (master + per type), White LED (on/off · brightness · mode), OSD, motion sensitivity, audio alarm / siren, IR lights, ISP image, PTZ, snapshot, reboot
- NVR per channel: recording, motion, AI, push

**Loxone bridge**
- HTTP Virtual Inputs (Token Auth HMAC-SHA1, proactive refresh, auto-fallback to Basic) or UDP
- **Built-in HTTP control endpoint** — Loxone Virtual Outputs drive any control state directly, *no `simple-api` needed*

**Reliability & security**
- Poll scheduler (jitter · per-task mutex · exponential backoff), deterministically tracked timers, singleflight login, firmware-aware disk capability cache
- Webhook hardened with IP allowlist + constant-time shared secret + 64 KB body cap; encrypted credentials; credential-free public stream URLs
- 62 unit + 39 package tests · CI on Linux / macOS / Windows × Node 18 / 20 / 22

## Quick start

```bash
iobroker url https://github.com/KPIotr89/ioBroker.reolox
```

Then **Admin → Adapters → ReoLox → Add instance** and open the configuration:

1. **Cameras** — add a row per camera (name, IP, admin user/password). Click **🔍 Discover** to find devices on the LAN.
2. **Loxone** — enable the bridge, enter the Miniserver IP and a user that may write Virtual Inputs. Use the **Generate** button to get the exact VI names to create in Loxone Config.
3. **Webhook** (recommended for doorbells) — enable the server, set the ioBroker IP and a shared secret; push URLs are configured on the cameras automatically.

No external services required (go2rtc / Node-RED / MQTT are **not** needed).

## Configuration — Cameras tab

| Field | Notes |
|---|---|
| **On** | Enable / disable polling without deleting the row |
| **Name** | ioBroker state id and the camera part of every Loxone VI. `a–z A–Z 0–9 _ -` + space, unique |
| **IP / Host · Port · TLS** | LAN address; default port 80 (443 with TLS, self-signed accepted) |
| **User / Password** | Camera account — **Admin** role required for WhiteLed and most setters |
| **Ch** | Channel index — `0` for standalone, `0–15` for NVR channels |
| **Poll s** | Polling interval, default **1 s** (per-row override of the global default) |
| **Gate** | Fast WhiteLed knock-pattern gate trigger for this camera |
| **Doorbell** | Force visitor/doorbell capability on (firmware that misreports `GetDoorbell`); visitor arrives via webhook as a 1 s pulse |
| **NVR** | Treat the row as a Reolink NVR — channels are discovered and exposed under `reolox.0.<nvr>.chN.*` |
| **→ Loxone** | Keep the row in ioBroker but stop forwarding its events (silence duplicate VIs) |

> Loxone and Webhook tab fields, plus the full validation order, are documented under **Advanced → Configuration reference**.

## Loxone integration

**Virtual Inputs** use the pattern `<prefix>_<camera>_<event>` (prefix default `ReoLox`). For a camera `garaz`:

```
ReoLox_garaz_Motion        ReoLox_garaz_AI_person     ReoLox_garaz_AI_vehicle
ReoLox_garaz_AI_animal     ReoLox_garaz_Online        ReoLox_garaz_Visitor   (1 s pulse)
ReoLox_garaz_gate_trigger  ReoLox_garaz_whiteLed      ReoLox_garaz_intercom  (RTSP URL)
```

The exact names are also written to `reolox.0.<cam>.loxone.vi*` at startup — copy them from there, or use **Generate** in the Loxone tab (it expands NVR rows into per-channel entries).

**Control from Loxone (Virtual Outputs).** The webhook server also accepts control commands, so a Virtual Output writes any control state directly — no extra adapter:

```
GET http://<iobroker>:<port>/reolox/cmd/<state.path>/<value>?secret=…
```

| Use | Example |
|---|---|
| digital on/off | `…/cmd/taras.control.whiteLed/1` · `…/0` |
| analog (Loxone inserts `<v>`) | `…/cmd/taras.control.whiteLedBrightness/<v>` |
| NVR channel | `…/cmd/nvr.ch3.control.recording/0` |

The Miniserver IP (Loxone tab) and localhost are accepted **without** the shared secret; any other allowlisted IP must append `?secret=…`. Only writable `*.control.*` states are accepted; values are coerced to the state type. In **Loxone Config → Peripherals → Virtual Outputs** add an output with address `http://<iobroker>:<port>` and a command `/reolox/cmd/<state>/<value>` (method `GET`).

## Compatibility

| Component | Tested with |
|---|---|
| ioBroker js-controller / admin | ≥ 5.0 / ≥ 6.0 |
| Node.js | 18 · 20 · 22 |
| Reolink cameras | v3.x firmware — CX810, CX820, Video Doorbell PoE, RLC-810A |
| Reolink NVR | RLN8-410 verified (RLN16 / RLN36 should work) |
| Loxone Miniserver | Gen 1 (Basic) · Gen 2 (Token Auth, HMAC-SHA1) |

## FAQ

<details>
<summary><b>Can I control cameras from Loxone without the simple-api adapter?</b></summary>

Yes. The built-in control endpoint (see *Loxone integration*) lets a Loxone Virtual Output write any `*.control.*` state directly: `GET /reolox/cmd/<state.path>/<value>?secret=…`. It is enabled by default (Webhook tab → *Allow Loxone control commands*) and trusts the Miniserver IP automatically.

</details>

<details>
<summary><b>A camera shows offline / login fails.</b></summary>

Confirm the camera user has the **Admin** role (Guest accounts usually cannot use the HTTP API). Check IP, port and TLS. Look for `Login error` in `iobroker logs reolox`.

</details>

<details>
<summary><b>WhiteLed control does nothing.</b></summary>

The camera reports `ledControl.permit = 0` — the API user is not Admin. Promote it in the camera web UI: *Device Settings → User Management*. On CX810/CX820 the adapter already uses the minimal direct-auth `SetWhiteLed` payload these models require.

</details>

<details>
<summary><b>Doorbell button events don't arrive.</b></summary>

Either the firmware returns `GetDoorbell -9 not supported` (Doorbell PoE v3.0.0.4662) or 1 s polling is too slow for a button press. Enable the **Webhook server**, set the *ioBroker IP* and a *Shared secret*; the push URL is configured on the camera automatically. Verify the POSTs reach the server in the log.

</details>

<details>
<summary><b>Webhook / control returns 403 or 401.</b></summary>

**403** — source IP not allowed. The allowlist can mix `auto` (camera hosts) with explicit IPs (e.g. `auto, 192.168.0.175`); control additionally accepts the Miniserver IP and always loopback (`127.0.0.1`, handy for `curl` on the host). A request from your PC/browser is rejected unless you add its IP. **401** — missing/wrong shared secret on a non-trusted source. The Miniserver IP and localhost skip the secret on `/reolox/cmd`; any other IP must include it (this is the *Webhook* shared secret, not the camera password).

</details>

<details>
<summary><b>AI detection is always false.</b></summary>

`person` / `vehicle` / `animal` work on CX810 / CX820 / Doorbell PoE / RLC-810A. `face` is reported as `support: 0` on these models, so the `AI_face` VI never fires — don't create it in Loxone for them.

</details>

<details>
<summary><b>Loxone events don't arrive.</b></summary>

Check the *Loxone* tab is enabled, the host is reachable and credentials are correct. With Token Auth the first call performs the HMAC handshake (`Token acquired` in debug logs). `Token auth failed … falling back to Basic` simply means a Gen 1 / pre-v10.2 Miniserver — Basic still works.

</details>

<details>
<summary><b>How do I open a gate by tapping my phone?</b></summary>

The WhiteLed knock-pattern (*Gate* checkbox) works but relies on 1 Hz polling. More reliable: an iOS *Shortcut* / Android *Tasker* action (or NFC tag) that calls the control endpoint or a Loxone Virtual Input directly — sub-200 ms, no camera involvement. Loxone Geofencing is best for hands-free.

</details>

## Advanced

<details>
<summary><b>Architecture & source layout</b></summary>

```
                     ┌─────────────────────────────────────────────────┐
   ┌───────────┐     │   ReolinkAPI ───────────── LoxoneBridge          │   ┌────────────────────┐
   │  Reolink  │◄────┼──► (login SF, retry)        (HTTP token / UDP) ◄──┼──►│ Loxone Miniserver  │
   │  cameras  │     │                                                  │   │ VIs · VOs · Touch  │
   └───────────┘     │   WebhookServer ─────────── PollScheduler        │   └────────────────────┘
   Reolink push ─POST┼──► (allowlist · secret ·    (jitter · mutex ·    │
                     │     64 KB cap · /cmd)        backoff)            │
                     │   TimerManager · CapabilityCache (disk, TTL)     │
                     └──────────────────────┬──────────────────────────┘
                                            ▼  ioBroker objects  (reolox.0.<cam>.*)
```

```
main.js                 # adapter orchestrator
lib/
  reolink-api.js        # HTTP client per camera (token auth, retry/backoff, batch)
  loxone-bridge.js      # Loxone HTTP (token/basic) + UDP
  webhook-server.js     # /reolox/<cam> push receiver + /reolox/cmd control endpoint
  poll-scheduler.js     # periodic task supervisor
  timer-manager.js      # tracked setTimeout/setInterval
  capability-cache.js   # GetAbility disk cache (firmware-aware)
  discovery.js          # ONVIF WS-Discovery probe
  safe-log.js           # CRLF / password / token redaction
admin/jsonConfig.json   # admin UI (i18n: en/pl/de)
test/                   # mocha + chai + nock, @iobroker/testing
```

</details>

<details>
<summary><b>Configuration reference — Loxone & Webhook tabs</b></summary>

**Loxone tab:** Enable integration · Miniserver IP · HTTP port (80) · Username/Password (encrypted) · Authentication `Token` (recommended) or `Basic` · Communication mode `HTTP` / `UDP` / both · UDP port (7000) · Virtual Input prefix (`ReoLox`) · Enable Loxone Intercom (RTSP URL to `<prefix>_<camera>_intercom` on ring).

**Webhook tab:** Enable server · Listen port (7777) · ioBroker IP (used to auto-configure each camera's push URL) · Shared secret (encrypted) · Source IP allowlist (`auto`, explicit IPs, or both — `auto, 192.168.0.175`) · **Allow Loxone control commands** (default on).

**Request validation order:** method → path under `/reolox/` → source IP in allowlist → shared secret (constant-time) → body ≤ 64 KB (else `413`). The `/reolox/cmd/…` control route also accepts the Miniserver IP and loopback, allows `GET`, and skips the shared secret for those two trusted sources (any other IP still needs it).

</details>

<details>
<summary><b>Object tree (per camera <code>reolox.0.&lt;cam&gt;</code>)</b></summary>

```
info/      connection, model, name, firmware, serial, hardwareVersion, channelCount
status/    motionDetected, personDetected, vehicleDetected, animalDetected, faceDetected,
           lastMotionTime, visitorDetected, doorbellRing, whiteLed, whiteLedTrigger
control/   snapshot, reboot, irLights(Auto/On/Off), whiteLed, whiteLedBrightness(0-100),
           whiteLedMode, statusLed, recording, notificationsEnabled,
           notify{Motion,Person,Vehicle,Animal,Visitor}, osdText, osdShowDateTime,
           motionSensitivity(0-100), siren(pulse), sirenManual(on/off), audioAlarmDuration, audioAlarmSound
ptz/       command, speed(1-64), goToPreset, patrol, stop          (only if PTZ supported)
image/     brightness, contrast, saturation, sharpness (0-255)
streams/   rtspMainPublic, rtspSubPublic (no credentials), snapshotProxy
snapshot/  image(base64 data URL), timestamp, file
storage/   hddCapacity, hddUsed (MB)
loxone/    viMotion, viPerson, viVehicle, viOnline, viVisitor, viIntercom, viGateTrigger
```

NVR rows expose `reolox.0.<nvr>.info.*` and per channel `reolox.0.<nvr>.chN.{info,status,control}.*`.
Writable states (`control.*`, `ptz.*`, `image.*`) act on write; `control.whiteLed` is debounced 3 s so polling doesn't flicker the value back.

</details>

<details>
<summary><b>NVR support</b></summary>

A Reolink NVR is a single row with the **NVR** flag. At startup ReoLox reads `GetDevInfo` + `GetChannelstatus`, then for each online channel creates an info/status/control sub-tree. One poller batches `GetMdState` + `GetAiState` for **all** online channels into a single HTTP request per cycle. On a token expiry the batch re-logins once; if it still returns nothing the NVR is marked offline.

Loxone VIs are `<prefix>_<nvrName>_<channelName>_<event>` (e.g. `ReoLox_NVR_Front_AI_person`). A camera attached to an NVR can also be added as a standalone row; use **→ Loxone** on the NVR row to keep its state tree but silence duplicate VIs.

</details>

<details>
<summary><b>Webhook server & push events</b></summary>

Each camera's `SetPushV20` is configured to POST to `http://<ioBroker-IP>:<port>/reolox/<cameraName>?secret=…`, set automatically at startup. Firmware without `SetPushV20` (Doorbell PoE v3.0.0.4662) falls back to polling; configure the URL manually under *Alarm → Push* if needed.

Recognised types: `visitor`/`doorbell`/`ring` (→ visitorDetected + doorbellRing, 1 s pulse, Intercom RTSP if enabled), `md`/`motion`, `people`/`person`, `vehicle`, `dog_cat`/`animal`. An empty POST body (some doorbells) is treated as a visitor pulse, resolved by source IP.

</details>

<details>
<summary><b>Loxone Token Auth handshake</b></summary>

1. `GET /jdev/sys/getkey2/<user>` → `{ key, salt, hashAlg }`
2. `pwHash = uppercase(SHA1(password + ":" + salt))`
3. `hmac = HMAC-SHA1(key, user + ":" + pwHash)`
4. `GET /jdev/sys/getjwt/<hmac>/<user>/4/iobroker-reolox/iobroker` → token + `validUntil`
5. subsequent calls append `?autht=<token>&user=<user>`

The token is refreshed at 80 % of its lifetime. Any failure (typically Gen 1 Miniservers) falls back to Basic for the session.

</details>

<details>
<summary><b>Snapshot · PTZ · White LED · Gate trigger</b></summary>

**Snapshot** — write `true` to `control.snapshot`: JPEG saved to `<iobroker-data>/reolox.0/snapshots/<cam>.jpg`, mirrored as a base64 data URL in `snapshot.image`, with `snapshot.timestamp` / `snapshot.file`. For a still in Loxone, point a Picture element at a go2rtc frame URL; for notifications, send `snapshot.file` via Telegram from a script.

**PTZ** — only when `GetAbility` reports PTZ. Write `ptz.command` (`Left`/`Right`/`Up`/`Down`/…/`Stop`/`Auto`) at `ptz.speed` (1–64); `ptz.goToPreset` jumps to an index; `ptz.stop` halts; `ptz.patrol` toggles patrol.

**White LED** — exposed when `ledControl.permit > 0` (Admin user). `status.whiteLed` is polled; `control.whiteLed` writes a minimal `SetWhiteLed` payload (CX-series reject the full form with `rspCode -13`).

**Gate trigger** — with *Gate* enabled the adapter polls `GetWhiteLed` at 1 Hz; a ≤ 3 s ON→OFF flash pulses `status.whiteLedTrigger` and sends `gate_trigger=1`. Polling means a very short tap can be missed — see the gate FAQ for faster alternatives.

</details>

<details>
<summary><b>Camera-specific notes</b></summary>

- **CX810 / CX820** — AI person/vehicle/animal work; `face` is unsupported (`support: 0`). WhiteLed needs an Admin user and uses the minimal payload (mode `3` for manual on; mode `1` is rejected).
- **Video Doorbell PoE (v3.0.0.4662)** — `GetDoorbell -9 not supported`; use the webhook push path. Two-way audio is out of scope — use Loxone Intercom with the RTSP URL the bridge provides.
- **RLC-810A & other PoE cameras** — standard behaviour, everything via the Reolink HTTP API.
- **ONVIF PullPoint** is not supported by current Reolink firmware (returns `SOAP-ENV:Client`); only the HTTP API + push webhook are used. ONVIF WS-Discovery is still used by the *Discover* button.

</details>

<details>
<summary><b>Known limitations</b></summary>

- `GetDoorbell` unsupported on Doorbell PoE v3.0.0.4662 (push covers it)
- `face` AI not supported on CX-series
- Loxone Cloud Remote Connect does not proxy local URLs — Intercom RTSP needs VPN / port forwarding away from home
- MJPEG re-streaming is out of scope — deploy `go2rtc` separately if a Touch panel needs MJPEG
- The Reolink HTTP API is unofficial; firmware updates may change behaviour

</details>

<details>
<summary><b>Development</b></summary>

```bash
git clone https://github.com/KPIotr89/ioBroker.reolox.git
cd ioBroker.reolox
npm install
npm run lint
npm test            # unit (mocha/chai/nock) + package validation (@iobroker/testing)
```

CI (`.github/workflows/test-and-release.yml`) runs lint then the test matrix on every push and PR. `npm run test:integration` runs against a local ioBroker if installed.

</details>

## License

MIT © Piotr Kalbarczyk
