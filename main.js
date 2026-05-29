'use strict';

const utils = require('@iobroker/adapter-core');
const fs = require('fs');
const path = require('path');

const ReolinkAPI = require('./lib/reolink-api');
const LoxoneBridge = require('./lib/loxone-bridge');
const TimerManager = require('./lib/timer-manager');
const PollScheduler = require('./lib/poll-scheduler');
const CapabilityCache = require('./lib/capability-cache');
const { WebhookServer } = require('./lib/webhook-server');
const { discoverReolinkCameras } = require('./lib/discovery');
const { sanitize } = require('./lib/safe-log');

const GATE_TRIGGER_WINDOW_MS = 3000;
const GATE_TRIGGER_PULSE_MS = 1000;
const VISITOR_PULSE_MS = 1000;
const USER_WRITE_DEBOUNCE_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 60_000;  // Periodic Online refresh to Loxone
const SIREN_HOLD_REFIRE_MS = 2800;     // Re-fire a 1-repeat siren pulse (~2.5s each) to emulate a held siren; >2.5s avoids overlap/queueing — a brief gap is harmless

/**
 * ReoLox — Reolink ↔ Loxone integration adapter for ioBroker.
 *
 * The adapter is intentionally a thin orchestrator that owns the following
 * collaborators:
 *
 *   - TimerManager:    tracks every setTimeout / setInterval for clean unload
 *   - PollScheduler:   runs periodic tasks with jitter & backoff
 *   - ReolinkAPI:      HTTP wrapper per camera
 *   - LoxoneBridge:    pushes events to the Miniserver (HTTP token / UDP)
 *   - WebhookServer:   receives Reolink push notifications
 *   - CapabilityCache: persists GetAbility responses across restarts
 *
 * Every cross-cutting concern (sanitised logging, password redaction,
 * input validation) lives in lib/ helpers, not here.
 */
class ReoLoxAdapter extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'reolox' });

        /** @type {Map<string, ReolinkAPI>} */
        this.cameras = new Map();

        /** @type {Map<string, object>}  camId → camConfig */
        this.camConfigs = new Map();

        /** @type {Map<string, object>}  camId → capabilities */
        this.capabilities = new Map();

        /** @type {Map<string, any>} per-camera transient state */
        this.lastStates = new Map();

        /** Suppresses poll-driven `control.whiteLed` overrides right after a user write. */
        this.userWriteAt = new Map();

        /** @type {Map<string, NodeJS.Timeout>} camId → siren-hold re-fire interval (software-held siren) */
        this.sirenLoops = new Map();

        this.timers = new TimerManager();
        this.loxoneBridge = null;
        this.webhookServer = null;
        this.scheduler = null;
        this.capabilityCache = null;

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    // ─── LIFECYCLE ────────────────────────────────────────────────────────

    async onReady() {
        this.log.info(`Starting ReoLox v${this._packageVersion()} — instance ${this.namespace}`);

        // Capability cache (disk)
        try {
            const dir = path.join(utils.getAbsoluteInstanceDataDir(this), 'cache');
            const ttl = (this.config.capabilityCacheTtlHours || 24) * 60 * 60 * 1000;
            this.capabilityCache = new CapabilityCache({ dir, ttlMs: ttl, log: this.log });
        } catch (e) {
            this.log.warn(`Capability cache disabled: ${sanitize(e.message)}`);
        }

        // Poll scheduler
        this.scheduler = new PollScheduler({ timerManager: this.timers, log: this.log });

        // Loxone bridge
        if (this.config.loxoneEnabled && this.config.loxoneHost) {
            this.loxoneBridge = new LoxoneBridge({
                host: this.config.loxoneHost,
                port: this.config.loxonePort || 80,
                username: this.config.loxoneUser || '',
                password: this.config.loxonePassword || '',
                udpPort: this.config.loxoneUdpPort || 7000,
                mode: this.config.loxoneMode || 'http',
                auth: this.config.loxoneAuth || 'token',
                prefix: this.config.loxoneViPrefix || 'ReoLox',
                timerManager: this.timers,
                log: this.log,
            });
            this.log.info(`Loxone bridge: ${sanitize(this.config.loxoneHost)} mode=${this.config.loxoneMode} auth=${this.config.loxoneAuth || 'token'} prefix=${this.config.loxoneViPrefix || 'ReoLox'}`);
        }

        // Validate camera list (uniqueness check)
        const cameras = Array.isArray(this.config.cameras) ? this.config.cameras : [];
        if (cameras.length === 0) {
            this.log.warn('No cameras configured. Add cameras in the adapter settings.');
        }
        const idSeen = new Set();
        for (const c of cameras) {
            const id = this.sanitizeId(c.name || `cam_${c.host || 'unknown'}`);
            if (idSeen.has(id)) {
                this.log.error(`Duplicate camera id "${id}" — rename the camera in settings.`);
                return;
            }
            idSeen.add(id);
        }

        // Start webhook server BEFORE cameras so push auto-config can target it.
        if (this.config.webhookEnabled && this.config.webhookPort) {
            await this._startWebhookServer();
        }

        // Initialise every enabled camera.
        for (const camConfig of cameras) {
            if (!camConfig.enabled) continue;
            await this.initCamera(camConfig);
        }

        // Update webhook server with the live camera list (for allowlist).
        if (this.webhookServer) {
            this.webhookServer.setCameras(this.camConfigs);
        }

        // Only writable branches need change events; subscribing to read-only
        // info/status/streams would just generate ack=true noise through onStateChange.
        this.subscribeStates('*.control.*');
        this.subscribeStates('*.ptz.*');
        this.subscribeStates('*.image.*');
        this.log.info(`Started. ${this.cameras.size} camera(s) active, ${this.scheduler.size()} poll task(s).`);
    }

    async onUnload(callback) {
        try {
            if (this.scheduler) this.scheduler.dispose();
            if (this.webhookServer) await this.webhookServer.stop().catch(() => undefined);

            // Logout in parallel with a short cap so unload finishes promptly.
            const logouts = Array.from(this.cameras.values()).map((api) => Promise.race([
                api.logout().catch(() => undefined),
                new Promise((r) => setTimeout(r, 2000)),
            ]));
            await Promise.allSettled(logouts);
            this.cameras.clear();

            if (this.loxoneBridge) this.loxoneBridge.destroy();
            this.timers.dispose();

            callback();
        } catch (e) {
            this.log.debug(`Unload error: ${sanitize(e.message)}`);
            callback();
        }
    }

    _packageVersion() {
        try { return require('./package.json').version; } catch (_) { return '?'; }
    }

    // ─── CAMERA INIT ──────────────────────────────────────────────────────

    async initCamera(camConfig) {
        const camId = this.sanitizeId(camConfig.name || `cam_${camConfig.host}`);
        // NVR rows go through a different init path — they enumerate per-channel sub-states.
        if (camConfig.isNvr) {
            return this._initNvr(camConfig, camId);
        }
        this.log.info(`Initialising camera "${camId}" at ${sanitize(camConfig.host)}…`);

        const api = new ReolinkAPI({
            host: camConfig.host,
            port: camConfig.port || (camConfig.useHttps ? 443 : 80),
            username: camConfig.username,
            password: camConfig.password,
            channel: camConfig.channel || 0,
            useHttps: !!camConfig.useHttps,
            log: this.log,
        });

        try {
            await api.login();
            this.cameras.set(camId, api);
            this.camConfigs.set(camId, camConfig);

            const devInfo = await api.getDevInfo();
            const info = devInfo && devInfo.DevInfo || {};
            this.log.info(`Camera "${camId}" connected: ${sanitize(info.model || 'Reolink')} ${sanitize(info.name || '')} FW=${sanitize(info.firmVer || '?')}`);

            await this._detectCapabilities(camId, api, camConfig, info.firmVer);
            await this._createCameraObjects(camId, camConfig, info);
            await this._updateStreamUrls(camId, camConfig, api);
            await this._syncInitialControlState(camId, api, camConfig).catch((e) => this.log.debug(`Initial control sync failed for ${camId}: ${sanitize(e.message)}`));

            // Initial poll
            await this._pollMain(camId).catch((e) => this.log.debug(`Initial poll failed for ${camId}: ${sanitize(e.message)}`));

            // Schedule periodic tasks
            const intervalMs = Math.max(1, camConfig.pollInterval || this.config.defaultPollInterval || 5) * 1000;
            this.scheduler.add({
                key: `main:${camId}`,
                intervalMs,
                run: () => this._pollMain(camId),
            });

            // Optional 1-second WhiteLed poll for gate-trigger cameras.
            if (camConfig.whiteLedGateTrigger && this._hasCapability(camId, 'whiteLed')) {
                this.scheduler.add({
                    key: `wl:${camId}`,
                    intervalMs: 1000,
                    run: () => this._pollWhiteLed(camId),
                });
                this.log.info(`Camera "${camId}": fast WhiteLed poll (1s) enabled for gate trigger`);
            }

            // Auto-configure push URL on the camera if webhook is active.
            if (this.config.webhookEnabled && this.config.webhookHost && this.config.webhookPort) {
                const secretSuffix = this.config.webhookSharedSecret ? `?secret=${encodeURIComponent(this.config.webhookSharedSecret)}` : '';
                const webhookUrl = `http://${this.config.webhookHost}:${this.config.webhookPort}/reolox/${encodeURIComponent(camId)}${secretSuffix}`;
                try {
                    await api.setPush({ channel: camConfig.channel || 0, enable: 1, url: webhookUrl, scheduleEnable: 0 });
                    this.log.info(`Camera "${camId}": push URL set on camera`);
                } catch (e) {
                    this.log.warn(`Camera "${camId}": auto push-URL failed (${sanitize(e.message)}). Set manually in the camera web UI to: ${webhookUrl.replace(/secret=[^&]+/, 'secret=****')}`);
                }
            }
        } catch (err) {
            this.log.error(`Camera "${camId}" init failed: ${sanitize(err.message)}`);
            await this.setStateAsync(`${camId}.info.connection`, false, true).catch(() => undefined);
        }
    }

    // ─── CAPABILITY DETECTION ─────────────────────────────────────────────

    async _detectCapabilities(camId, api, camConfig, firmVer) {
        const caps = {
            ptz: false, whiteLed: false, siren: false,
            aiDetection: false, visitor: false, doorbell: false,
            motionDetection: true, irLights: true, recording: true, snapshot: true,
        };

        // Try disk cache first to skip ~50 KB GetAbility on cold start.
        let ability = null;
        if (this.capabilityCache) {
            ability = this.capabilityCache.get(api.host, api.port, api.username, firmVer);
            if (ability) this.log.debug(`Camera "${camId}": GetAbility loaded from cache`);
        }
        if (!ability) {
            try {
                ability = await api.getAbility();
                if (ability && this.capabilityCache) {
                    this.capabilityCache.set(api.host, api.port, api.username, ability, firmVer);
                }
            } catch (e) {
                this.log.debug(`Camera "${camId}" GetAbility unavailable, probing: ${sanitize(e.message)}`);
            }
        }

        if (ability) {
            const ab = (ability && ability.Ability) || ability || {};
            const chn = (ab.abilityChn && ab.abilityChn[0]) || {};

            if (ab.ptz && ab.ptz.ver > 0) caps.ptz = true;
            if (ab.ptzCtrl && ab.ptzCtrl.ver > 0) caps.ptz = true;
            if (chn.ptzCtrl && chn.ptzCtrl.ver > 0) caps.ptz = true;

            if (chn.aiTrack && chn.aiTrack.ver > 0) caps.aiDetection = true;
            if (ab.aiTrack && ab.aiTrack.ver > 0) caps.aiDetection = true;

            // White spotlight: supportWLLightAlarm (CX-series) or floodLight (RLC floodlights).
            // NOT ledControl — on doorbells that flag is the doorbell-ring light, not a spotlight
            // (doorbell reports ledControl.permit=6 with NO white LED; CX820 reports ledControl=0 yet HAS one).
            const wlAbility = chn.supportWLLightAlarm || {};
            const flAbility = chn.floodLight || {};
            if (wlAbility.permit > 0 || wlAbility.ver > 0) caps.whiteLed = true;
            if (flAbility.permit > 0 || flAbility.ver > 0) caps.whiteLed = true;
            if (chn.alarmAudio && chn.alarmAudio.permit > 0 && chn.alarmAudio.ver > 0) caps.siren = true;
            if (chn.supportAiVisitor && (chn.supportAiVisitor.ver > 0 || chn.supportAiVisitor.permit > 0)) caps.visitor = true;
        }

        // Probe only for NON-doorbell cameras that didn't confirm via ability — doorbells
        // answer GetWhiteLed even with no spotlight, so the probe would false-positive them.
        if (!caps.whiteLed && !(camConfig && camConfig.isDoorbell)) {
            try { await api.getWhiteLed(); caps.whiteLed = true; } catch (_) { /* still false */ }
        }

        // Confirm doorbell hardware. User can force this on via the `isDoorbell`
        // checkbox — useful for firmwares that misreport GetDoorbell (e.g. Reolink
        // Video Doorbell PoE v3.0.0.4662 returns -9 not supported).
        if (camConfig && camConfig.isDoorbell) {
            caps.doorbell = true;
            caps.visitor = true;
            this.log.info(`Camera "${camId}": marked as doorbell by user — webhook visitor events will be honored.`);
        } else {
            try { await api.getDoorbell(); caps.doorbell = true; caps.visitor = true; }
            catch (_) { caps.doorbell = false; }
        }

        // Always probe GetAiState — Reolink misreports aiTrack.ver on CX-series.
        // If any AI type is supported per-type, we'll discover that during polling
        // (caps.aiDetection here is informational only).
        if (!caps.aiDetection) {
            try {
                const aiState = await api.getAiState();
                const ai = (aiState && aiState.AiState) || aiState || {};
                if ((ai.people && ai.people.support === 1)
                    || (ai.vehicle && ai.vehicle.support === 1)
                    || (ai.dog_cat && ai.dog_cat.support === 1)
                    || (ai.face && ai.face.support === 1)) {
                    caps.aiDetection = true;
                    this.log.debug(`Camera "${camId}": AI confirmed via GetAiState probe`);
                }
            } catch (_) { /* AI not available — leave caps.aiDetection=false */ }
        }

        this.capabilities.set(camId, caps);
        this.log.info(`Camera "${camId}" caps: PTZ=${caps.ptz} WhiteLED=${caps.whiteLed} Siren=${caps.siren} AI=${caps.aiDetection} Visitor=${caps.visitor} Doorbell=${caps.doorbell}`);
    }

    _hasCapability(camId, name) {
        const c = this.capabilities.get(camId);
        return c ? !!c[name] : false;
    }

    // ─── OBJECT TREE ──────────────────────────────────────────────────────

    async _createCameraObjects(camId, camConfig, info) {
        await this.setObjectNotExistsAsync(camId, {
            type: 'device',
            common: { name: camConfig.name || camId },
            native: { host: camConfig.host },
        });

        await this._channel(camId, 'info', 'Device Information');
        await this._state(camId, 'info.connection', 'Connection status', 'boolean', 'indicator.connected', false, false);
        await this._state(camId, 'info.model', 'Camera model', 'string', 'info.name', '', false);
        await this._state(camId, 'info.name', 'Camera name', 'string', 'info.name', '', false);
        await this._state(camId, 'info.firmware', 'Firmware version', 'string', 'info.firmware', '', false);
        await this._state(camId, 'info.serial', 'Serial number', 'string', 'info.serial', '', false);
        await this._state(camId, 'info.hardwareVersion', 'Hardware version', 'string', 'info.hardware', '', false);
        await this._state(camId, 'info.channelCount', 'Number of channels', 'number', 'value', 0, false);

        await this.setStateAsync(`${camId}.info.model`, info.model || '', true);
        await this.setStateAsync(`${camId}.info.name`, info.name || '', true);
        await this.setStateAsync(`${camId}.info.firmware`, info.firmVer || '', true);
        await this.setStateAsync(`${camId}.info.serial`, info.serial || '', true);
        await this.setStateAsync(`${camId}.info.hardwareVersion`, info.hardVer || '', true);
        await this.setStateAsync(`${camId}.info.channelCount`, info.channelNum || 1, true);

        await this._channel(camId, 'status', 'Camera Status');
        await this._state(camId, 'status.motionDetected', 'Motion detected', 'boolean', 'sensor.motion', false, false);
        await this._state(camId, 'status.personDetected', 'Person detected (AI)', 'boolean', 'sensor.motion', false, false);
        await this._state(camId, 'status.vehicleDetected', 'Vehicle detected (AI)', 'boolean', 'sensor.motion', false, false);
        await this._state(camId, 'status.animalDetected', 'Animal detected (AI)', 'boolean', 'sensor.motion', false, false);
        await this._state(camId, 'status.faceDetected', 'Face detected (AI)', 'boolean', 'sensor.motion', false, false);
        await this._state(camId, 'status.lastMotionTime', 'Last motion timestamp', 'number', 'date', 0, false);
        await this._state(camId, 'status.visitorDetected', 'Visitor detected', 'boolean', 'sensor.motion', false, false);
        await this._state(camId, 'status.doorbellRing', 'Doorbell button pressed', 'boolean', 'sensor', false, false);

        await this._channel(camId, 'streams', 'Video Streams');
        // Credential-free public stream URLs (safe to read from scripts / logs).
        await this._state(camId, 'streams.rtspMainPublic', 'RTSP main URL (no credentials)', 'string', 'url', '', false);
        await this._state(camId, 'streams.rtspSubPublic', 'RTSP sub URL (no credentials)', 'string', 'url', '', false);
        // Snapshot via adapter proxy: triggers `control.snapshot` and re-uses the saved JPEG.
        await this._state(camId, 'streams.snapshotProxy', 'Snapshot file path (refreshed by control.snapshot)', 'string', 'text', '', false);

        await this._channel(camId, 'control', 'Camera Control');
        await this._state(camId, 'control.snapshot', 'Trigger snapshot capture', 'boolean', 'button', false, true);
        await this._state(camId, 'control.reboot', 'Reboot camera', 'boolean', 'button', false, true);
        await this._state(camId, 'control.irLights', 'IR lights mode (Auto/On/Off)', 'string', 'level.color.temperature', 'Auto', true, { states: { Auto: 'Auto', On: 'On', Off: 'Off' } });

        if (this._hasCapability(camId, 'whiteLed')) {
            await this._state(camId, 'control.whiteLed', 'White LED / spotlight', 'boolean', 'switch.light', false, true);
            await this._state(camId, 'control.whiteLedBrightness', 'White LED brightness (0-100)', 'number', 'level.dimmer', 100, true, { min: 0, max: 100, unit: '%' });
            await this._state(camId, 'control.whiteLedMode', 'White LED mode (Manual=on / AutoNight=auto)', 'string', 'text', 'Manual', true, { states: { AutoNight: 'Auto (night)', Manual: 'Manual (on)' } });
            await this._state(camId, 'status.whiteLed', 'White LED state', 'boolean', 'sensor', false, false);
            await this._state(camId, 'status.whiteLedTrigger', 'Gate trigger (≤3s WhiteLed flash detected)', 'boolean', 'sensor', false, false);
        }
        if (this._hasCapability(camId, 'siren')) {
            await this._state(camId, 'control.siren', 'Trigger siren (timed pulse)', 'boolean', 'button', false, true);
            await this._state(camId, 'control.sirenManual', 'Siren hold on/off (software-pulsed, all models)', 'boolean', 'switch', false, true);
            await this._state(camId, 'control.sirenOnDetect', 'Armed siren — sound on AI/motion detection', 'boolean', 'switch', false, true);
            await this._state(camId, 'control.audioAlarmDuration', 'Audio alarm duration (s)', 'number', 'level', 5, true, { min: 1, max: 30, unit: 's' });
            await this._state(camId, 'control.audioAlarmSound', 'Audio alarm sound id', 'number', 'value', 1, true, { min: 0, max: 10 });
        }

        // Status LED (PowerLed) — red front LED on most Reolink models.
        await this._state(camId, 'control.statusLed', 'Front status LED on/off', 'boolean', 'switch.light', true, true);
        // Recording on/off
        await this._state(camId, 'control.recording', 'SD recording enabled', 'boolean', 'switch', true, true);
        // Notifications
        await this._state(camId, 'control.notificationsEnabled', 'Master push notifications', 'boolean', 'switch', true, true);
        await this._state(camId, 'control.notifyMotion', 'Push on motion (MD)', 'boolean', 'switch', false, true);
        await this._state(camId, 'control.notifyPerson', 'Push on AI person', 'boolean', 'switch', false, true);
        await this._state(camId, 'control.notifyVehicle', 'Push on AI vehicle', 'boolean', 'switch', false, true);
        await this._state(camId, 'control.notifyAnimal', 'Push on AI animal', 'boolean', 'switch', false, true);
        if (this._hasCapability(camId, 'visitor') || camConfig.isDoorbell) {
            await this._state(camId, 'control.notifyVisitor', 'Push on doorbell visitor', 'boolean', 'switch', true, true);
        }
        // OSD
        await this._state(camId, 'control.osdText', 'OSD overlay text', 'string', 'text', '', true);
        await this._state(camId, 'control.osdShowDateTime', 'OSD show date/time', 'boolean', 'switch', true, true);
        // Motion sensitivity
        await this._state(camId, 'control.motionSensitivity', 'Motion detection sensitivity (0-100)', 'number', 'level', 50, true, { min: 0, max: 100 });

        if (this._hasCapability(camId, 'ptz')) {
            await this._channel(camId, 'ptz', 'PTZ Control');
            await this._state(camId, 'ptz.command', 'PTZ command', 'string', 'text', '', true, {
                states: {
                    Left: 'Left', Right: 'Right', Up: 'Up', Down: 'Down',
                    LeftUp: 'LeftUp', LeftDown: 'LeftDown', RightUp: 'RightUp', RightDown: 'RightDown',
                    ZoomInc: 'Zoom In', ZoomDec: 'Zoom Out',
                    FocusInc: 'Focus +', FocusDec: 'Focus -',
                    Stop: 'Stop', Auto: 'Auto Patrol',
                },
            });
            await this._state(camId, 'ptz.speed', 'PTZ speed (1-64)', 'number', 'level', 32, true, { min: 1, max: 64 });
            await this._state(camId, 'ptz.goToPreset', 'Go to preset index', 'number', 'value', 0, true);
            await this._state(camId, 'ptz.patrol', 'Start/stop patrol', 'boolean', 'switch', false, true);
            await this._state(camId, 'ptz.stop', 'Stop PTZ movement', 'boolean', 'button', false, true);
        }

        await this._channel(camId, 'image', 'Image Settings');
        await this._state(camId, 'image.brightness', 'Brightness (0-255)', 'number', 'level.brightness', 128, true, { min: 0, max: 255 });
        await this._state(camId, 'image.contrast', 'Contrast (0-255)', 'number', 'level', 128, true, { min: 0, max: 255 });
        await this._state(camId, 'image.saturation', 'Saturation (0-255)', 'number', 'level', 128, true, { min: 0, max: 255 });
        await this._state(camId, 'image.sharpness', 'Sharpness (0-255)', 'number', 'level', 128, true, { min: 0, max: 255 });

        await this._channel(camId, 'snapshot', 'Snapshot Data');
        await this._state(camId, 'snapshot.image', 'Last snapshot (base64 data URL)', 'string', 'text', '', false);
        await this._state(camId, 'snapshot.timestamp', 'Last snapshot time', 'number', 'date', 0, false);
        await this._state(camId, 'snapshot.file', 'Last snapshot file path', 'string', 'text', '', false);

        await this._channel(camId, 'storage', 'Storage Info');
        await this._state(camId, 'storage.hddCapacity', 'HDD/SD total capacity (MB)', 'number', 'value', 0, false);
        await this._state(camId, 'storage.hddUsed', 'HDD/SD used space (MB)', 'number', 'value', 0, false);

        // Loxone VI mapping — read-only display of what the adapter will send.
        if (this.config.loxoneEnabled && this.loxoneBridge) {
            await this._channel(camId, 'loxone', 'Loxone Integration');
            const camName = camConfig.name || camId;
            await this._state(camId, 'loxone.viMotion', 'Loxone VI for motion', 'string', 'text', this.loxoneBridge.inputName(camName, 'Motion'), false);
            await this._state(camId, 'loxone.viPerson', 'Loxone VI for person', 'string', 'text', this.loxoneBridge.inputName(camName, 'AI_person'), false);
            await this._state(camId, 'loxone.viVehicle', 'Loxone VI for vehicle', 'string', 'text', this.loxoneBridge.inputName(camName, 'AI_vehicle'), false);
            await this._state(camId, 'loxone.viOnline', 'Loxone VI for status', 'string', 'text', this.loxoneBridge.inputName(camName, 'Online'), false);
            await this._state(camId, 'loxone.viVisitor', 'Loxone VI for visitor/doorbell', 'string', 'text', this.loxoneBridge.inputName(camName, 'Visitor'), false);
            await this._state(camId, 'loxone.viIntercom', 'Loxone Intercom VI (RTSP URL on ring)', 'string', 'text', this.loxoneBridge.inputName(camName, 'intercom'), false);
            await this._state(camId, 'loxone.viGateTrigger', 'Loxone VI for gate trigger', 'string', 'text', this.loxoneBridge.inputName(camName, 'gate_trigger'), false);
            await this.setStateAsync(`${camId}.loxone.viMotion`, this.loxoneBridge.inputName(camName, 'Motion'), true);
            await this.setStateAsync(`${camId}.loxone.viPerson`, this.loxoneBridge.inputName(camName, 'AI_person'), true);
            await this.setStateAsync(`${camId}.loxone.viVehicle`, this.loxoneBridge.inputName(camName, 'AI_vehicle'), true);
            await this.setStateAsync(`${camId}.loxone.viOnline`, this.loxoneBridge.inputName(camName, 'Online'), true);
            await this.setStateAsync(`${camId}.loxone.viVisitor`, this.loxoneBridge.inputName(camName, 'Visitor'), true);
            await this.setStateAsync(`${camId}.loxone.viIntercom`, this.loxoneBridge.inputName(camName, 'intercom'), true);
            await this.setStateAsync(`${camId}.loxone.viGateTrigger`, this.loxoneBridge.inputName(camName, 'gate_trigger'), true);
        }

        this.log.debug(`Object tree ready for "${camId}"`);
    }

    async _updateStreamUrls(camId, camConfig, api) {
        const ch = camConfig.channel || 0;
        await this.setStateAsync(`${camId}.streams.rtspMainPublic`, api.rtspUrlPublic(ch, 'main'), true);
        await this.setStateAsync(`${camId}.streams.rtspSubPublic`, api.rtspUrlPublic(ch, 'sub'), true);
        // Where snapshots land — no credentials in this string.
        await this.setStateAsync(`${camId}.streams.snapshotProxy`, path.join(utils.getAbsoluteInstanceDataDir(this), 'snapshots', `${camId}.jpg`), true);
    }

    /**
     * Read current control settings from the camera (PowerLed, Recording, Push, WhiteLed,
     * OSD, MD sensitivity, AudioAlarm) and mirror them into ioBroker state with ack=true.
     * Lets the UI / Loxone see the actual camera configuration after a restart.
     */
    async _syncInitialControlState(camId, api, camConfig) {
        const ch = camConfig.channel || 0;
        // PowerLed
        try {
            const r = await api.getPowerLed(ch);
            const on = !!(r && r.value && r.value.PowerLed && r.value.PowerLed.state === 'On')
                || !!(r && r.PowerLed && r.PowerLed.state === 'On');
            await this.setStateAsync(`${camId}.control.statusLed`, on, true);
        } catch (_) { /* skip */ }
        // Recording
        try {
            const r = await api.getRec(ch);
            const en = !!(r && r.Rec && r.Rec.schedule && r.Rec.schedule.enable);
            await this.setStateAsync(`${camId}.control.recording`, en, true);
        } catch (_) { /* skip */ }
        // Push (master + per type)
        try {
            const p = await api.getPushTypes(ch);
            await this.setStateAsync(`${camId}.control.notificationsEnabled`, !!p.enabled, true);
            await this.setStateAsync(`${camId}.control.notifyMotion`, !!p.MD, true);
            await this.setStateAsync(`${camId}.control.notifyPerson`, !!p.AI_PEOPLE, true);
            await this.setStateAsync(`${camId}.control.notifyVehicle`, !!p.AI_VEHICLE, true);
            await this.setStateAsync(`${camId}.control.notifyAnimal`, !!p.AI_DOG_CAT, true);
            if (this._hasCapability(camId, 'visitor') || camConfig.isDoorbell) {
                await this.setStateAsync(`${camId}.control.notifyVisitor`, !!p.VISITOR, true);
            }
        } catch (_) { /* skip */ }
        // WhiteLed brightness + mode
        if (this._hasCapability(camId, 'whiteLed')) {
            try {
                const r = await api.getWhiteLed(ch);
                const wl = (r && r.WhiteLed) || r || {};
                if (wl.bright !== undefined) await this.setStateAsync(`${camId}.control.whiteLedBrightness`, Number(wl.bright), true);
                const modeNames = { 0: 'AutoNight', 1: 'Manual', 3: 'Manual' };
                if (wl.mode !== undefined) await this.setStateAsync(`${camId}.control.whiteLedMode`, modeNames[wl.mode] || 'Manual', true);
            } catch (_) { /* skip */ }
        }
        // OSD text + datetime
        try {
            const r = await api.getOsd(ch);
            const osd = (r && r.Osd) || {};
            if (osd.osdChannel) await this.setStateAsync(`${camId}.control.osdText`, String(osd.osdChannel.name || ''), true);
            if (osd.osdTime) await this.setStateAsync(`${camId}.control.osdShowDateTime`, !!osd.osdTime.enable, true);
        } catch (_) { /* skip */ }
        // MD sensitivity
        try {
            const sens = await api.getMdSensitivity(ch);
            await this.setStateAsync(`${camId}.control.motionSensitivity`, Number(sens) || 0, true);
        } catch (_) { /* skip */ }
        // Audio alarm
        if (this._hasCapability(camId, 'siren')) {
            try {
                const r = await api.getAudioAlarmState(ch);
                const cfg = (r && (r.Audio || r.AudioAlarmV20)) || {};
                await this.setStateAsync(`${camId}.control.sirenOnDetect`, !!cfg.enable, true);
                if (cfg.duration !== undefined) await this.setStateAsync(`${camId}.control.audioAlarmDuration`, Number(cfg.duration), true);
                if (cfg.sound_index !== undefined) await this.setStateAsync(`${camId}.control.audioAlarmSound`, Number(cfg.sound_index), true);
            } catch (_) { /* skip */ }
        }
    }

    // ─── POLLING ──────────────────────────────────────────────────────────

    async _pollMain(camId) {
        const api = this.cameras.get(camId);
        const camConfig = this.camConfigs.get(camId);
        if (!api || !camConfig) return;
        const ch = camConfig.channel || 0;
        // pushToLoxone gates whether events get forwarded to the Loxone bridge.
        // Defaults to true (back-compat); set to false on duplicate rows (e.g. NVR
        // that shadows standalone cameras already publishing the same VIs).
        const bridgeOK = camConfig.pushToLoxone !== false && this.loxoneBridge;

        let connected = false;
        let aiProbeOk = false;
        try {
            // AI-only motion. GetMdState (classic motion) is intentionally not used —
            // it is unreliable on CX-series and effectively replaced by AI detection.
            // Motion VI fires whenever AI sees a person/vehicle/animal/face.
            let aiAny = false;
            try {
                const aiState = await api.getAiState(ch);
                aiProbeOk = true;
                connected = true;   // transport succeeded → camera is reachable
                const ai = (aiState && aiState.AiState) || aiState || {};
                this.log.debug(`[poll] AI ${camId} raw: ${JSON.stringify(ai)}`);
                const typeMap = {
                    person: ai.people,
                    vehicle: ai.vehicle,
                    animal: ai.dog_cat,
                    face: ai.face,
                };
                for (const [type, data] of Object.entries(typeMap)) {
                    if (!data || data.support === 0) continue;
                    const detected = !!(data.alarm_state === 1 || data.alarm_state === true);
                    if (detected) aiAny = true;
                    await this._emitChange(camId, `ai_${type}`, detected, async () => {
                        await this.setStateAsync(`${camId}.status.${type}Detected`, detected, true);
                        if (bridgeOK) await this.loxoneBridge.sendAi(camConfig.name || camId, type, detected);
                    });
                }
            } catch (e) {
                this.log.debug(`AI poll failed for ${camId}: ${sanitize(e.message)}`);
            }

            // If the AI probe threw, the camera might simply lack AI — confirm
            // reachability with a light GetDevInfo so a genuinely offline camera flips
            // Online=0 instead of staying stuck on 1 (every command above is swallowed).
            if (!aiProbeOk) {
                connected = await api.isAlive();
            }

            // Motion = any AI detection
            await this._emitChange(camId, 'motion', aiAny, async () => {
                await this.setStateAsync(`${camId}.status.motionDetected`, aiAny, true);
                if (aiAny) await this.setStateAsync(`${camId}.status.lastMotionTime`, Date.now(), true);
                if (bridgeOK) await this.loxoneBridge.sendMotion(camConfig.name || camId, aiAny);
            });

            // WhiteLed (only here if there's no fast-poll task already covering it)
            if (this._hasCapability(camId, 'whiteLed') && !this.scheduler.has(`wl:${camId}`)) {
                await this._handleWhiteLedSample(camId, ch).catch((e) => this.log.debug(`WhiteLed poll failed for ${camId}: ${sanitize(e.message)}`));
            }



            // Doorbell (physical button press). Skipped entirely if the user
            // marked the camera as doorbell explicitly (webhook handles it).
            if (this._hasCapability(camId, 'doorbell') && !camConfig.isDoorbell) {
                try {
                    const dbRes = await api.getDoorbell(ch);
                    const ringing = !!(dbRes && (dbRes.ring_state === 1 || (dbRes.Doorbell && dbRes.Doorbell.ring_state === 1)));
                    await this._emitChange(camId, 'doorbell', ringing, async () => {
                        await this.setStateAsync(`${camId}.status.doorbellRing`, ringing, true);
                        await this.setStateAsync(`${camId}.status.visitorDetected`, ringing, true);
                        if (bridgeOK) {
                            await this.loxoneBridge.sendCustom(camConfig.name || camId, 'Visitor', ringing ? 1 : 0);
                            await this.loxoneBridge.sendCustom(camConfig.name || camId, 'doorbellRing', ringing ? 1 : 0);
                        }
                    });
                } catch (e) {
                    this.log.debug(`Doorbell poll failed for ${camId}: ${sanitize(e.message)}`);
                }
            }
        } catch (e) {
            connected = false;
            this.log.warn(`Poll failed for "${camId}": ${sanitize(e.message)}`);
        }

        await this.setStateAsync(`${camId}.info.connection`, connected, true);
        // Online to Loxone: emit on change OR refresh every HEARTBEAT_INTERVAL_MS even when unchanged
        // (so a Loxone Miniserver restart can't leave the VI on stale 0 indefinitely).
        const lastBeatKey = `${camId}.onlineHeartbeat`;
        const lastBeatAt = this.lastStates.get(lastBeatKey) || 0;
        const stateChanged = this.lastStates.get(`${camId}.online`) !== connected;
        const due = Date.now() - lastBeatAt >= HEARTBEAT_INTERVAL_MS;
        if (stateChanged || due) {
            this.lastStates.set(`${camId}.online`, connected);
            this.lastStates.set(lastBeatKey, Date.now());
            if (bridgeOK) await this.loxoneBridge.sendStatus(camConfig.name || camId, connected);
        }
    }

    async _pollWhiteLed(camId) {
        const camConfig = this.camConfigs.get(camId);
        if (!camConfig) return;
        const ch = camConfig.channel || 0;
        await this._handleWhiteLedSample(camId, ch);
    }

    async _handleWhiteLedSample(camId, ch) {
        const api = this.cameras.get(camId);
        if (!api) return;
        const camConfig = this.camConfigs.get(camId);
        const wlRes = await api.getWhiteLed(ch);
        const wl = (wlRes && wlRes.WhiteLed) || wlRes || {};
        const wlState = !!(wl.state === 1 || wl.state === true);
        const prev = this.lastStates.get(`${camId}.whiteLed`);

        await this.setStateAsync(`${camId}.status.whiteLed`, wlState, true);

        // Only sync the control state if the user hasn't written it in the last few seconds.
        const lastUserWrite = this.userWriteAt.get(`${camId}.control.whiteLed`) || 0;
        if (Date.now() - lastUserWrite > USER_WRITE_DEBOUNCE_MS) {
            await this.setStateAsync(`${camId}.control.whiteLed`, wlState, true);
        }

        if (wlState !== prev) {
            this.lastStates.set(`${camId}.whiteLed`, wlState);
            if (wlState && camConfig.whiteLedGateTrigger) {
                this.lastStates.set(`${camId}.whiteLedOnTime`, Date.now());
            } else if (!wlState && camConfig.whiteLedGateTrigger) {
                const onTime = this.lastStates.get(`${camId}.whiteLedOnTime`);
                if (onTime && (Date.now() - onTime) <= GATE_TRIGGER_WINDOW_MS) {
                    this.log.info(`Camera "${camId}": gate trigger pattern (${Date.now() - onTime}ms)`);
                    await this.setStateAsync(`${camId}.status.whiteLedTrigger`, true, true);
                    this.timers.setTimeout(() => this.setStateAsync(`${camId}.status.whiteLedTrigger`, false, true).catch(() => undefined), GATE_TRIGGER_PULSE_MS);
                    if (this.loxoneBridge) await this.loxoneBridge.sendCustom(camConfig.name || camId, 'gate_trigger', 1);
                }
                this.lastStates.delete(`${camId}.whiteLedOnTime`);
            }
            if (this.loxoneBridge) await this.loxoneBridge.sendCustom(camConfig.name || camId, 'whiteLed', wlState ? 1 : 0);
        }
    }

    /** Update lastStates and fire `fn` only when value changes. */
    async _emitChange(camId, key, value, fn) {
        const mapKey = `${camId}.${key}`;
        if (this.lastStates.get(mapKey) === value) return;
        this.lastStates.set(mapKey, value);
        try { await fn(); } catch (e) { this.log.debug(`emitChange ${mapKey} failed: ${sanitize(e.message)}`); }
    }

    // ─── NVR INIT ─────────────────────────────────────────────────────────

    /**
     * Initialise a Reolink NVR (e.g. RLN8-410). Pulls device info + channel list and
     * creates one sub-device per active channel under reolox.0.<nvrId>.chN.*.
     * Polling motion/AI per channel and webhook dispatch land in Stage 2 of NVR support.
     */
    async _initNvr(camConfig, nvrId) {
        this.log.info(`Initialising NVR "${nvrId}" at ${sanitize(camConfig.host)}…`);
        const api = new ReolinkAPI({
            host: camConfig.host,
            port: camConfig.port || (camConfig.useHttps ? 443 : 80),
            username: camConfig.username,
            password: camConfig.password,
            channel: 0,
            useHttps: !!camConfig.useHttps,
            log: this.log,
        });
        try {
            await api.login();
            this.cameras.set(nvrId, api);
            this.camConfigs.set(nvrId, camConfig);

            const devInfo = await api.getDevInfo();
            const info = (devInfo && devInfo.DevInfo) || {};
            this.log.info(`NVR "${nvrId}" connected: ${sanitize(info.model || '?')} FW=${sanitize(info.firmVer || '?')} channels=${info.channelNum || '?'}`);

            // Device root
            await this.setObjectNotExistsAsync(nvrId, {
                type: 'device',
                common: { name: camConfig.name || nvrId },
                native: { host: camConfig.host, isNvr: true },
            });
            await this._channel(nvrId, 'info', 'NVR Information');
            await this._state(nvrId, 'info.connection', 'Connection status', 'boolean', 'indicator.connected', false, false);
            await this._state(nvrId, 'info.model', 'NVR model', 'string', 'info.name', '', false);
            await this._state(nvrId, 'info.firmware', 'Firmware version', 'string', 'info.firmware', '', false);
            await this._state(nvrId, 'info.channelCount', 'Total channels', 'number', 'value', 0, false);
            await this._state(nvrId, 'info.activeChannels', 'Online channels', 'number', 'value', 0, false);
            await this.setStateAsync(`${nvrId}.info.connection`, true, true);
            await this.setStateAsync(`${nvrId}.info.model`, info.model || '', true);
            await this.setStateAsync(`${nvrId}.info.firmware`, info.firmVer || '', true);
            await this.setStateAsync(`${nvrId}.info.channelCount`, info.channelNum || 0, true);

            // Channel discovery
            let chStatus;
            try { chStatus = await api.getChannelStatus(); }
            catch (e) { this.log.warn(`NVR "${nvrId}" channel discovery failed: ${sanitize(e.message)}`); return; }
            const list = (chStatus && chStatus.status) || [];
            const active = list.filter((c) => c && c.online === 1);
            await this.setStateAsync(`${nvrId}.info.activeChannels`, active.length, true);

            const names = active.map((c) => `ch${c.channel}=${sanitize(c.name)}`).join(', ');
            this.log.info(`NVR "${nvrId}": ${active.length}/${list.length} channels online — ${names}`);

            for (const ch of list) {
                const chId = `${nvrId}.ch${ch.channel}`;
                await this.setObjectNotExistsAsync(chId, {
                    type: 'channel',
                    common: { name: ch.name || `Channel ${ch.channel}` },
                    native: { channel: ch.channel },
                });
                await this._state(nvrId, `ch${ch.channel}.info.name`, 'Camera name', 'string', 'info.name', '', false);
                await this._state(nvrId, `ch${ch.channel}.info.uid`, 'Reolink UID', 'string', 'text', '', false);
                await this._state(nvrId, `ch${ch.channel}.info.online`, 'Camera online (per NVR)', 'boolean', 'indicator.connected', false, false);
                await this._state(nvrId, `ch${ch.channel}.info.sleep`, 'Camera sleeping (battery models)', 'boolean', 'sensor', false, false);
                await this.setStateAsync(`${chId}.info.name`, ch.name || '', true);
                await this.setStateAsync(`${chId}.info.uid`, ch.uid || '', true);
                await this.setStateAsync(`${chId}.info.online`, ch.online === 1, true);
                await this.setStateAsync(`${chId}.info.sleep`, ch.sleep === 1, true);
                // Status states for motion + AI (filled by poller)
                await this._state(nvrId, `ch${ch.channel}.status.motionDetected`, 'Motion (NVR-side)', 'boolean', 'sensor.motion', false, false);
                await this._state(nvrId, `ch${ch.channel}.status.personDetected`, 'AI person detected', 'boolean', 'sensor.motion', false, false);
                await this._state(nvrId, `ch${ch.channel}.status.vehicleDetected`, 'AI vehicle detected', 'boolean', 'sensor.motion', false, false);
                await this._state(nvrId, `ch${ch.channel}.status.animalDetected`, 'AI animal detected', 'boolean', 'sensor.motion', false, false);
                await this._state(nvrId, `ch${ch.channel}.status.faceDetected`, 'AI face detected', 'boolean', 'sensor.motion', false, false);
                // Phase 2 — writable per-channel control
                await this._state(nvrId, `ch${ch.channel}.control.recording`, 'Recording enabled', 'boolean', 'switch', true, true);
                await this._state(nvrId, `ch${ch.channel}.control.motionDetectionEnabled`, 'Motion detection enabled', 'boolean', 'switch', true, true);
                await this._state(nvrId, `ch${ch.channel}.control.aiDetectionEnabled`, 'AI detection enabled (master)', 'boolean', 'switch', true, true);
                await this._state(nvrId, `ch${ch.channel}.control.notificationsEnabled`, 'Push notifications enabled', 'boolean', 'switch', true, true);
            }

            // Remember active channel list + name mapping for the poller
            const activeChannels = active.map((c) => ({ channel: c.channel, name: c.name }));
            this.lastStates.set(`${nvrId}.activeChannels`, activeChannels);

            // Stage 2 — start polling motion + AI per channel
            const intervalMs = Math.max(1, camConfig.pollInterval || this.config.defaultPollInterval || 1) * 1000;
            this.scheduler.add({
                key: `nvr:${nvrId}`,
                intervalMs,
                run: () => this._pollNvr(nvrId),
            });

            // Phase 2 — sync initial control state from NVR into ioBroker
            await this._syncInitialNvrControlState(nvrId).catch((e) =>
                this.log.debug(`Initial NVR control sync failed for ${nvrId}: ${sanitize(e.message)}`),
            );

            this.log.info(`NVR "${nvrId}" ready. Polling ${activeChannels.length} channel(s) every ${intervalMs / 1000}s.`);
        } catch (err) {
            this.log.error(`NVR "${nvrId}" init failed: ${sanitize(err.message)}`);
            await this.setStateAsync(`${nvrId}.info.connection`, false, true).catch(() => undefined);
        }
    }

    /**
     * Stage 2 NVR poller. One batch HTTP call per cycle: GetMdState + GetAiState
     * for every online channel. Emits per-channel state changes and forwards
     * events to Loxone as `<viPrefix>_<nvrName>_<channelName>_<event>`.
     */
    /**
     * Phase 2: read MD/AI/recording/push per channel and mirror into NVR ioBroker states.
     * Runs once after _initNvr → poller setup; failures per channel are swallowed.
     */
    async _syncInitialNvrControlState(nvrId) {
        const api = this.cameras.get(nvrId);
        const channels = this.lastStates.get(`${nvrId}.activeChannels`) || [];
        if (!api || channels.length === 0) return;
        for (const ch of channels) {
            const chId = `${nvrId}.ch${ch.channel}`;
            try {
                const r = await api.getRec(ch.channel);
                const en = !!(r && r.Rec && r.Rec.schedule && r.Rec.schedule.enable);
                await this.setStateAsync(`${chId}.control.recording`, en, true);
            } catch (_) { /* skip */ }
            try {
                const en = await api.getMdAlarmEnabled(ch.channel);
                await this.setStateAsync(`${chId}.control.motionDetectionEnabled`, en, true);
            } catch (_) { /* skip */ }
            try {
                const en = await api.getAiCfgEnabled(ch.channel);
                await this.setStateAsync(`${chId}.control.aiDetectionEnabled`, en, true);
            } catch (_) { /* skip */ }
            try {
                const p = await api.getPushTypes(ch.channel);
                await this.setStateAsync(`${chId}.control.notificationsEnabled`, !!p.enabled, true);
            } catch (_) { /* skip */ }
        }
    }

    /**
     * Phase 2: dispatch a writable change targeting an NVR channel path
     * (reolox.0.<nvrId>.ch<N>.control.<state>). Returns true if handled.
     */
    async _handleNvrChannelStateChange(id, state, api, nvrId, channelNum, sub) {
        try {
            switch (sub) {
                case 'recording':
                    await api.setRecEnabled(channelNum, !!state.val);
                    await this.setStateAsync(id, !!state.val, true);
                    this.log.info(`NVR "${nvrId}" ch${channelNum}: recording = ${state.val ? 'ON' : 'OFF'}`);
                    return true;
                case 'motionDetectionEnabled':
                    await api.setMdAlarmEnabled(channelNum, !!state.val);
                    await this.setStateAsync(id, !!state.val, true);
                    this.log.info(`NVR "${nvrId}" ch${channelNum}: MD = ${state.val ? 'ON' : 'OFF'}`);
                    return true;
                case 'aiDetectionEnabled':
                    await api.setAiCfgEnabled(channelNum, !!state.val);
                    await this.setStateAsync(id, !!state.val, true);
                    this.log.info(`NVR "${nvrId}" ch${channelNum}: AI = ${state.val ? 'ON' : 'OFF'}`);
                    return true;
                case 'notificationsEnabled':
                    await api.setPushEnabled(channelNum, !!state.val);
                    await this.setStateAsync(id, !!state.val, true);
                    this.log.info(`NVR "${nvrId}" ch${channelNum}: push = ${state.val ? 'ON' : 'OFF'}`);
                    return true;
                default:
                    return false;
            }
        } catch (e) {
            this.log.warn(`NVR "${nvrId}" ch${channelNum} ${sub} failed: ${sanitize(e.message)}`);
            return true;
        }
    }

    async _pollNvr(nvrId) {
        const api = this.cameras.get(nvrId);
        const camConfig = this.camConfigs.get(nvrId);
        const channels = this.lastStates.get(`${nvrId}.activeChannels`) || [];
        if (!api || !camConfig || channels.length === 0) return;
        const bridgeOK = camConfig.pushToLoxone !== false && this.loxoneBridge;

        // Build the batch — for every channel: GetMdState + GetAiState
        const commands = [];
        for (const ch of channels) {
            commands.push({ cmd: 'GetMdState', action: 0, param: { channel: ch.channel } });
            commands.push({ cmd: 'GetAiState', action: 0, param: { channel: ch.channel } });
        }

        let results;
        try {
            results = await api._batchCmd(commands);
        } catch (e) {
            this.log.debug(`NVR "${nvrId}" batch poll failed: ${sanitize(e.message)}`);
            await this.setStateAsync(`${nvrId}.info.connection`, false, true);
            await this._emitChange(nvrId, 'online', false, async () => {
                if (bridgeOK) await this.loxoneBridge.sendStatus(`${camConfig.name || nvrId}`, false);
            });
            return;
        }
        // A token invalidated server-side (e.g. NVR reboot) surfaces as per-entry error
        // codes, not an exception — _batchCmd re-logins once, but if the whole batch still
        // came back empty treat the NVR as unreachable instead of silently reporting every
        // channel quiet with Online=1.
        const anyOk = Array.isArray(results) && results.some((r) => r && (r.code === 0 || r.value));
        if (!anyOk) {
            this.log.debug(`NVR "${nvrId}" batch returned no valid results — marking offline`);
            await this.setStateAsync(`${nvrId}.info.connection`, false, true);
            await this._emitChange(nvrId, 'online', false, async () => {
                if (bridgeOK) await this.loxoneBridge.sendStatus(camConfig.name || nvrId, false);
            });
            return;
        }
        await this.setStateAsync(`${nvrId}.info.connection`, true, true);
        // Heartbeat Online=1 to Loxone: emit on change OR refresh every HEARTBEAT_INTERVAL_MS
        const lastBeatKey = `${nvrId}.onlineHeartbeat`;
        const lastBeatAt = this.lastStates.get(lastBeatKey) || 0;
        const wasOnline = this.lastStates.get(`${nvrId}.online`);
        const due = Date.now() - lastBeatAt >= HEARTBEAT_INTERVAL_MS;
        if (wasOnline !== true || due) {
            this.lastStates.set(`${nvrId}.online`, true);
            this.lastStates.set(lastBeatKey, Date.now());
            if (bridgeOK) await this.loxoneBridge.sendStatus(camConfig.name || nvrId, true);
        }

        // Each channel produces 2 sequential entries: [MdState, AiState]
        for (let i = 0; i < channels.length; i++) {
            const ch = channels[i];
            const chId = `${nvrId}.ch${ch.channel}`;
            const mdData = results[i * 2] && results[i * 2].value;
            const aiData = results[i * 2 + 1] && results[i * 2 + 1].value;

            const aiObj = (aiData && (aiData.AiState || aiData)) || {};
            const aiDetected = {
                person: !!(aiObj.people && aiObj.people.support === 1 && aiObj.people.alarm_state === 1),
                vehicle: !!(aiObj.vehicle && aiObj.vehicle.support === 1 && aiObj.vehicle.alarm_state === 1),
                animal: !!(aiObj.dog_cat && aiObj.dog_cat.support === 1 && aiObj.dog_cat.alarm_state === 1),
                face: !!(aiObj.face && aiObj.face.support === 1 && aiObj.face.alarm_state === 1),
            };

            // Motion (MdState OR any AI) — same logic as standalone cameras
            const md = !!(mdData && (mdData.state === 1 || (mdData.MdState && mdData.MdState.state === 1)));
            const anyAi = aiDetected.person || aiDetected.vehicle || aiDetected.animal || aiDetected.face;
            const motion = md || anyAi;

            // VI naming: <viPrefix>_<nvrName>_<channelName>_<event>
            const loxoneName = `${camConfig.name || nvrId}_${ch.name || `ch${ch.channel}`}`;

            await this._emitChange(`${chId}`, 'motion', motion, async () => {
                await this.setStateAsync(`${chId}.status.motionDetected`, motion, true);
                if (bridgeOK) await this.loxoneBridge.sendMotion(loxoneName, motion);
            });

            for (const [type, detected] of Object.entries(aiDetected)) {
                await this._emitChange(`${chId}`, `ai_${type}`, detected, async () => {
                    await this.setStateAsync(`${chId}.status.${type}Detected`, detected, true);
                    if (bridgeOK) await this.loxoneBridge.sendAi(loxoneName, type, detected);
                });
            }
        }
    }

    // ─── WEBHOOK ──────────────────────────────────────────────────────────

    async _startWebhookServer() {
        // The allowlist may mix `auto` (derive camera hosts) with explicit IPs, e.g.
        // "auto, 192.168.0.175" — both are honoured. Empty defaults to auto.
        const tokens = String(this.config.webhookIpAllowlist || 'auto')
            .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
        const allowAuto = tokens.length === 0 || tokens.some((t) => t.toLowerCase() === 'auto');
        const explicitIps = tokens.filter((t) => t.toLowerCase() !== 'auto');

        this.webhookServer = new WebhookServer({
            port: this.config.webhookPort,
            host: '0.0.0.0',
            sharedSecret: this.config.webhookSharedSecret || '',
            ipAllowlist: explicitIps,
            ipAllowlistAuto: allowAuto,
            pathPrefix: '/reolox',
            log: this.log,
            onEvent: (camId, sourceIp, events) => this._dispatchWebhook(camId, sourceIp, events),
            // Control endpoint (Loxone Virtual Output → camera). The Miniserver IP is
            // trusted on top of the camera allowlist; a shared secret is still honoured.
            controlEnabled: this.config.controlApiEnabled !== false,
            extraAllowed: this.config.loxoneHost ? [String(this.config.loxoneHost).trim()] : [],
            onControl: (statePath, value) => this._applyLoxoneControl(statePath, value),
        });
        try {
            await this.webhookServer.start();
        } catch (e) {
            this.log.error(`Webhook server failed to start on port ${this.config.webhookPort}: ${sanitize(e.message)}`);
            this.webhookServer = null;
        }
    }

    /**
     * Apply a control command received over the HTTP control endpoint
     * (Loxone Virtual Output → <prefix>/cmd/<state.path>/<value>). Writes the
     * matching writable control state with ack=false so the normal onStateChange
     * pipeline forwards it to the camera/NVR — no extra adapter (simple-api) needed.
     */
    async _applyLoxoneControl(statePath, rawValue) {
        if (!/\.control\./.test(statePath)) {
            this.log.warn(`Control: refused non-control path "${sanitize(statePath)}"`);
            return;
        }
        let obj = null;
        try { obj = await this.getObjectAsync(statePath); } catch (_) { obj = null; }
        if (!obj || !obj.common || obj.common.write !== true) {
            this.log.warn(`Control: unknown or read-only state "${sanitize(statePath)}"`);
            return;
        }
        const val = this._coerceValue(rawValue, obj.common.type);
        this.log.info(`Control (HTTP) → ${sanitize(statePath)} = ${sanitize(String(val))}`);
        // ack=false → onStateChange runs the existing per-control camera logic.
        await this.setStateAsync(statePath, val, false).catch((e) =>
            this.log.warn(`Control: setState ${sanitize(statePath)} failed: ${sanitize(e.message)}`),
        );
    }

    /** Coerce a raw string from the HTTP control endpoint to the target state's type. */
    _coerceValue(raw, type) {
        if (type === 'boolean') {
            const s = String(raw).trim().toLowerCase();
            return s === '1' || s === 'true' || s === 'on' || s === 'yes';
        }
        if (type === 'number') return Number(raw);
        return String(raw);
    }

    /**
     * Emulate a held siren using the only primitive every model honours: re-fire a
     * 1-repeat pulse (~2.5 s each) on a short interval. Robust across firmware (incl.
     * CX820, which has no native held mode) and fail-safe — if the adapter stops,
     * the last pulse rings out within ~2.5 s instead of latching on.
     */
    _startSirenHold(camId, ch) {
        if (this.sirenLoops.has(camId)) return;
        const fire = () => {
            const api = this.cameras.get(camId);
            if (api) api.triggerSiren(ch, 1).catch((e) => this.log.debug(`Siren hold tick failed for ${camId}: ${sanitize(e.message)}`));
        };
        fire();
        this.sirenLoops.set(camId, this.timers.setInterval(fire, SIREN_HOLD_REFIRE_MS));
    }

    _stopSirenHold(camId) {
        const h = this.sirenLoops.get(camId);
        if (h) this.timers.clearInterval(h);
        this.sirenLoops.delete(camId);
    }

    async _dispatchWebhook(camId, sourceIp, events) {
        // Resolve camera id: explicit path > source IP match.
        let resolvedId = this.camConfigs.has(camId) ? camId : null;
        if (!resolvedId) {
            for (const [id, cfg] of this.camConfigs) {
                if (cfg.host === sourceIp) { resolvedId = id; break; }
            }
        }
        if (!resolvedId) {
            this.log.warn(`Webhook: unknown camera (path="${sanitize(camId)}", ip=${sanitize(sourceIp)})`);
            return;
        }
        const camConfig = this.camConfigs.get(resolvedId);

        if (events.list.length === 0) {
            // Empty/unrecognised body — assume visitor (doorbell models often send no body).
            this.log.info(`Camera "${resolvedId}": empty/unknown webhook body → visitor pulse`);
            await this._applyWebhookEvent(resolvedId, camConfig, 'visitor', true);
            this.timers.setTimeout(
                () => this._applyWebhookEvent(resolvedId, camConfig, 'visitor', false).catch(() => undefined),
                VISITOR_PULSE_MS,
            );
            return;
        }

        for (const evt of events.list) {
            const isVisitor = ['visitor', 'doorbell', 'ring'].includes(evt.type);
            // Reolink Doorbell PoE v3.0.0.4662 only fires alarm_state=0 (release event), no press.
            // For cameras explicitly marked as doorbell, treat any visitor webhook as a button press pulse.
            const forcePulse = isVisitor && camConfig.isDoorbell;
            const active = forcePulse ? true : evt.active;
            await this._applyWebhookEvent(resolvedId, camConfig, evt.type, active);
            if ((isVisitor && active) || forcePulse) {
                this.timers.setTimeout(
                    () => this._applyWebhookEvent(resolvedId, camConfig, evt.type, false).catch(() => undefined),
                    VISITOR_PULSE_MS,
                );
            }
        }
    }

    async _applyWebhookEvent(camId, camConfig, type, active) {
        const safeType = sanitize(type);
        this.log.info(`Camera "${camId}" webhook event: ${safeType} = ${active}`);

        switch (safeType) {
            case 'visitor':
            case 'doorbell':
            case 'ring':
                await this.setStateAsync(`${camId}.status.visitorDetected`, active, true);
                await this.setStateAsync(`${camId}.status.doorbellRing`, active, true);
                if (this.loxoneBridge) {
                    await this.loxoneBridge.sendCustom(camConfig.name || camId, 'Visitor', active ? 1 : 0);
                    await this.loxoneBridge.sendCustom(camConfig.name || camId, 'doorbellRing', active ? 1 : 0);
                    if (this.config.loxoneIntercomEnabled) {
                        let streamUrl = '';
                        if (active) {
                            const api = this.cameras.get(camId);
                            streamUrl = api ? api.rtspUrlPublic(camConfig.channel || 0, 'main') : '';
                        }
                        await this.loxoneBridge.sendCustom(camConfig.name || camId, 'intercom', active ? (streamUrl || 1) : 0);
                    }
                }
                break;
            case 'md':
            case 'motion':
                await this.setStateAsync(`${camId}.status.motionDetected`, active, true);
                if (active) await this.setStateAsync(`${camId}.status.lastMotionTime`, Date.now(), true);
                if (this.loxoneBridge) await this.loxoneBridge.sendMotion(camConfig.name || camId, active);
                break;
            case 'people':
            case 'person':
                await this.setStateAsync(`${camId}.status.personDetected`, active, true);
                if (this.loxoneBridge) await this.loxoneBridge.sendAi(camConfig.name || camId, 'person', active);
                break;
            case 'vehicle':
                await this.setStateAsync(`${camId}.status.vehicleDetected`, active, true);
                if (this.loxoneBridge) await this.loxoneBridge.sendAi(camConfig.name || camId, 'vehicle', active);
                break;
            case 'dog_cat':
            case 'animal':
                await this.setStateAsync(`${camId}.status.animalDetected`, active, true);
                if (this.loxoneBridge) await this.loxoneBridge.sendAi(camConfig.name || camId, 'animal', active);
                break;
            default:
                this.log.debug(`Camera "${camId}" unhandled webhook event type: ${safeType}`);
        }
    }

    // ─── STATE CHANGES (writes from UI / scripts) ─────────────────────────

    async onStateChange(id, state) {
        if (!state || state.ack) return;
        const parts = id.split('.');
        if (parts.length < 5) return;
        const camId = parts[2];
        const channel = parts[3];
        const stateName = parts.slice(4).join('.');
        const api = this.cameras.get(camId);
        if (!api) {
            this.log.warn(`State change for unknown camera "${sanitize(camId)}"`);
            return;
        }
        const camConfig = this.camConfigs.get(camId) || {};
        const ch = camConfig.channel || 0;

        // Phase 2: NVR per-channel control path (channel segment = `chN`)
        const nvrChMatch = /^ch(\d+)$/.exec(channel);
        if (nvrChMatch && stateName.startsWith('control.')) {
            const handled = await this._handleNvrChannelStateChange(
                id, state, api, camId, Number(nvrChMatch[1]), stateName.replace(/^control\./, ''),
            );
            if (handled) return;
        }

        try {
            switch (`${channel}.${stateName}`) {
                case 'control.snapshot':
                    if (state.val) {
                        await this._captureSnapshot(camId, api, ch);
                        await this.setStateAsync(id, false, true);
                    }
                    break;
                case 'control.reboot':
                    if (state.val) {
                        this.log.info(`Rebooting camera "${camId}"`);
                        await api.reboot();
                        await this.setStateAsync(id, false, true);
                    }
                    break;
                case 'control.irLights': {
                    const mode = String(state.val);
                    const irState = mode === 'On' ? 1 : mode === 'Off' ? 0 : 2;
                    await api.setIrLights({ channel: ch, state: irState });
                    await this.setStateAsync(id, mode, true);
                    break;
                }
                case 'control.whiteLed': {
                    this.userWriteAt.set(`${camId}.control.whiteLed`, Date.now());
                    try {
                        // Minimal payload — CX810/CX820 reject the full SetWhiteLed
                        // (LightingSchedule / mode=1) with rspCode=-13. 'state' is the on/off
                        // field per API; mode and brightness are deliberately left untouched.
                        await api.setWhiteLedConfig(ch, { state: state.val ? 1 : 0 });
                        await this.setStateAsync(id, !!state.val, true);
                    } catch (e) {
                        this.log.warn(`Camera "${camId}" SetWhiteLed failed: ${sanitize(e.message)}`);
                    }
                    break;
                }
                case 'control.siren':
                    if (state.val) {
                        try {
                            const ds = await this.getStateAsync(`${camId}.control.audioAlarmDuration`);
                            const dur = (ds && Number(ds.val)) || 5;
                            await api.triggerSiren(ch, dur);
                            this.log.info(`Siren pulse ${dur}s on "${camId}"`);
                        } catch (e) { this.log.debug(`Siren failed: ${sanitize(e.message)}`); }
                        await this.setStateAsync(id, false, true);
                    }
                    break;
                case 'control.sirenManual':
                    // Software-held siren: re-fire a 1-repeat pulse while ON (works on every
                    // model, incl. CX820 which has no native held mode). OFF stops the loop.
                    if (state.val) this._startSirenHold(camId, ch);
                    else this._stopSirenHold(camId);
                    await this.setStateAsync(id, !!state.val, true);
                    this.log.info(`Camera "${camId}": siren hold ${state.val ? 'ON' : 'OFF'}`);
                    break;
                case 'control.sirenOnDetect':
                    try { await api.setAudioAlarmEnabled(ch, !!state.val); await this.setStateAsync(id, !!state.val, true); this.log.info(`Camera "${camId}": armed siren (on detect) ${state.val ? 'ON' : 'OFF'}`); }
                    catch (e) { this.log.warn(`Camera "${camId}" sirenOnDetect failed: ${sanitize(e.message)}`); }
                    break;
                case 'control.statusLed':
                    try { await api.setPowerLed(ch, !!state.val); await this.setStateAsync(id, !!state.val, true); }
                    catch (e) { this.log.warn(`Camera "${camId}" setPowerLed failed: ${sanitize(e.message)}`); }
                    break;
                case 'control.recording':
                    try { await api.setRecEnabled(ch, !!state.val); await this.setStateAsync(id, !!state.val, true); this.log.info(`Camera "${camId}": recording = ${state.val ? 'ON' : 'OFF'}`); }
                    catch (e) { this.log.warn(`Camera "${camId}" setRecEnabled failed: ${sanitize(e.message)}`); }
                    break;
                case 'control.notificationsEnabled':
                    try { await api.setPushEnabled(ch, !!state.val); await this.setStateAsync(id, !!state.val, true); this.log.info(`Camera "${camId}": notifications = ${state.val ? 'ON' : 'OFF'}`); }
                    catch (e) { this.log.warn(`Camera "${camId}" setPushEnabled failed: ${sanitize(e.message)}`); }
                    break;
                case 'control.notifyMotion':
                case 'control.notifyPerson':
                case 'control.notifyVehicle':
                case 'control.notifyAnimal':
                case 'control.notifyVisitor': {
                    const typeMap = {
                        'control.notifyMotion': 'MD',
                        'control.notifyPerson': 'AI_PEOPLE',
                        'control.notifyVehicle': 'AI_VEHICLE',
                        'control.notifyAnimal': 'AI_DOG_CAT',
                        'control.notifyVisitor': 'VISITOR',
                    };
                    const reoType = typeMap[`${channel}.${stateName}`];
                    try { await api.setPushScheduleType(ch, reoType, !!state.val); await this.setStateAsync(id, !!state.val, true); }
                    catch (e) { this.log.warn(`Camera "${camId}" setPushScheduleType(${reoType}) failed: ${sanitize(e.message)}`); }
                    break;
                }
                case 'control.whiteLedBrightness':
                    this.userWriteAt.set(`${camId}.control.whiteLed`, Date.now());
                    try { await api.setWhiteLedConfig(ch, { bright: Number(state.val) }); await this.setStateAsync(id, Number(state.val), true); }
                    catch (e) { this.log.warn(`Camera "${camId}" setWhiteLedConfig brightness failed: ${sanitize(e.message)}`); }
                    break;
                case 'control.whiteLedMode': {
                    // CX810/CX820 reject mode=1; the actual 'manual on' mode on these cameras is 3.
                    const modeMap = { AutoNight: 0, Manual: 3, Schedule: 3 };
                    const mode = modeMap[String(state.val)] ?? 3;
                    try { await api.setWhiteLedConfig(ch, { mode }); await this.setStateAsync(id, String(state.val), true); }
                    catch (e) { this.log.warn(`Camera "${camId}" setWhiteLedConfig mode failed: ${sanitize(e.message)}`); }
                    break;
                }
                case 'control.osdText':
                    try { await api.setOsdText(ch, String(state.val || '')); await this.setStateAsync(id, String(state.val || ''), true); }
                    catch (e) { this.log.warn(`Camera "${camId}" setOsdText failed: ${sanitize(e.message)}`); }
                    break;
                case 'control.osdShowDateTime':
                    try { await api.setOsdShowDateTime(ch, !!state.val); await this.setStateAsync(id, !!state.val, true); }
                    catch (e) { this.log.warn(`Camera "${camId}" setOsdShowDateTime failed: ${sanitize(e.message)}`); }
                    break;
                case 'control.motionSensitivity':
                    try { await api.setMdSensitivity(ch, Number(state.val)); await this.setStateAsync(id, Number(state.val), true); }
                    catch (e) { this.log.warn(`Camera "${camId}" setMdSensitivity failed: ${sanitize(e.message)}`); }
                    break;
                case 'control.audioAlarmDuration':
                    try { await api.setAudioAlarmConfig(ch, { duration: Number(state.val) }); await this.setStateAsync(id, Number(state.val), true); }
                    catch (e) { this.log.warn(`Camera "${camId}" setAudioAlarmConfig duration failed: ${sanitize(e.message)}`); }
                    break;
                case 'control.audioAlarmSound':
                    try { await api.setAudioAlarmConfig(ch, { sound: Number(state.val) }); await this.setStateAsync(id, Number(state.val), true); }
                    catch (e) { this.log.warn(`Camera "${camId}" setAudioAlarmConfig sound failed: ${sanitize(e.message)}`); }
                    break;
                case 'ptz.command': {
                    if (!this._hasCapability(camId, 'ptz')) break;
                    const speedState = await this.getStateAsync(`${camId}.ptz.speed`);
                    const speed = (speedState && speedState.val) || 32;
                    await api.ptzCtrl(String(state.val), speed, ch);
                    break;
                }
                case 'ptz.goToPreset':
                    if (!this._hasCapability(camId, 'ptz')) break;
                    await api.ptzCtrl('ToPos', 32, ch, Number(state.val));
                    await this.setStateAsync(id, state.val, true);
                    break;
                case 'ptz.patrol':
                    if (!this._hasCapability(camId, 'ptz')) break;
                    await api.ptzCtrl(state.val ? 'StartPatrol' : 'StopPatrol', 0, ch);
                    await this.setStateAsync(id, !!state.val, true);
                    break;
                case 'ptz.stop':
                    if (!this._hasCapability(camId, 'ptz')) break;
                    if (state.val) {
                        await api.stopPtz(ch);
                        await this.setStateAsync(id, false, true);
                    }
                    break;
                case 'image.brightness':
                case 'image.contrast':
                case 'image.saturation':
                case 'image.sharpness': {
                    const cfg = { channel: ch };
                    cfg[stateName] = Number(state.val);
                    await api.setIsp(cfg);
                    await this.setStateAsync(id, state.val, true);
                    break;
                }
                default:
                    this.log.debug(`Unhandled state change: ${id} = ${sanitize(String(state.val))}`);
            }
        } catch (err) {
            this.log.error(`Command ${channel}.${stateName} failed for "${camId}": ${sanitize(err.message)}`);
        }
    }

    // ─── ADMIN MESSAGES ───────────────────────────────────────────────────

    async onMessage(msg) {
        if (!msg || !msg.command) return;
        if (msg.command === 'discover') {
            this.log.info('Discovery requested');
            try {
                const found = await discoverReolinkCameras({
                    timeoutMs: (msg.message && msg.message.timeout) || 5000,
                    log: this.log,
                });
                const summary = found.length
                    ? `Found ${found.length} camera(s): ${found.map((c) => `${c.model || 'Reolink'}@${c.ip}`).join(', ')}`
                    : 'No Reolink cameras found on the network';
                this.log.info(`Discovery: ${summary}`);
                this.sendTo(msg.from, msg.command, { result: found, native: { discoveredCameras: found }, message: summary }, msg.callback);
            } catch (e) {
                const errMsg = sanitize(e.message);
                this.log.warn(`Discovery error: ${errMsg}`);
                this.sendTo(msg.from, msg.command, { result: [], error: errMsg, message: `Discovery failed: ${errMsg}` }, msg.callback);
            }
        } else if (msg.command === 'getLoxoneVIs') {
            // Build a per-camera list of Virtual Input names the user should create
            // in Loxone Config. Returns an array of rows for the admin UI table.
            const prefix = String(this.config.loxoneViPrefix || 'ReoLox').replace(/[^a-zA-Z0-9_-]/g, '') || 'ReoLox';
            const cams = Array.isArray(this.config.cameras) ? this.config.cameras : [];
            const rows = [];
            const push = (cam, suffix, type, note) => {
                const safe = String(cam.name || '').replace(/[^a-zA-Z0-9_-]/g, '_');
                rows.push({
                    camera: cam.name || '',
                    vi: `${prefix}_${safe}_${suffix}`,
                    type,
                    note: note || '',
                });
            };
            // NVR row helper — VI uses <nvrName>_<channelName>
            const pushNvrCh = (nvrName, channelName, suffix, note) => {
                const safeNvr = String(nvrName || '').replace(/[^a-zA-Z0-9_-]/g, '_');
                const safeCh = String(channelName || '').replace(/[^a-zA-Z0-9_-]/g, '_');
                rows.push({
                    camera: `${nvrName} / ${channelName}`,
                    vi: `${prefix}_${safeNvr}_${safeCh}_${suffix}`,
                    type: 'digital',
                    note: note || '',
                });
            };
            for (const cam of cams) {
                if (!cam || !cam.enabled) continue;
                if (cam.pushToLoxone === false) continue;  // user opted out for this row
                if (cam.isNvr) {
                    // Expand NVR into one row per active channel.
                    // Must match the id derived in initCamera() (cam_<host> fallback),
                    // otherwise the activeChannels lookup below misses on unnamed rows.
                    const nvrId = this.sanitizeId(cam.name || `cam_${cam.host}`);
                    const channels = this.lastStates.get(`${nvrId}.activeChannels`) || [];
                    push(cam, 'Online', 'digital', 'NVR reachable');
                    if (channels.length === 0) {
                        rows.push({
                            camera: cam.name || '',
                            vi: '(restart adapter, then click Generate again)',
                            type: '',
                            note: 'NVR channels not yet discovered',
                        });
                        continue;
                    }
                    for (const ch of channels) {
                        const chName = ch.name || `ch${ch.channel}`;
                        pushNvrCh(cam.name, chName, 'Motion', 'Motion (NVR-side)');
                        pushNvrCh(cam.name, chName, 'AI_person', 'AI person detected');
                        pushNvrCh(cam.name, chName, 'AI_vehicle', 'AI vehicle detected');
                        pushNvrCh(cam.name, chName, 'AI_animal', 'AI animal detected');
                        pushNvrCh(cam.name, chName, 'AI_face', 'AI face detected');
                    }
                    continue;
                }
                const camHasWL = this._hasCapability(this.sanitizeId(cam.name || `cam_${cam.host}`), 'whiteLed');
                push(cam, 'Motion', 'digital', 'Motion detected');
                push(cam, 'Online', 'digital', 'Camera reachable (1/0)');
                if (camHasWL) push(cam, 'whiteLed', 'digital', 'WhiteLed state');
                if (cam.isDoorbell) {
                    push(cam, 'Visitor', 'digital', '1 s pulse on doorbell ring');
                    push(cam, 'doorbellRing', 'digital', 'Doorbell button state');
                }
                push(cam, 'AI_person', 'digital', 'AI person detected');
                push(cam, 'AI_vehicle', 'digital', 'AI vehicle detected');
                push(cam, 'AI_animal', 'digital', 'AI animal detected');
                if (cam.whiteLedGateTrigger && camHasWL) {
                    push(cam, 'gate_trigger', 'digital', '1 s pulse on knock pattern');
                }
                if (this.config.loxoneIntercomEnabled) {
                    push(cam, 'intercom', 'text', 'RTSP URL string on ring');
                }
            }
            this.sendTo(msg.from, msg.command, { result: rows, native: { loxoneVIList: rows }, error: null }, msg.callback);
        } else if (msg.command === 'getLoxoneVOList') {
            // Build the Virtual Output command list (Loxone → camera) for /reolox/cmd.
            // Paths use the sanitized state id; the Loxone VO carries the host:port address.
            const cams = Array.isArray(this.config.cameras) ? this.config.cameras : [];
            const rows = [];
            const dig = (camName, label, statePath, withOff = true) => rows.push({
                cmd: `${camName} ${label}`,
                on: `/reolox/cmd/${statePath}/1`,
                off: withOff ? `/reolox/cmd/${statePath}/0` : '',
                type: 'digital',
            });
            const ana = (camName, label, statePath) => rows.push({
                cmd: `${camName} ${label}`,
                on: `/reolox/cmd/${statePath}/<v>`,
                off: '',
                type: 'analog 0-100',
            });
            for (const cam of cams) {
                if (!cam || !cam.enabled) continue;
                const id = this.sanitizeId(cam.name || `cam_${cam.host}`);
                if (cam.isNvr) {
                    const channels = this.lastStates.get(`${id}.activeChannels`) || [];
                    for (const ch of channels) {
                        dig(`${cam.name} ch${ch.channel}`, 'recording', `${id}.ch${ch.channel}.control.recording`);
                        dig(`${cam.name} ch${ch.channel}`, 'motion det.', `${id}.ch${ch.channel}.control.motionDetectionEnabled`);
                        dig(`${cam.name} ch${ch.channel}`, 'AI det.', `${id}.ch${ch.channel}.control.aiDetectionEnabled`);
                        dig(`${cam.name} ch${ch.channel}`, 'push', `${id}.ch${ch.channel}.control.notificationsEnabled`);
                    }
                    continue;
                }
                if (this._hasCapability(id, 'whiteLed')) {
                    dig(cam.name, 'WhiteLed on/off', `${id}.control.whiteLed`);
                    ana(cam.name, 'WhiteLed brightness', `${id}.control.whiteLedBrightness`);
                }
                dig(cam.name, 'Recording', `${id}.control.recording`);
                dig(cam.name, 'Push (all)', `${id}.control.notificationsEnabled`);
                dig(cam.name, 'Siren pulse', `${id}.control.siren`, false);
                dig(cam.name, 'Siren hold on/off', `${id}.control.sirenManual`);
                dig(cam.name, 'Armed siren (on detect)', `${id}.control.sirenOnDetect`);
                dig(cam.name, 'Snapshot', `${id}.control.snapshot`, false);
                dig(cam.name, 'Status LED', `${id}.control.statusLed`);
            }
            this.sendTo(msg.from, msg.command, { result: rows, native: { loxoneVOList: rows }, error: null }, msg.callback);
        } else if (msg.command === 'getLoxoneVOXml') {
            // Generate a ready-to-import Loxone Virtual Output template (.xml) for /reolox/cmd.
            const host = String(this.config.webhookHost || '').trim() || '<ioBroker-IP>';
            const port = this.config.webhookPort || 7777;
            const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            const cams = Array.isArray(this.config.cameras) ? this.config.cameras : [];
            const out = [
                '<?xml version="1.0" encoding="utf-8"?>',
                `<VirtualOut Title="ReoLox Control" Comment="ReoLox /reolox/cmd endpoint" Address="http://${esc(host)}:${port}" CmdInit="" CloseAfterSend="true" HintText="Miniserver IP and localhost skip the shared secret; other IPs append ?secret=...">`,
                '\t<Info templateType="1" minVersion="15010820"/>',
            ];
            const dig = (title, p, withOff = true) => {
                let s = `\t<VirtualOutCmd Title="${esc(title)}" Comment="" CmdOn="/reolox/cmd/${p}/1" CmdOnMethod="0"`;
                if (withOff) s += ` CmdOff="/reolox/cmd/${p}/0" CmdOffMethod="0"`;
                out.push(`${s} Analog="false" SourceValLow="0" DestValLow="0" SourceValHigh="1" DestValHigh="1" Repeat="0" HintText=""/>`);
            };
            const ana = (title, p) => out.push(`\t<VirtualOutCmd Title="${esc(title)}" Comment="" CmdOn="/reolox/cmd/${p}/&lt;v&gt;" CmdOnMethod="0" Analog="true" SourceValLow="0" DestValLow="0" SourceValHigh="100" DestValHigh="100" Repeat="0" HintText=""/>`);
            for (const cam of cams) {
                if (!cam || !cam.enabled) continue;
                const id = this.sanitizeId(cam.name || `cam_${cam.host}`);
                if (cam.isNvr) {
                    const channels = this.lastStates.get(`${id}.activeChannels`) || [];
                    for (const ch of channels) {
                        dig(`${cam.name} ch${ch.channel} recording`, `${id}.ch${ch.channel}.control.recording`);
                        dig(`${cam.name} ch${ch.channel} AI det.`, `${id}.ch${ch.channel}.control.aiDetectionEnabled`);
                    }
                    continue;
                }
                if (this._hasCapability(id, 'whiteLed')) {
                    dig(`${cam.name} WhiteLed on/off`, `${id}.control.whiteLed`);
                    ana(`${cam.name} WhiteLed brightness`, `${id}.control.whiteLedBrightness`);
                }
                dig(`${cam.name} Recording`, `${id}.control.recording`);
                dig(`${cam.name} Push (all)`, `${id}.control.notificationsEnabled`);
                dig(`${cam.name} Siren pulse`, `${id}.control.siren`, false);
                dig(`${cam.name} Siren hold on/off`, `${id}.control.sirenManual`);
                dig(`${cam.name} Armed siren (on detect)`, `${id}.control.sirenOnDetect`);
                dig(`${cam.name} Snapshot`, `${id}.control.snapshot`, false);
                dig(`${cam.name} Status LED`, `${id}.control.statusLed`);
            }
            out.push('</VirtualOut>');
            const xml = out.join('\n');
            this.sendTo(msg.from, msg.command, { result: xml, native: { loxoneVOXml: xml }, error: null }, msg.callback);
        }
    }

    // ─── SNAPSHOT CAPTURE ─────────────────────────────────────────────────

    async _captureSnapshot(camId, api, channel) {
        try {
            const buffer = await api.getSnapshot(channel);
            const snapshotDir = path.join(utils.getAbsoluteInstanceDataDir(this), 'snapshots');
            if (!fs.existsSync(snapshotDir)) fs.mkdirSync(snapshotDir, { recursive: true });
            const filename = `${camId}.jpg`;
            const filepath = path.join(snapshotDir, filename);
            fs.writeFileSync(filepath, buffer);

            await this.setStateAsync(`${camId}.snapshot.image`, `data:image/jpeg;base64,${buffer.toString('base64')}`, true);
            await this.setStateAsync(`${camId}.snapshot.timestamp`, Date.now(), true);
            await this.setStateAsync(`${camId}.snapshot.file`, filepath, true);
            this.log.debug(`Snapshot saved: ${filepath}`);
        } catch (err) {
            this.log.error(`Snapshot failed for "${camId}": ${sanitize(err.message)}`);
        }
    }

    // ─── HELPERS ──────────────────────────────────────────────────────────

    sanitizeId(name) {
        return String(name)
            .replace(/[^a-zA-Z0-9_-]/g, '_')
            .replace(/_{2,}/g, '_')
            .replace(/^_|_$/g, '')
            .toLowerCase();
    }

    async _channel(camId, name, label) {
        await this.setObjectNotExistsAsync(`${camId}.${name}`, {
            type: 'channel', common: { name: label }, native: {},
        });
    }

    async _state(camId, stateId, name, type, role, def, writable, extra = {}) {
        const common = { name, type, role, def, read: true, write: writable, ...extra };
        await this.setObjectNotExistsAsync(`${camId}.${stateId}`, {
            type: 'state', common, native: {},
        });
    }
}

if (require.main !== module) {
    module.exports = (options) => new ReoLoxAdapter(options);
} else {
    new ReoLoxAdapter();
}
