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

## What it does

ReoLox connects every Reolink camera in your home to ioBroker and Loxone. No cloud, no Node-RED, no MQTT bridge — the adapter talks directly to the camera's local HTTP API, exposes every state in ioBroker's object tree, and forwards events to your Loxone Miniserver in real time.

## Highlights

**Camera control**: motion, AI (person / vehicle / animal / face), doorbell button, IR lights, WhiteLed spotlight, PTZ with presets, ISP image settings, snapshots, RTSP / RTMP / FLV stream URLs.

**Direct Loxone bridge**: every event becomes a Virtual Input the Miniserver receives via HTTP (Token Auth, HMAC-SHA1) or UDP. Names follow the `ReoLox_<Camera>_<Event>` convention and are visible per camera in the `<camId>.loxone.*` states. Loxone Intercom integration ships the RTSP stream URL on doorbell ring.

**Push webhook (no polling for doorbell)**: a local HTTP server receives Reolink push events. Hardened with source-IP allowlist, shared-secret authentication, 64 KB body cap, and CRLF-sanitised logging.

**Gate trigger over WhiteLed**: a brief `≤3 s` ON→OFF flash from the Reolink app sends `gate_trigger=1` to Loxone. Useful for opening a gate when the camera owner is approaching.

**go2rtc-ready**: optional re-stream URL so Loxone Intercom and Touch panels can show MJPEG without burning credentials.

**Auto-discovery**: the Admin panel finds Reolink cameras via ONVIF WS-Discovery in seconds.

## Compatibility

| Component | Tested with |
|---|---|
| ioBroker js-controller | ≥ 5.0 |
| ioBroker admin | ≥ 6.0 |
| Node.js | 18, 20, 22 |
| Reolink firmware | v3.x (CX810 / Doorbell PoE / RLC-810A) |
| Loxone Miniserver | Gen 1 (Basic Auth) / Gen 2 (Token Auth) |

## Install

```bash
iobroker url https://github.com/KPIotr89/ioBroker.reolox
```

Then add cameras in **Admin → Adapters → ReoLox → Configuration**.

## Configuration overview

### Cameras tab
Add each camera (IP, user, password, channel for NVR multi-channel devices). The discover button performs an ONVIF probe. Camera passwords are stored encrypted by ioBroker (`protectedNative`).

### Loxone tab
Enable the bridge, set the Miniserver IP and credentials. Pick **Token Auth** (recommended) — the adapter does the HMAC-SHA1 handshake and refreshes tokens proactively at 80 % of their lifetime. The Virtual Input prefix is configurable (`ReoLox` by default).

### Webhook tab
Start the local HTTP server (default port `7777`). Set the ioBroker IP visible to cameras and — strongly recommended — a shared secret. The adapter sets the push URL on every camera at startup, so no manual setup in the Reolink web UI is needed.

### Advanced tab
Capability cache TTL, snapshot retention, debug logging.

## Loxone Virtual Inputs

For a camera named `garaz` (and the default prefix), create these inputs in Loxone Config — names are case-sensitive:

```
ReoLox_garaz_Motion          (digital)
ReoLox_garaz_AI_person       (digital)
ReoLox_garaz_AI_vehicle      (digital)
ReoLox_garaz_AI_animal       (digital)
ReoLox_garaz_Online          (digital)
ReoLox_garaz_Visitor         (digital, pulse 1s on ring)
ReoLox_garaz_gate_trigger    (digital, pulse 1s on knock-pattern)
ReoLox_garaz_intercom        (text, RTSP URL on ring — for Intercom)
ReoLox_garaz_whiteLed        (digital, mirrors spotlight state)
```

The exact VI names per camera are also written to `<camId>.loxone.vi*` states once the instance starts.

## Migration from v1.x (`reolink-loxone`)

v2.0 is a breaking rename. **State paths change** (`reolink-loxone.0.*` → `reolox.0.*`) and so does the **Loxone VI prefix** (`Reolink_*` → `ReoLox_*`). To migrate:

1. Stop the old instance (`iobroker stop reolink-loxone.0`).
2. Install ReoLox (`iobroker url https://github.com/KPIotr89/ioBroker.reolox`).
3. Configure the new instance — settings are not migrated automatically.
4. In **Loxone Config**, search-and-replace `Reolink_` → `ReoLox_` across your VI names (or set `loxoneViPrefix = "Reolink"` in ReoLox to keep the old prefix).
5. Once the new instance is healthy, remove the old one (`iobroker del reolink-loxone.0`).

## go2rtc integration

ReoLox does not embed go2rtc; pair it with a separate instance for re-streaming. Example `/etc/go2rtc/go2rtc.yaml`:

```yaml
streams:
  front: rtsp://loxone:loxone123@192.168.0.48:554/h264Preview_01_main
  taras: rtsp://loxone:loxone123@192.168.0.49:554/h264Preview_01_main
  garaz: rtsp://loxone:loxone123@192.168.0.61:554/h264Preview_01_main
```

Then in the ReoLox Webhook tab set `go2rtc base URL` to `rtsp://<ip>:8554`. On doorbell ring the bridge will send `rtsp://<ip>:8554/<camera>` to the Intercom VI.

## Service commands

```bash
iobroker upload reolox          # refresh admin assets
iobroker restart reolox.0       # restart instance
iobroker logs reolox --watch    # tail logs
```

## License

MIT © Piotr Kalbarczyk
