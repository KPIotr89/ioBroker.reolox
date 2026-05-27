'use strict';

const http = require('http');
const dgram = require('dgram');
const crypto = require('crypto');
const { sanitize, mask } = require('./safe-log');

/**
 * LoxoneBridge
 * ============
 *
 * Forwards camera events to a Loxone Miniserver.
 *
 * Communication modes (configurable):
 *
 *  - http  : HTTP GET to /dev/sps/io/<vi>/<value>
 *  - udp   : UDP packet "<vi>=<value>" on the configured port
 *  - both  : send via both
 *
 * Authentication modes for HTTP (configurable):
 *
 *  - token : Loxone Token Auth (HMAC-SHA1 of the password against the
 *            challenge salt returned by jdev/sys/getkey2). Tokens cached and
 *            refreshed proactively at 80 % of their lifetime. This is the
 *            recommended mode for Gen 2 / current firmware.
 *  - basic : HTTP Basic. Falls back to this if Token Auth fails or if
 *            explicitly selected (Gen 1 only).
 *
 * Virtual Input naming
 * --------------------
 * Every event is sent to a VI named "<prefix>_<camera>_<event>" where the
 * prefix defaults to "ReoLox" and is configurable. Both <camera> and <event>
 * are sanitised — only `[a-zA-Z0-9_-]` are kept, everything else becomes "_".
 */
class LoxoneBridge {
    /**
     * @param {object} config
     * @param {string} config.host
     * @param {number} [config.port=80]
     * @param {string} config.username
     * @param {string} config.password
     * @param {number} [config.udpPort=7000]
     * @param {'http'|'udp'|'both'} [config.mode='http']
     * @param {'token'|'basic'} [config.auth='token']
     * @param {string} [config.prefix='ReoLox']
     * @param {import('./timer-manager')} [config.timerManager]
     * @param {object} [config.log]
     */
    constructor(config) {
        this.host = config.host;
        this.port = config.port || 80;
        this.username = config.username;
        this.password = config.password;
        this.udpPort = config.udpPort || 7000;
        this.mode = config.mode || 'http';
        this.auth = config.auth || 'token';
        this.prefix = (config.prefix || 'ReoLox').replace(/[^a-zA-Z0-9_-]/g, '');
        this.log = config.log || console;
        this.tm = config.timerManager || null;
        this.enabled = !!(config.host && String(config.host).trim());

        if (this.enabled && (this.mode === 'udp' || this.mode === 'both')) {
            this.udpClient = dgram.createSocket('udp4');
            this.udpClient.on('error', (e) => this.log.warn(`[LoxoneBridge] UDP socket error: ${sanitize(e.message)}`));
        }

        /** @type {Promise<string>|null} singleflight for token */
        this._tokenPromise = null;
        /** @type {{token:string, key:string, validUntil:number}|null} */
        this._token = null;
        /** @type {boolean} disables future token attempts after a hard failure */
        this._tokenDisabled = false;
    }

    // ─── Public event helpers ──────────────────────────────────────────────

    /**
     * Build the canonical VI name. Public so the adapter can show the user
     * what to put in Loxone Config.
     */
    inputName(cameraName, suffix) {
        const safeCam = String(cameraName || '').replace(/[^a-zA-Z0-9_-]/g, '_');
        const safeSuf = String(suffix || '').replace(/[^a-zA-Z0-9_-]/g, '_');
        return `${this.prefix}_${safeCam}_${safeSuf}`;
    }

    async sendMotion(cameraName, motion) {
        await this.sendEvent(this.inputName(cameraName, 'Motion'), motion ? 1 : 0);
    }

    async sendAi(cameraName, aiType, detected) {
        await this.sendEvent(this.inputName(cameraName, `AI_${aiType}`), detected ? 1 : 0);
    }

    async sendStatus(cameraName, online) {
        await this.sendEvent(this.inputName(cameraName, 'Online'), online ? 1 : 0);
    }

    async sendCustom(cameraName, eventName, value) {
        await this.sendEvent(this.inputName(cameraName, eventName), value);
    }

    /**
     * Dispatch using the configured mode. Errors are logged but never thrown
     * — Loxone outages must not bring the adapter down.
     */
    async sendEvent(inputName, value) {
        if (!this.enabled) return;
        const promises = [];
        if (this.mode === 'http' || this.mode === 'both') {
            promises.push(this._sendHttp(inputName, value).catch((e) => {
                this.log.warn(`[LoxoneBridge] HTTP ${inputName}=${value} failed: ${sanitize(e.message)}`);
            }));
        }
        if (this.mode === 'udp' || this.mode === 'both') {
            promises.push(this._sendUdp(inputName, value).catch((e) => {
                this.log.warn(`[LoxoneBridge] UDP ${inputName}=${value} failed: ${sanitize(e.message)}`);
            }));
        }
        await Promise.allSettled(promises);
    }

    // ─── HTTP transport ────────────────────────────────────────────────────

    async _sendHttp(inputName, value) {
        if (this.auth === 'token' && !this._tokenDisabled) {
            try {
                await this._fetchTokenIfNeeded();
                await this._httpGetWithToken(`/dev/sps/io/${encodeURIComponent(inputName)}/${encodeURIComponent(String(value))}`);
                return;
            } catch (e) {
                // Hard failure (e.g. unsupported firmware) → fall back to Basic and remember.
                this.log.warn(`[LoxoneBridge] Token auth failed (${sanitize(e.message)}), falling back to Basic`);
                this._tokenDisabled = true;
            }
        }
        await this._httpGetBasic(`/dev/sps/io/${encodeURIComponent(inputName)}/${encodeURIComponent(String(value))}`);
    }

    _httpRequest(path, headers = {}) {
        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname: this.host,
                port: this.port,
                path,
                method: 'GET',
                headers,
                timeout: 5000,
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => (data += chunk));
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(data);
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}`));
                    }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            req.end();
        });
    }

    async _httpGetBasic(path) {
        const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
        await this._httpRequest(path, { Authorization: `Basic ${auth}` });
    }

    async _httpGetWithToken(path) {
        if (!this._token || !this._token.token) throw new Error('no token');
        const sep = path.includes('?') ? '&' : '?';
        await this._httpRequest(`${path}${sep}autht=${encodeURIComponent(this._token.token)}&user=${encodeURIComponent(this.username)}`);
    }

    async _fetchTokenIfNeeded() {
        const t = this._token;
        if (t && Date.now() < t.validUntil) return;
        if (this._tokenPromise) return this._tokenPromise;
        this._tokenPromise = this._acquireToken()
            .finally(() => { this._tokenPromise = null; });
        await this._tokenPromise;
    }

    /**
     * Acquire a Loxone token via getkey2 + HMAC-SHA1.
     * Reference: Loxone Communicating with the Miniserver v12, ch. 3.4
     * — supports Token Auth introduced in Miniserver v10.2.
     */
    async _acquireToken() {
        const raw = await this._httpRequest(`/jdev/sys/getkey2/${encodeURIComponent(this.username)}`);
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { throw new Error('getkey2: invalid JSON'); }
        const valueObj = parsed.LL && parsed.LL.value;
        if (!valueObj || !valueObj.key || !valueObj.salt) throw new Error('getkey2: missing key/salt');
        const { key, salt, hashAlg } = valueObj;
        const algo = (hashAlg || 'SHA1').toLowerCase();
        const pwHash = crypto.createHash(algo).update(`${this.password}:${salt}`).digest('hex').toUpperCase();
        const hmac = crypto.createHmac(algo, Buffer.from(key, 'hex')).update(`${this.username}:${pwHash}`).digest('hex');

        const tokenRaw = await this._httpRequest(
            `/jdev/sys/getjwt/${hmac}/${encodeURIComponent(this.username)}/4/${encodeURIComponent('iobroker-reolox')}/iobroker`,
        );
        let tokParsed;
        try { tokParsed = JSON.parse(tokenRaw); } catch (_) { throw new Error('getjwt: invalid JSON'); }
        const tk = tokParsed.LL && tokParsed.LL.value;
        if (!tk || !tk.token) throw new Error('getjwt: no token');
        const validity = (tk.validUntil && tk.validUntil * 1000) || (Date.now() + 60 * 60 * 1000);
        // Refresh at 80 % of lifetime
        const validUntil = Date.now() + Math.max(60_000, (validity - Date.now()) * 0.8);

        this._token = { token: tk.token, key: tk.key || '', validUntil };
        this.log.debug(`[LoxoneBridge] Token acquired (user=${sanitize(this.username)}, pw=${mask(this.password)}, expires≈${new Date(validUntil).toISOString()})`);
    }

    // ─── UDP transport ─────────────────────────────────────────────────────

    _sendUdp(inputName, value) {
        return new Promise((resolve, reject) => {
            if (!this.udpClient) return reject(new Error('udp disabled'));
            const message = Buffer.from(`${inputName}=${value}`);
            this.udpClient.send(message, this.udpPort, this.host, (err) => {
                if (err) reject(err); else resolve();
            });
        });
    }

    destroy() {
        if (this.udpClient) {
            try { this.udpClient.close(); } catch (_) { /* swallow */ }
            this.udpClient = null;
        }
        this._token = null;
    }
}

module.exports = LoxoneBridge;
