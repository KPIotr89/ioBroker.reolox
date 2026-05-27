'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Disk-backed cache for Reolink `GetAbility` responses.
 *
 * GetAbility can return ~50 KB of JSON per camera and never changes unless the
 * firmware is upgraded — so we cache it on disk for a configurable TTL
 * (default 24 h) and avoid hitting every camera on cold start.
 *
 * Cache key = sha256(host + ":" + port + ":" + username) so different users on
 * the same camera don't share entries.
 */
class CapabilityCache {
    /**
     * @param {object} opts
     * @param {string} opts.dir        Directory for cache files
     * @param {number} [opts.ttlMs]    Time-to-live in ms (default 24h)
     * @param {object} [opts.log]
     */
    constructor(opts) {
        this.dir = opts.dir;
        this.ttlMs = opts.ttlMs || 24 * 60 * 60 * 1000;
        this.log = opts.log || console;
        try {
            fs.mkdirSync(this.dir, { recursive: true });
        } catch (e) {
            this.log.warn(`[CapabilityCache] mkdir failed: ${e.message}`);
        }
    }

    _key(host, port, user) {
        return crypto.createHash('sha256').update(`${host}:${port}:${user || ''}`).digest('hex').slice(0, 16);
    }

    _path(key) {
        return path.join(this.dir, `cap-${key}.json`);
    }

    /**
     * Retrieve cached ability for a camera or null if missing / expired.
     * @returns {object|null}
     */
    get(host, port, user) {
        try {
            const p = this._path(this._key(host, port, user));
            if (!fs.existsSync(p)) return null;
            const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (!raw || typeof raw !== 'object') return null;
            if (Date.now() - (raw.ts || 0) > this.ttlMs) return null;
            return raw.data || null;
        } catch (e) {
            this.log.debug(`[CapabilityCache] read failed: ${e.message}`);
            return null;
        }
    }

    /**
     * Store ability for a camera.
     */
    set(host, port, user, data) {
        try {
            const p = this._path(this._key(host, port, user));
            fs.writeFileSync(p, JSON.stringify({ ts: Date.now(), data }));
        } catch (e) {
            this.log.debug(`[CapabilityCache] write failed: ${e.message}`);
        }
    }

    /**
     * Drop the cached entry for a camera (e.g. after firmware upgrade).
     */
    invalidate(host, port, user) {
        try {
            const p = this._path(this._key(host, port, user));
            if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch (e) {
            this.log.debug(`[CapabilityCache] invalidate failed: ${e.message}`);
        }
    }
}

module.exports = CapabilityCache;
