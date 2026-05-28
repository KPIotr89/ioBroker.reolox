'use strict';

const axios = require('axios');
const https = require('https');
const { mask, maskUrl, sanitize } = require('./safe-log');

const RETRYABLE_CODES = new Set([
    'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH',
    'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE',
]);

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BACKOFF_BASE_MS = 250;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * ReolinkAPI — HTTP client for Reolink cameras.
 *
 * Differences vs. the legacy implementation:
 *
 *  - Singleflight login: concurrent callers share one in-flight login promise.
 *  - Proactive refresh at 80 % of the token lease.
 *  - Exponential backoff with jitter on 5xx / 401 / network errors.
 *  - Stream URLs no longer embed credentials. The adapter exposes credential
 *    URLs separately, only inside protected states, and never logs them.
 *  - Every command goes through `_request()` for unified error handling and
 *    logging redaction.
 */
class ReolinkAPI {
    /**
     * @param {object} config
     * @param {string} config.host
     * @param {number} [config.port]
     * @param {string} config.username
     * @param {string} config.password
     * @param {number} [config.channel=0]
     * @param {boolean} [config.useHttps=false]
     * @param {number} [config.timeoutMs]
     * @param {number} [config.maxRetries]
     * @param {object} [config.log]
     */
    constructor(config) {
        this.host = config.host;
        this.port = config.port || (config.useHttps ? 443 : 80);
        this.username = config.username || '';
        this.password = config.password || '';
        this.channel = config.channel || 0;
        this.useHttps = !!config.useHttps;
        this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
        this.maxRetries = config.maxRetries !== undefined ? config.maxRetries : DEFAULT_MAX_RETRIES;
        this.backoffBaseMs = config.backoffBaseMs || DEFAULT_BACKOFF_BASE_MS;
        this.log = config.log || console;

        this.token = null;
        this.tokenExpiry = null;
        /** @type {Promise<string>|null} active login promise (singleflight) */
        this._loginPromise = null;

        this.baseUrl = `${this.useHttps ? 'https' : 'http'}://${this.host}:${this.port}`;
        this.client = axios.create({
            baseURL: this.baseUrl,
            timeout: this.timeoutMs,
            httpsAgent: new https.Agent({ rejectUnauthorized: false }),
            headers: { 'Content-Type': 'application/json' },
            validateStatus: () => true, // we handle status manually
        });
    }

    // ─── Public credentials (do NOT log these) ────────────────────────────

    /** Plain RTSP URL with credentials. Caller decides whether to store it. */
    rtspUrlWithCreds(channel, stream = 'main') {
        const ch = channel !== undefined ? channel : this.channel;
        const path = stream === 'sub' ? `h264Preview_0${ch + 1}_sub`
            : stream === 'ext' ? `h264Preview_0${ch + 1}_ext`
                : `h264Preview_0${ch + 1}_main`;
        return `rtsp://${encodeURIComponent(this.username)}:${encodeURIComponent(this.password)}@${this.host}:554/${path}`;
    }

    /** RTSP URL without credentials — safe to log / store publicly. */
    rtspUrlPublic(channel, stream = 'main') {
        const ch = channel !== undefined ? channel : this.channel;
        const path = stream === 'sub' ? `h264Preview_0${ch + 1}_sub`
            : stream === 'ext' ? `h264Preview_0${ch + 1}_ext`
                : `h264Preview_0${ch + 1}_main`;
        return `rtsp://${this.host}:554/${path}`;
    }

    rtmpUrlWithCreds(channel, stream = 'main') {
        const ch = channel !== undefined ? channel : this.channel;
        const sub = stream === 'sub' ? `bcs/channel${ch}_sub.bcs` : `bcs/channel${ch}_main.bcs`;
        return `rtmp://${this.host}:1935/${sub}?channel=${ch}&stream=0&user=${encodeURIComponent(this.username)}&password=${encodeURIComponent(this.password)}`;
    }

    flvUrlWithCreds(channel, stream = 'main') {
        const ch = channel !== undefined ? channel : this.channel;
        const s = stream === 'sub' ? 'sub' : 'main';
        return `${this.baseUrl}/flv?port=1935&app=bcs&stream=channel${ch}_${s}.bcs&user=${encodeURIComponent(this.username)}&password=${encodeURIComponent(this.password)}`;
    }

    // ─── AUTH ──────────────────────────────────────────────────────────────

    /**
     * Acquire a token, with singleflight so concurrent commands triggering
     * `ensureAuth()` share one network round-trip.
     */
    async login() {
        if (this._loginPromise) return this._loginPromise;
        this._loginPromise = this._doLogin()
            .finally(() => { this._loginPromise = null; });
        return this._loginPromise;
    }

    async _doLogin() {
        const body = [{
            cmd: 'Login',
            action: 0,
            param: { User: { userName: this.username, password: this.password } },
        }];
        const res = await this._raw('post', '/cgi-bin/api.cgi?cmd=Login', body);
        const data = Array.isArray(res.data) ? res.data[0] : res.data;
        if (data && data.code === 0 && data.value && data.value.Token) {
            this.token = data.value.Token.name;
            const lease = data.value.Token.leaseTime || 3600;
            // Refresh at 80 % of lease.
            this.tokenExpiry = Date.now() + lease * 800;
            this.log.debug(`[ReolinkAPI] ${this.host} login OK (user=${sanitize(this.username)}, pw=${mask(this.password)}, lease=${lease}s)`);
            return this.token;
        }
        this.token = null;
        this.tokenExpiry = null;
        throw new Error(`Login failed: code=${data && data.code}, error=${this._safeJson(data && data.error)}`);
    }

    async logout() {
        if (!this.token) return;
        try { await this._cmd('Logout'); } catch (_) { /* best effort */ }
        this.token = null;
        this.tokenExpiry = null;
    }

    async ensureAuth() {
        if (!this.token || (this.tokenExpiry && Date.now() > this.tokenExpiry)) {
            await this.login();
        }
    }

    isAuthenticated() {
        return !!this.token && (!this.tokenExpiry || Date.now() <= this.tokenExpiry);
    }

    // ─── REQUEST ENGINE ────────────────────────────────────────────────────

    /**
     * Low-level request with retries. Returns the raw axios response.
     * Never logs the password or token in URLs.
     */
    async _raw(method, url, body, options = {}) {
        let attempt = 0;
        const maxRetries = options.maxRetries !== undefined ? options.maxRetries : this.maxRetries;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            try {
                const cfg = { method, url, data: body, ...options };
                const res = await this.client.request(cfg);
                if (res.status >= 500 && attempt < maxRetries) {
                    attempt++;
                    await sleep(this._backoff(attempt));
                    continue;
                }
                return res;
            } catch (err) {
                const code = err.code || (err.cause && err.cause.code);
                if (RETRYABLE_CODES.has(code) && attempt < maxRetries) {
                    attempt++;
                    this.log.debug(`[ReolinkAPI] ${this.host} ${maskUrl(url)} retry ${attempt} after ${code}`);
                    await sleep(this._backoff(attempt));
                    continue;
                }
                err.message = `${err.message} [${this.host} ${maskUrl(url)}]`;
                throw err;
            }
        }
    }

    _backoff(attempt) {
        const base = this.backoffBaseMs * Math.pow(2, attempt - 1);
        const jitter = base * 0.3 * (Math.random() * 2 - 1);
        return Math.max(50, Math.floor(base + jitter));
    }

    _safeJson(v) {
        try { return JSON.stringify(v); } catch (_) { return '<unserializable>'; }
    }

    /**
     * Token-authenticated POST for /cgi-bin/api.cgi commands.
     * Retries once on 401 by refreshing the token (independent of network retries).
     */
    async _cmd(cmd, param = {}, action = 0) {
        await this.ensureAuth();
        const body = [{ cmd, action, param }];

        const tryOnce = async () => {
            const url = `/cgi-bin/api.cgi?cmd=${encodeURIComponent(cmd)}&token=${encodeURIComponent(this.token)}`;
            const res = await this._raw('post', url, body);
            const data = Array.isArray(res.data) ? res.data[0] : res.data;
            return { res, data };
        };

        let { res, data } = await tryOnce();
        // -6 / "please login first" can be reported either as data.code or data.error.rspCode (firmware-dependent)
        const isAuthError = res.status === 401
            || (data && data.code === -6)
            || (data && data.error && data.error.rspCode === -6);
        if (isAuthError) {
            this.token = null;
            await this.login();
            ({ res, data } = await tryOnce());
        }

        if (data && data.code === 0) return data.value || {};
        if (data && data.value && data.code === undefined) return data.value;
        const err = new Error(`Command ${cmd} failed: status=${res.status}, code=${data && data.code}, error=${this._safeJson(data && data.error)}`);
        err.code = data && data.code;
        throw err;
    }

    async _batchCmd(commands) {
        await this.ensureAuth();
        const cmdNames = commands.map((c) => encodeURIComponent(c.cmd)).join('&cmd=');
        const url = `/cgi-bin/api.cgi?cmd=${cmdNames}&token=${encodeURIComponent(this.token)}`;
        const body = commands.map((c) => ({ cmd: c.cmd, action: c.action || 0, param: c.param || {} }));
        const res = await this._raw('post', url, body);
        return res.data;
    }

    /**
     * Token-less direct auth — required by some firmware revisions for
     * SetWhiteLed / AudioAlarmPlay etc.
     */
    async _cmdDirect(cmd, param = {}, action = null, urlParams = {}) {
        const qs = new URLSearchParams();
        qs.set('cmd', cmd);
        qs.set('user', this.username);
        qs.set('password', this.password);
        for (const [k, v] of Object.entries(urlParams)) qs.set(k, String(v));
        const url = `/api.cgi?${qs.toString()}`;

        const bodyEntry = action !== null ? { cmd, action, param } : { cmd, param };
        const body = [bodyEntry];
        const res = await this._raw('post', url, body);
        const data = Array.isArray(res.data) ? res.data[0] : res.data;
        if (data && (data.code === 0 || (data.code === undefined && data.value))) return data.value || {};
        const err = new Error(`Direct command ${cmd} failed: code=${data && data.code}, error=${this._safeJson(data && data.error)}`);
        err.code = data && data.code;
        throw err;
    }

    async _getBuffer(cmd, extraParams = {}) {
        await this.ensureAuth();
        const params = new URLSearchParams({ cmd, token: this.token, ...extraParams });
        const url = `/cgi-bin/api.cgi?${params.toString()}`;
        const res = await this._raw('get', url, undefined, { responseType: 'arraybuffer' });
        return Buffer.from(res.data);
    }

    // ─── Device info ───────────────────────────────────────────────────────

    getDevInfo() { return this._cmd('GetDevInfo'); }
    getAbility() { return this._cmd('GetAbility', { User: { userName: this.username } }); }
    getHddInfo() { return this._cmd('GetHddInfo'); }
    /**
     * NVR-only: per-channel status list. Returns { count, status: [{channel,name,online,sleep,uid}, ...] }.
     * For RLN8-410 firmware reports up to 12 slots even though only 8 are physically used.
     */
    getChannelStatus() { return this._cmd('GetChannelstatus'); }
    getPerformance() { return this._cmd('GetPerformance'); }
    reboot() { return this._cmd('Reboot'); }

    // ─── Network / system ─────────────────────────────────────────────────

    getNetworkGeneral() { return this._cmd('GetLocalLink'); }
    getWifi() { return this._cmd('GetWifi'); }
    scanWifi() { return this._cmd('ScanWifi'); }
    getDdns() { return this._cmd('GetDdns'); }
    getNtp() { return this._cmd('GetNtp'); }
    setNtp(c) { return this._cmd('SetNtp', { Ntp: c }, 0); }
    getP2p() { return this._cmd('GetP2p'); }
    getNetPort() { return this._cmd('GetNetPort'); }
    getUpnp() { return this._cmd('GetUpnp'); }
    getTime() { return this._cmd('GetTime'); }
    setTime(c) { return this._cmd('SetTime', { Time: c }, 0); }

    // ─── Video / ISP / OSD ────────────────────────────────────────────────

    getEnc(channel) { return this._cmd('GetEnc', { channel: channel ?? this.channel }); }
    setEnc(c) { return this._cmd('SetEnc', { Enc: c }, 0); }
    getIsp(channel) { return this._cmd('GetIsp', { channel: channel ?? this.channel }); }
    setIsp(c) { return this._cmd('SetIsp', { Isp: c }, 0); }
    getOsd(channel) { return this._cmd('GetOsd', { channel: channel ?? this.channel }); }
    setOsd(c) { return this._cmd('SetOsd', { Osd: c }, 0); }

    /** Update OSD overlay text on the live image. */
    async setOsdText(channel, text) {
        const ch = channel ?? this.channel;
        const current = await this.getOsd(ch);
        const osd = (current && current.Osd) || {};
        osd.channel = ch;
        osd.osdChannel = osd.osdChannel || { pos: 'Lower Right', enable: 1 };
        osd.osdChannel.name = String(text || '').slice(0, 31);
        osd.osdChannel.enable = text ? 1 : 0;
        return this._cmd('SetOsd', { Osd: osd }, 0);
    }

    /** Toggle the date/time stamp in the OSD overlay. */
    async setOsdShowDateTime(channel, enabled) {
        const ch = channel ?? this.channel;
        const current = await this.getOsd(ch);
        const osd = (current && current.Osd) || {};
        osd.channel = ch;
        osd.osdTime = osd.osdTime || { pos: 'Upper Right' };
        osd.osdTime.enable = enabled ? 1 : 0;
        return this._cmd('SetOsd', { Osd: osd }, 0);
    }
    getMask(channel) { return this._cmd('GetMask', { channel: channel ?? this.channel }); }

    // ─── Snapshot ─────────────────────────────────────────────────────────

    /** Capture JPEG bytes for the given channel. */
    getSnapshot(channel) {
        const ch = channel ?? this.channel;
        return this._getBuffer('Snap', { channel: String(ch), rs: `snap_${Date.now()}` });
    }

    // ─── Motion / AI / Doorbell ───────────────────────────────────────────

    getMdState(channel) { return this._cmd('GetMdState', { channel: channel ?? this.channel }); }
    getMdAlarm(channel) { return this._cmd('GetAlarm', { Alarm: { channel: channel ?? this.channel, type: 'md' } }, 1); }

    /** Read the first 'sens' value from MD Alarm (camera reports a list of sensitivity bands; we use the first). */
    async getMdSensitivity(channel) {
        const ch = channel ?? this.channel;
        const res = await this.getMdAlarm(ch);
        const arr = (res && res.Alarm && res.Alarm.sens) || [];
        return arr.length ? (arr[0].sensitivity || arr[0].sens || 0) : 0;
    }

    /** Set MD sensitivity uniformly across all bands. */
    async setMdSensitivity(channel, sensitivity) {
        const ch = channel ?? this.channel;
        const current = await this.getMdAlarm(ch);
        const alarm = (current && current.Alarm) || {};
        alarm.channel = ch;
        alarm.type = 'md';
        if (Array.isArray(alarm.sens)) {
            alarm.sens = alarm.sens.map((band) => ({ ...band, sensitivity: Number(sensitivity) }));
        } else {
            alarm.sens = [{ id: 0, sensitivity: Number(sensitivity), beginHour: 0, beginMin: 0, endHour: 23, endMin: 59 }];
        }
        return this._cmd('SetAlarm', { Alarm: alarm }, 0);
    }
    setMdAlarm(c) { return this._cmd('SetAlarm', { Alarm: c }, 0); }
    getAiState(channel) { return this._cmd('GetAiState', { channel: channel ?? this.channel }); }
    getAiAlarm(channel) { return this._cmd('GetAiCfg', { channel: channel ?? this.channel }); }
    setAiAlarm(c) { return this._cmd('SetAiCfg', { AiCfg: c }, 0); }
    getDoorbell(channel) { return this._cmd('GetDoorbell', { channel: channel ?? this.channel }); }
    getPush(channel) { return this._cmd('GetPushV20', { channel: channel ?? this.channel }); }
    setPush(c) { return this._cmd('SetPushV20', { Push: c }, 0); }

    /** Master push enable/disable per channel. */
    async setPushEnabled(channel, enabled) {
        const ch = channel ?? this.channel;
        return this._cmd('SetPushV20', { Push: { channel: ch, enable: enabled ? 1 : 0 } }, 0);
    }

    /** Toggle a single push event type 24/7. type ∈ {MD, AI_PEOPLE, AI_VEHICLE, AI_DOG_CAT, AI_FACE, VISITOR}. */
    async setPushScheduleType(channel, type, enabled) {
        const ch = channel ?? this.channel;
        const slot = enabled ? '1'.repeat(168) : '0'.repeat(168);
        return this._cmd('SetPushV20', { Push: { channel: ch, schedule: { channel: ch, table: { [type]: slot } } } }, 0);
    }

    /** Read current per-type push schedule. Returns { MD, AI_PEOPLE, ... : boolean } — true if any hour in the week is enabled. */
    async getPushTypes(channel) {
        const ch = channel ?? this.channel;
        const res = await this.getPush(ch);
        const table = (res && res.Push && res.Push.schedule && res.Push.schedule.table) || {};
        const out = {};
        for (const t of ['MD', 'AI_PEOPLE', 'AI_VEHICLE', 'AI_DOG_CAT', 'AI_FACE', 'VISITOR']) {
            const slot = table[t] || '';
            out[t] = slot.includes('1');
        }
        out.enabled = !!(res && res.Push && res.Push.enable);
        return out;
    }

    // ─── Audio alarm ──────────────────────────────────────────────────────

    getAudioAlarmState(channel) { return this._cmd('GetAudioAlarmV20', { channel: channel ?? this.channel }); }
    setAudioAlarm(c) { return this._cmd('SetAudioAlarmV20', { AudioAlarmV20: c }, 0); }

    /** Patch only duration / sound on existing audio alarm config. */
    async setAudioAlarmConfig(channel, { duration, sound }) {
        const ch = channel ?? this.channel;
        const current = await this.getAudioAlarmState(ch);
        const cfg = (current && current.AudioAlarmV20) || {};
        cfg.channel = ch;
        if (duration !== undefined) cfg.duration = Number(duration);
        if (sound !== undefined) cfg.sound_index = Number(sound);
        return this._cmd('SetAudioAlarmV20', { AudioAlarmV20: cfg }, 0);
    }

    // ─── PTZ ──────────────────────────────────────────────────────────────

    async ptzCtrl(op, speed = 32, channel, presetIdx) {
        const ch = channel ?? this.channel;
        const param = { PtzCtrl: { channel: ch, op, speed } };
        if (presetIdx !== undefined) param.PtzCtrl.id = presetIdx;
        return this._cmd('PtzCtrl', param, 0);
    }
    getPtzPresets(channel) { return this._cmd('GetPtzPreset', { channel: channel ?? this.channel }); }
    setPtzPreset(c) { return this._cmd('SetPtzPreset', { PtzPreset: c }, 0); }
    getPtzPatrol(channel) { return this._cmd('GetPtzPatrol', { channel: channel ?? this.channel }); }
    getPtzGuard(channel) { return this._cmd('GetPtzGuard', { channel: channel ?? this.channel }); }
    setPtzGuard(c) { return this._cmd('SetPtzGuard', { PtzGuard: c }, 0); }
    getZoomFocus(channel) { return this._cmd('GetZoomFocus', { channel: channel ?? this.channel }); }
    startZoom(direction, channel) { return this.ptzCtrl(direction === 'in' ? 'ZoomInc' : 'ZoomDec', 32, channel); }
    stopPtz(channel) { return this.ptzCtrl('Stop', 0, channel); }

    // ─── Recording ────────────────────────────────────────────────────────

    getRec(channel) { return this._cmd('GetRec', { channel: channel ?? this.channel }); }
    setRec(c) { return this._cmd('SetRec', { Rec: c }, 0); }
    searchRecordings(c) { return this._cmd('Search', { Search: c }); }
    getRecSchedule(channel) { return this._cmd('GetRecV20', { channel: channel ?? this.channel }); }

    // ─── IR / WhiteLed ────────────────────────────────────────────────────

    getIrLights(channel) { return this._cmd('GetIrLights', { channel: channel ?? this.channel }); }
    setIrLights(c) { return this._cmd('SetIrLights', { IrLights: c }, 0); }

    /** PowerLed — the front status LED on the camera. */
    getPowerLed(channel) { return this._cmd('GetPowerLed', { channel: channel ?? this.channel }); }
    setPowerLed(channel, enabled) {
        return this._cmd('SetPowerLed', { PowerLed: { channel: channel ?? this.channel, state: enabled ? 'On' : 'Off' } }, 0);
    }

    /** Enable / disable recording on the camera SD or NVR HDD. */
    async setRecEnabled(channel, enabled) {
        const ch = channel ?? this.channel;
        const current = await this.getRec(ch);
        const rec = (current && current.Rec) || current || {};
        rec.channel = ch;
        rec.schedule = rec.schedule || {};
        rec.schedule.enable = enabled ? 1 : 0;
        return this._cmd('SetRec', { Rec: rec }, 0);
    }

    /** WhiteLed control — direct auth for firmware compatibility (CX810 etc.). */
    getWhiteLed(channel) { return this._cmdDirect('GetWhiteLed', { channel: channel ?? this.channel }, 0); }

    setWhiteLed(ledConfig) {
        const payload = {
            WhiteLed: {
                state: ledConfig.state || 0,
                channel: ledConfig.channel || 0,
                mode: ledConfig.mode !== undefined ? ledConfig.mode : 0,
                bright: ledConfig.bright || 100,
                LightingSchedule: ledConfig.LightingSchedule || { EndHour: 0, EndMin: 0, StartHour: 0, StartMin: 0 },
                wlAiDetectType: ledConfig.wlAiDetectType || { dog_cat: 0, face: 0, people: 0, vehicle: 0 },
            },
        };
        return this._cmdDirect('SetWhiteLed', payload, null, { channel: ledConfig.channel || 0 });
    }

    /**
     * Update WhiteLed config. Accepts any subset of { state, bright, mode }.
     *
     * Robust to all known GetWhiteLed response shapes (envelope, array, bare).
     * Drops LightingSchedule / wlAiDetectType from outbound payload — round-tripping
     * them trips strict validation on CX810/CX820. When only `bright` is requested,
     * forces state=1 + mode=1 (Manual) so the change is visible immediately —
     * otherwise an AutoNight camera would store the value but never turn on.
     */
    async setWhiteLedConfig(channel, { state, bright, mode }) {
        const ch = channel ?? this.channel;
        const raw = await this.getWhiteLed(ch);

        // Unwrap every known shape into a flat WhiteLed object
        let wl;
        if (raw && raw.WhiteLed) wl = { ...raw.WhiteLed };
        else if (raw && raw.value && raw.value.WhiteLed) wl = { ...raw.value.WhiteLed };
        else if (Array.isArray(raw) && raw[0] && raw[0].value && raw[0].value.WhiteLed) wl = { ...raw[0].value.WhiteLed };
        else wl = {};

        wl.channel = ch;
        delete wl.LightingSchedule;
        delete wl.wlAiDetectType;

        const onlyBright = bright !== undefined && state === undefined && mode === undefined;
        if (onlyBright) {
            wl.state = 1;
            wl.mode = 1;
        }
        if (state !== undefined) wl.state = state ? 1 : 0;
        if (bright !== undefined) wl.bright = Math.max(0, Math.min(100, Number(bright)));
        if (mode !== undefined) wl.mode = Number(mode);

        return this._cmdDirect('SetWhiteLed', { WhiteLed: wl }, null, { channel: ch });
    }

    triggerSiren(channel, durationSec = 5) {
        const ch = channel ?? this.channel;
        return this._cmdDirect('AudioAlarmPlay', { AudioAlarmPlay: { channel: ch, manualSwitch: 1, duration: durationSec } }, null, { channel: ch });
    }

    // ─── Audio / Email / FTP / Push ───────────────────────────────────────

    getAudioCfg(channel) { return this._cmd('GetAudioCfg', { channel: channel ?? this.channel }); }
    setAudioCfg(c) { return this._cmd('SetAudioCfg', { AudioCfg: c }, 0); }
    getEmail() { return this._cmd('GetEmail'); }
    setEmail(c) { return this._cmd('SetEmail', { Email: c }, 0); }
    testEmail() { return this._cmd('TestEmail'); }
    getFtp() { return this._cmd('GetFtp'); }
    setFtp(c) { return this._cmd('SetFtp', { Ftp: c }, 0); }
    testFtp() { return this._cmd('TestFtp'); }
    getPushLegacy() { return this._cmd('GetPush'); }
    setPushLegacy(c) { return this._cmd('SetPush', { Push: c }, 0); }

    // ─── Users ────────────────────────────────────────────────────────────

    getOnline() { return this._cmd('GetOnline'); }
    getUser() { return this._cmd('GetUser'); }

    // ─── Composite helpers ────────────────────────────────────────────────

    async isAlive() {
        try { await this.getDevInfo(); return true; } catch (_) { return false; }
    }

    // ─── Phase 2: per-channel detection toggles (used by NVR control states) ─

    /** Enable / disable MD alarm. Read-modify-write so zones/sensitivity stay intact. */
    async setMdAlarmEnabled(channel, enabled) {
        const ch = channel ?? this.channel;
        const current = await this.getMdAlarm(ch);
        const alarm = (current && current.Alarm) || {};
        alarm.channel = ch;
        alarm.type = 'md';
        alarm.enable = enabled ? 1 : 0;
        return this._cmd('SetAlarm', { Alarm: alarm }, 0);
    }

    async getMdAlarmEnabled(channel) {
        const ch = channel ?? this.channel;
        const r = await this.getMdAlarm(ch);
        return !!(r && r.Alarm && r.Alarm.enable);
    }

    /**
     * Master AI detection — toggles every supported AI type at once.
     * On NVR each channel has its own AiCfg; sets enable=1/0 on each existing block.
     */
    async setAiCfgEnabled(channel, enabled) {
        const ch = channel ?? this.channel;
        const current = await this.getAiAlarm(ch);
        const cfg = (current && (current.AiCfg || (current.value && current.value.AiCfg))) || {};
        cfg.channel = ch;
        let touched = 0;
        for (const type of ['people', 'vehicle', 'dog_cat', 'face']) {
            if (cfg[type] && typeof cfg[type] === 'object') {
                cfg[type].enable = enabled ? 1 : 0;
                touched++;
            }
        }
        if (!touched) return { ok: true, skipped: 'no AI types reported' };
        return this._cmd('SetAiCfg', { AiCfg: cfg }, 0);
    }

    async getAiCfgEnabled(channel) {
        const ch = channel ?? this.channel;
        const r = await this.getAiAlarm(ch);
        const cfg = (r && (r.AiCfg || (r.value && r.value.AiCfg))) || {};
        return !!(
            (cfg.people && cfg.people.enable) ||
            (cfg.vehicle && cfg.vehicle.enable) ||
            (cfg.dog_cat && cfg.dog_cat.enable) ||
            (cfg.face && cfg.face.enable)
        );
    }
}

module.exports = ReolinkAPI;
