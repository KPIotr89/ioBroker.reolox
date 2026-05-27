'use strict';

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CapabilityCache = require('../../lib/capability-cache');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

describe('CapabilityCache', () => {
    let dir;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reolox-cache-'));
    });
    afterEach(() => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* noop */ }
    });

    it('returns null when missing', () => {
        const c = new CapabilityCache({ dir, log: silentLog });
        expect(c.get('1.2.3.4', 80, 'admin')).to.equal(null);
    });

    it('round-trips data', () => {
        const c = new CapabilityCache({ dir, log: silentLog });
        c.set('1.2.3.4', 80, 'admin', { whiteLed: true });
        expect(c.get('1.2.3.4', 80, 'admin')).to.deep.equal({ whiteLed: true });
    });

    it('separates entries per host/user', () => {
        const c = new CapabilityCache({ dir, log: silentLog });
        c.set('1.2.3.4', 80, 'a', { x: 1 });
        c.set('1.2.3.4', 80, 'b', { x: 2 });
        expect(c.get('1.2.3.4', 80, 'a')).to.deep.equal({ x: 1 });
        expect(c.get('1.2.3.4', 80, 'b')).to.deep.equal({ x: 2 });
    });

    it('expires entries past TTL', () => {
        const c = new CapabilityCache({ dir, ttlMs: 1, log: silentLog });
        c.set('1.2.3.4', 80, 'a', { x: 1 });
        return new Promise((r) => setTimeout(r, 20)).then(() => {
            expect(c.get('1.2.3.4', 80, 'a')).to.equal(null);
        });
    });

    it('invalidate removes the entry', () => {
        const c = new CapabilityCache({ dir, log: silentLog });
        c.set('1.2.3.4', 80, 'a', { x: 1 });
        c.invalidate('1.2.3.4', 80, 'a');
        expect(c.get('1.2.3.4', 80, 'a')).to.equal(null);
    });
});
