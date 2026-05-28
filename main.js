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

        this.subscribeStates('*');
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

            await this._detectCapabilities(camId, api, camConfig);
            await this._createCameraObjects(camId, camConfig, info);
            await this._updateStreamUrls(camId, camConfig, api);

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

    async _detectCapabilities(camId, api, camConfig) {
        const caps = {
            ptz: false, whiteLed: false, siren: false,
            aiDetection: false, visitor: false, doorbell: false,
            motionDetection: true, irLights: true, recording: true, snapshot: true,
        };

        // Try disk cache first to skip ~50 KB GetAbility on cold start.
        let ability = null;
        if (this.capabilityCache) {
            ability = this.capabilityCache.get(api.host, api.port, api.username);
            if (ability) this.log.debug(`Camera "${camId}": GetAbility loaded from cache`);
        }
        if (!ability) {
            try {
                ability = await api.getAbility();
                if (ability && this.capabilityCache) {
                    this.capabilityCache.set(api.host, api.port, api.username, ability);
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

            if (chn.ledControl && chn.ledControl.permit > 0) caps.whiteLed = true;
            if (chn.alarmAudio && chn.alarmAudio.permit > 0 && chn.alarmAudio.ver > 0) caps.siren = true;
            if (chn.supportAiVisitor && (chn.supportAiVisitor.ver > 0 || chn.supportAiVisitor.permit > 0)) caps.visitor = true;
        }

        // If GetAbility didn't confirm WhiteLed, probe — some firmwares omit it.
        if (!caps.whiteLed) {
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
            await this._state(camId, 'status.whiteLed', 'White LED state', 'boolean', 'sensor', false, false);
            await this._state(camId, 'status.whiteLedTrigger', 'Gate trigger (≤3s WhiteLed flash detected)', 'boolean', 'sensor', false, false);
        }
        if (this._hasCapability(camId, 'siren')) {
            await this._state(camId, 'control.siren', 'Trigger siren/alarm', 'boolean', 'button', false, true);
        }

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

    // ─── POLLING ──────────────────────────────────────────────────────────

    async _pollMain(camId) {
        const api = this.cameras.get(camId);
        const camConfig = this.camConfigs.get(camId);
        if (!api || !camConfig) return;
        const ch = camConfig.channel || 0;

        let connected = true;
        try {
            // AI-only motion. GetMdState (classic motion) is intentionally not used —
            // it is unreliable on CX-series and effectively replaced by AI detection.
            // Motion VI fires whenever AI sees a person/vehicle/animal/face.
            let aiAny = false;
            try {
                const aiState = await api.getAiState(ch);
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
                        if (this.loxoneBridge) await this.loxoneBridge.sendAi(camConfig.name || camId, type, detected);
                    });
                }
            } catch (e) {
                this.log.debug(`AI poll failed for ${camId}: ${sanitize(e.message)}`);
            }

            // Motion = any AI detection
            await this._emitChange(camId, 'motion', aiAny, async () => {
                await this.setStateAsync(`${camId}.status.motionDetected`, aiAny, true);
                if (aiAny) await this.setStateAsync(`${camId}.status.lastMotionTime`, Date.now(), true);
                if (this.loxoneBridge) await this.loxoneBridge.sendMotion(camConfig.name || camId, aiAny);
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
                        if (this.loxoneBridge) {
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
            if (this.loxoneBridge) await this.loxoneBridge.sendStatus(camConfig.name || camId, connected);
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

    // ─── WEBHOOK ──────────────────────────────────────────────────────────

    async _startWebhookServer() {
        const allowlistRaw = this.config.webhookIpAllowlist || 'auto';
        const allowlist = allowlistRaw === 'auto'
            ? 'auto'
            : String(allowlistRaw).split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

        this.webhookServer = new WebhookServer({
            port: this.config.webhookPort,
            host: '0.0.0.0',
            sharedSecret: this.config.webhookSharedSecret || '',
            ipAllowlist: allowlist,
            pathPrefix: '/reolox',
            log: this.log,
            onEvent: (camId, sourceIp, events) => this._dispatchWebhook(camId, sourceIp, events),
        });
        try {
            await this.webhookServer.start();
        } catch (e) {
            this.log.error(`Webhook server failed to start on port ${this.config.webhookPort}: ${sanitize(e.message)}`);
            this.webhookServer = null;
        }
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
                        await api.setWhiteLed({ channel: ch, state: state.val ? 1 : 0, mode: 0, bright: 100 });
                        await this.setStateAsync(id, !!state.val, true);
                    } catch (e) {
                        this.log.warn(`Camera "${camId}" SetWhiteLed failed: ${sanitize(e.message)}`);
                    }
                    break;
                }
                case 'control.siren':
                    if (state.val) {
                        try { await api.triggerSiren(ch, 5); this.log.info(`Siren on "${camId}"`); }
                        catch (e) { this.log.debug(`Siren failed: ${sanitize(e.message)}`); }
                        await this.setStateAsync(id, false, true);
                    }
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
            for (const cam of cams) {
                if (!cam || !cam.enabled) continue;
                push(cam, 'Motion', 'digital', 'Motion detected');
                push(cam, 'Online', 'digital', 'Camera reachable (1/0)');
                push(cam, 'whiteLed', 'digital', 'WhiteLed state');
                if (cam.isDoorbell) {
                    push(cam, 'Visitor', 'digital', '1 s pulse on doorbell ring');
                    push(cam, 'doorbellRing', 'digital', 'Doorbell button state');
                }
                push(cam, 'AI_person', 'digital', 'AI person detected');
                push(cam, 'AI_vehicle', 'digital', 'AI vehicle detected');
                push(cam, 'AI_animal', 'digital', 'AI animal detected');
                if (cam.whiteLedGateTrigger) {
                    push(cam, 'gate_trigger', 'digital', '1 s pulse on knock pattern');
                }
                if (this.config.loxoneIntercomEnabled) {
                    push(cam, 'intercom', 'text', 'RTSP URL string on ring');
                }
            }
            this.sendTo(msg.from, msg.command, { result: rows, native: { loxoneVIList: rows }, error: null }, msg.callback);
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
