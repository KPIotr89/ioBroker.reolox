'use strict';

const { expect } = require('chai');
const http = require('http');
const { WebhookServer } = require('../../lib/webhook-server');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

/** Helper: POST to localhost and resolve { status, body }. */
function post(port, path, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port, path, method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}

/** Helper: GET to localhost and resolve { status, body }. */
function get(port, path, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end();
    });
}

function listen(opts) {
    const srv = new WebhookServer({
        port: 0, // ask OS for a free port via direct start
        log: silentLog,
        ...opts,
    });
    return srv;
}

function startOnFreePort(opts) {
    return new Promise((resolve, reject) => {
        const probe = http.createServer();
        probe.listen(0, '127.0.0.1', () => {
            const port = probe.address().port;
            probe.close(() => {
                const srv = listen({ ...opts, port });
                srv.start().then(() => resolve({ srv, port })).catch(reject);
            });
        });
    });
}

describe('WebhookServer', () => {
    it('rejects non-POST with 405', async () => {
        const events = [];
        const { srv, port } = await startOnFreePort({
            ipAllowlist: ['127.0.0.1'],
            onEvent: (cam, ip, evt) => events.push({ cam, ip, evt }),
        });
        await new Promise((r) => {
            http.get(`http://127.0.0.1:${port}/reolox/cam1`, (res) => { expect(res.statusCode).to.equal(405); r(); });
        });
        await srv.stop();
    });

    it('rejects 403 when source IP not in allowlist', async () => {
        const { srv, port } = await startOnFreePort({
            ipAllowlist: ['10.0.0.1'],
            onEvent: () => {},
        });
        const res = await post(port, '/reolox/cam1', {});
        expect(res.status).to.equal(403);
        await srv.stop();
    });

    it('rejects 401 when shared secret missing', async () => {
        const { srv, port } = await startOnFreePort({
            ipAllowlist: ['127.0.0.1'],
            sharedSecret: 's3cret',
            onEvent: () => {},
        });
        const res = await post(port, '/reolox/cam1', {});
        expect(res.status).to.equal(401);
        await srv.stop();
    });

    it('accepts when secret matches query parameter', async () => {
        let captured;
        const { srv, port } = await startOnFreePort({
            ipAllowlist: ['127.0.0.1'],
            sharedSecret: 's3cret',
            onEvent: (cam, _ip, evt) => { captured = { cam, evt }; },
        });
        const res = await post(port, '/reolox/cam1?secret=s3cret', [{ value: { AlarmEvent: { type: 'visitor', alarm_state: 1 } } }]);
        expect(res.status).to.equal(200);
        // Allow async onEvent to fire.
        await new Promise((r) => setTimeout(r, 30));
        expect(captured.cam).to.equal('cam1');
        expect(captured.evt.list[0].type).to.equal('visitor');
        await srv.stop();
    });

    it('accepts when secret matches X-ReoLox-Secret header', async () => {
        let captured;
        const { srv, port } = await startOnFreePort({
            ipAllowlist: ['127.0.0.1'],
            sharedSecret: 'sec',
            onEvent: (cam, _ip, evt) => { captured = { cam, evt }; },
        });
        const res = await post(port, '/reolox/cam2', [{ value: { AlarmEvent: { type: 'md', alarm_state: 1 } } }], { 'X-ReoLox-Secret': 'sec' });
        expect(res.status).to.equal(200);
        await new Promise((r) => setTimeout(r, 30));
        expect(captured.cam).to.equal('cam2');
        await srv.stop();
    });

    it('returns 413 when body exceeds 64 KB cap', async () => {
        const { srv, port } = await startOnFreePort({
            ipAllowlist: ['127.0.0.1'],
            onEvent: () => {},
        });
        const big = 'x'.repeat(70 * 1024);
        const res = await post(port, '/reolox/cam1', big);
        expect(res.status).to.equal(413);
        await srv.stop();
    });

    it('returns 404 when path does not start with /reolox/', async () => {
        const { srv, port } = await startOnFreePort({
            ipAllowlist: ['127.0.0.1'],
            onEvent: () => {},
        });
        const res = await post(port, '/admin/restart', {});
        expect(res.status).to.equal(404);
        await srv.stop();
    });

    it('control: GET sets value via onControl with secret + allowed IP', async () => {
        let captured;
        const { srv, port } = await startOnFreePort({
            ipAllowlist: ['127.0.0.1'],
            sharedSecret: 'sec',
            onEvent: () => {},
            onControl: (statePath, value) => { captured = { statePath, value }; },
        });
        const res = await get(port, '/reolox/cmd/taras.control.whiteLed/1?secret=sec');
        expect(res.status).to.equal(200);
        await new Promise((r) => setTimeout(r, 30));
        expect(captured.statePath).to.equal('taras.control.whiteLed');
        expect(captured.value).to.equal('1');
        await srv.stop();
    });

    it('control: trusts extraAllowed (Loxone IP) outside the event allowlist', async () => {
        let captured;
        const { srv, port } = await startOnFreePort({
            ipAllowlist: ['10.0.0.1'],       // camera-only allowlist
            extraAllowed: ['127.0.0.1'],     // Loxone Miniserver
            onEvent: () => {},
            onControl: (statePath, value) => { captured = { statePath, value }; },
        });
        const res = await get(port, '/reolox/cmd/nvr.ch3.control.recording/0');
        expect(res.status).to.equal(200);
        await new Promise((r) => setTimeout(r, 30));
        expect(captured.statePath).to.equal('nvr.ch3.control.recording');
        expect(captured.value).to.equal('0');
        await srv.stop();
    });

    it('control: 401 on wrong secret (and onControl not called)', async () => {
        let called = false;
        const { srv, port } = await startOnFreePort({
            ipAllowlist: ['127.0.0.1'],
            sharedSecret: 'sec',
            onEvent: () => {},
            onControl: () => { called = true; },
        });
        const res = await get(port, '/reolox/cmd/taras.control.whiteLed/1?secret=nope');
        expect(res.status).to.equal(401);
        expect(called).to.equal(false);
        await srv.stop();
    });

    it('_ipAllowed combines auto (camera hosts) with explicit IPs', () => {
        const srv = new WebhookServer({ log: silentLog, port: 0, ipAllowlist: ['192.168.0.175'], ipAllowlistAuto: true });
        srv.setCameras({ front: { host: '192.168.0.48' } });
        expect(srv._ipAllowed('192.168.0.48')).to.equal(true);    // auto (camera host)
        expect(srv._ipAllowed('192.168.0.175')).to.equal(true);   // explicit extra
        expect(srv._ipAllowed('8.8.8.8')).to.equal(false);        // neither
    });

    it('_ipAllowed honours a bare "auto" string (back-compat)', () => {
        const srv = new WebhookServer({ log: silentLog, port: 0, ipAllowlist: 'auto' });
        srv.setCameras({ front: { host: '192.168.0.48' } });
        expect(srv._ipAllowed('192.168.0.48')).to.equal(true);
        expect(srv._ipAllowed('192.168.0.175')).to.equal(false);
    });

    it('_ipAllowedForControl always allows loopback, plus extraAllowed', () => {
        const srv = new WebhookServer({ log: silentLog, port: 0, ipAllowlist: ['10.0.0.1'], extraAllowed: ['192.168.0.2'] });
        expect(srv._ipAllowedForControl('127.0.0.1')).to.equal(true);   // loopback always
        expect(srv._ipAllowedForControl('::1')).to.equal(true);
        expect(srv._ipAllowedForControl('192.168.0.2')).to.equal(true); // extraAllowed (Loxone)
        expect(srv._ipAllowedForControl('10.0.0.1')).to.equal(true);    // event allowlist
        expect(srv._ipAllowedForControl('8.8.8.8')).to.equal(false);    // untrusted
    });

    it('control: 403 rejects non-control paths', async () => {
        let called = false;
        const { srv, port } = await startOnFreePort({
            ipAllowlist: ['127.0.0.1'],
            onEvent: () => {},
            onControl: () => { called = true; },
        });
        const res = await get(port, '/reolox/cmd/taras.info.connection/1');
        expect(res.status).to.equal(403);
        expect(called).to.equal(false);
        await srv.stop();
    });

    it('control: 400 when value segment is missing', async () => {
        const { srv, port } = await startOnFreePort({
            ipAllowlist: ['127.0.0.1'],
            onEvent: () => {},
            onControl: () => {},
        });
        const res = await get(port, '/reolox/cmd/taras.control.whiteLed');
        expect(res.status).to.equal(400);
        await srv.stop();
    });
});
