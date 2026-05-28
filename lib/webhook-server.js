'use strict';

const http = require('http');
const crypto = require('crypto');
const { sanitize } = require('./safe-log');

const MAX_BODY_BYTES = 64 * 1024; // hard cap to prevent DoS via large POSTs

/**
 * Parse a Reolink push payload into a list of normalized events.
 * Exported so unit tests can exercise it without spinning up HTTP.
 *
 * Reolink firmware variants observed:
 *  - [ {cmd:"NotifyAlarmEvent", value:{AlarmEvent:{channel,type,alarm_state}}} ]
 *  - [ {cmd:"NotifyAlarmEvent", param:{AlarmEvent:{...}}} ]
 *  - flat:  {event:"visitor", state:1}
 *  - flat:  {type:"md", alarm_state:1}
 *
 * Returns { list: [{type, active}], cameraName }.
 *
 * @param {any} payload    Parsed JSON (object, array, or null)
 * @returns {{list:Array<{type:string,active:boolean}>, cameraName:string|null}}
 */
function parseReolinkPushPayload(payload) {
    const result = { list: [], cameraName: null };
    if (payload === null || payload === undefined) return result;

    const cmds = Array.isArray(payload) ? payload : [payload];

    for (const cmd of cmds) {
        if (!cmd || typeof cmd !== 'object') continue;

        const alarm = (cmd.value && cmd.value.AlarmEvent)
            || (cmd.param && cmd.param.AlarmEvent)
            || cmd.AlarmEvent
            || cmd.alarm;

        if (alarm) {
            result.cameraName = alarm.name || alarm.camera_name || result.cameraName;
            const active = !!(alarm.alarm_state === 1 || alarm.alarm_state === true || alarm.active === 1);
            const type = sanitize(alarm.type || alarm.event_type || '').toLowerCase();
            if (type) result.list.push({ type, active });
            continue;
        }

        if (cmd.event || cmd.type) {
            result.cameraName = cmd.name || cmd.camera_name || result.cameraName;
            const type = sanitize(cmd.event || cmd.type || '').toLowerCase();
            const active = !!(cmd.state === 1 || cmd.alarm_state === 1 || cmd.active === 1);
            if (type) result.list.push({ type, active });
        }
    }

    return result;
}

/**
 * Compare two values in constant time. Falls back to false for inputs that
 * aren't strings of equal length.
 */
function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Self-contained HTTP server for Reolink push events.
 *
 * Hardenings vs. the previous in-line implementation:
 *  - IP allow-list (auto = derived from configured camera hosts)
 *  - shared-secret authentication (?secret=... or X-ReoLox-Secret header)
 *  - 64 KB body cap with early socket destroy
 *  - method/path validation
 *  - sanitised log lines (no CRLF injection)
 */
class WebhookServer {
    /**
     * @param {object} opts
     * @param {number}   opts.port
     * @param {string}   [opts.host="0.0.0.0"]
     * @param {string}   [opts.sharedSecret=""]
     * @param {string[]|"auto"} [opts.ipAllowlist="auto"]  Explicit IPs or "auto"
     * @param {string}   [opts.pathPrefix="/reolox"]       URL prefix for events
     * @param {(camId:string, sourceIp:string, events:Array, rawBody:Buffer)=>Promise|void} opts.onEvent
     * @param {object}   [opts.log]
     */
    constructor(opts) {
        this.port = opts.port;
        this.host = opts.host || '0.0.0.0';
        this.sharedSecret = opts.sharedSecret || '';
        this.ipAllowlist = opts.ipAllowlist || 'auto';
        this.pathPrefix = (opts.pathPrefix || '/reolox').replace(/\/+$/, '');
        this.onEvent = opts.onEvent;
        this.onControl = opts.onControl || null;
        this.controlEnabled = opts.controlEnabled !== false;
        // Extra source IPs trusted for the control endpoint only (e.g. the Loxone
        // Miniserver), on top of the event allowlist.
        this.extraAllowed = Array.isArray(opts.extraAllowed)
            ? opts.extraAllowed.map((s) => String(s).trim()).filter(Boolean)
            : [];
        this.log = opts.log || console;

        /** @type {Map<string, {host:string}>} cam id → camera config */
        this.cameras = new Map();
        /** @type {http.Server|null} */
        this.server = null;
    }

    /**
     * Register cameras the server will recognise. Call this once after start
     * (and re-call if the camera list changes).
     */
    setCameras(map) {
        this.cameras = map instanceof Map ? new Map(map) : new Map(Object.entries(map || {}));
    }

    start() {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => this._handle(req, res));
            this.server.on('error', (e) => {
                this.log.error(`[WebhookServer] error: ${sanitize(e.message)}`);
                reject(e);
            });
            this.server.listen(this.port, this.host, () => {
                const ctrl = this.controlEnabled ? ` (+ ${this.pathPrefix}/cmd/<state>/<value> control)` : '';
                this.log.info(`[WebhookServer] listening on ${this.host}:${this.port} ${this.pathPrefix}/<camera>${ctrl}`);
                resolve();
            });
        });
    }

    async stop() {
        if (!this.server) return;
        await new Promise((resolve) => {
            try { this.server.close(() => resolve()); } catch (_) { resolve(); }
        });
        this.server = null;
    }

    _sourceIp(req) {
        // Trust only the socket address. X-Forwarded-For is omitted intentionally
        // — cameras don't go through reverse proxies in this use case.
        return (req.socket && req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    }

    _ipAllowed(ip) {
        if (this.ipAllowlist === 'auto') {
            for (const cfg of this.cameras.values()) {
                if (cfg && cfg.host === ip) return true;
            }
            return false;
        }
        if (Array.isArray(this.ipAllowlist) && this.ipAllowlist.length > 0) {
            return this.ipAllowlist.includes(ip);
        }
        // empty array = block everything; undefined = allow (legacy, not used).
        return false;
    }

    _secretOk(req, url) {
        if (!this.sharedSecret) return true;
        const headerSecret = req.headers['x-reolox-secret'];
        if (typeof headerSecret === 'string' && safeEqual(headerSecret, this.sharedSecret)) return true;
        const qs = url.searchParams.get('secret');
        return safeEqual(qs || '', this.sharedSecret);
    }

    _ipAllowedForControl(ip) {
        return this._ipAllowed(ip) || this.extraAllowed.includes(ip);
    }

    /**
     * Control endpoint for Loxone (Virtual Output) → camera control states.
     *   GET|POST <prefix>/cmd/<state.path>/<value>[?secret=...&val=...]
     * <state.path> is the ioBroker id under the instance and MUST contain
     * ".control." (re-checked in the adapter). Fire-and-forget: returns 200 and
     * dispatches asynchronously, mirroring the push path.
     */
    _handleControl(req, res, url, sourceIp) {
        if (req.method !== 'GET' && req.method !== 'POST') {
            res.writeHead(405).end();
            return;
        }
        if (!this._ipAllowedForControl(sourceIp)) {
            this.log.warn(`[WebhookServer] control rejected from ${sanitize(sourceIp)} — not allowed`);
            res.writeHead(403).end();
            return;
        }
        if (!this._secretOk(req, url)) {
            this.log.warn(`[WebhookServer] control rejected from ${sanitize(sourceIp)} — bad/missing shared secret`);
            res.writeHead(401).end();
            return;
        }
        // Split BEFORE decoding so an encoded value (e.g. %2F in OSD text) survives.
        const raw = url.pathname.slice(`${this.pathPrefix}/cmd/`.length);
        const slash = raw.lastIndexOf('/');
        if (slash < 1) {
            res.writeHead(400).end('expected /cmd/<state.path>/<value>');
            return;
        }
        const statePath = decodeURIComponent(raw.slice(0, slash));
        let value = decodeURIComponent(raw.slice(slash + 1));
        const qVal = url.searchParams.get('val') ?? url.searchParams.get('value');
        if (qVal !== null) value = qVal;
        if (!statePath.includes('.control.')) {
            res.writeHead(403).end('only .control. states are writable');
            return;
        }
        res.writeHead(200).end('OK');
        Promise.resolve()
            .then(() => this.onControl && this.onControl(statePath, value, sourceIp))
            .catch((e) => this.log.debug(`[WebhookServer] onControl failed: ${sanitize(e.message)}`));
    }

    _handle(req, res) {
        const sourceIp = this._sourceIp(req);
        const url = new URL(req.url || '/', `http://localhost:${this.port}`);

        // Control endpoint (Loxone → cameras). Checked before the POST-only guard
        // so Loxone Virtual Outputs (which issue GET) are accepted.
        if (this.controlEnabled && this.onControl && url.pathname.startsWith(`${this.pathPrefix}/cmd/`)) {
            return this._handleControl(req, res, url, sourceIp);
        }

        if (req.method !== 'POST') {
            res.writeHead(405).end();
            return;
        }

        if (!url.pathname.startsWith(`${this.pathPrefix}/`)) {
            res.writeHead(404).end();
            return;
        }

        if (!this._ipAllowed(sourceIp)) {
            this.log.warn(`[WebhookServer] rejected POST from ${sanitize(sourceIp)} — not in allowlist`);
            res.writeHead(403).end();
            return;
        }

        if (!this._secretOk(req, url)) {
            this.log.warn(`[WebhookServer] rejected POST from ${sanitize(sourceIp)} — bad/missing shared secret`);
            res.writeHead(401).end();
            return;
        }

        const camId = decodeURIComponent(url.pathname.slice(this.pathPrefix.length + 1).split('/')[0] || '');
        if (!camId) {
            res.writeHead(400).end();
            return;
        }

        // Body buffer with cap.
        const chunks = [];
        let total = 0;
        let killed = false;

        req.on('data', (chunk) => {
            if (killed) return;
            total += chunk.length;
            if (total > MAX_BODY_BYTES) {
                killed = true;
                this.log.warn(`[WebhookServer] body cap exceeded from ${sanitize(sourceIp)} — destroying`);
                res.writeHead(413).end();
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });

        req.on('end', () => {
            if (killed) return;
            res.writeHead(200).end('OK');
            const body = Buffer.concat(chunks);
            let payload = null;
            if (body.length > 0) {
                try { payload = JSON.parse(body.toString('utf8')); } catch (_) { /* leave null */ }
            }
            const events = parseReolinkPushPayload(payload);
            Promise.resolve()
                .then(() => this.onEvent && this.onEvent(camId, sourceIp, events, body))
                .catch((e) => this.log.debug(`[WebhookServer] onEvent failed: ${sanitize(e.message)}`));
        });

        req.on('error', (e) => {
            this.log.debug(`[WebhookServer] request error: ${sanitize(e.message)}`);
        });
    }
}

module.exports = { WebhookServer, parseReolinkPushPayload, MAX_BODY_BYTES };
