'use strict';

const { expect } = require('chai');
const nock = require('nock');
const ReolinkAPI = require('../../lib/reolink-api');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

describe('ReolinkAPI', () => {
    afterEach(() => { nock.cleanAll(); });

    it('login parses token and lease', async () => {
        nock('http://1.2.3.4:80')
            .post('/cgi-bin/api.cgi?cmd=Login')
            .reply(200, [{ code: 0, value: { Token: { name: 'TOK', leaseTime: 3600 } } }]);

        const api = new ReolinkAPI({ host: '1.2.3.4', username: 'admin', password: 'pw', log: silentLog });
        const t = await api.login();
        expect(t).to.equal('TOK');
        expect(api.isAuthenticated()).to.equal(true);
    });

    it('singleflight login — concurrent ensureAuth shares one request', async () => {
        let calls = 0;
        nock('http://1.2.3.4:80')
            .persist()
            .post('/cgi-bin/api.cgi?cmd=Login')
            .reply(() => {
                calls++;
                return [200, [{ code: 0, value: { Token: { name: 'TOK', leaseTime: 3600 } } }]];
            });
        const api = new ReolinkAPI({ host: '1.2.3.4', username: 'admin', password: 'pw', log: silentLog });
        await Promise.all([api.login(), api.login(), api.login(), api.login()]);
        expect(calls).to.equal(1);
    });

    it('retries network errors with exponential backoff', async () => {
        let attempts = 0;
        nock('http://1.2.3.4:80')
            .post('/cgi-bin/api.cgi?cmd=Login')
            .times(3)
            .reply(() => {
                attempts++;
                if (attempts < 3) return [500, 'bad'];
                return [200, [{ code: 0, value: { Token: { name: 'TOK', leaseTime: 3600 } } }]];
            });
        const api = new ReolinkAPI({ host: '1.2.3.4', username: 'admin', password: 'pw', log: silentLog, backoffBaseMs: 5 });
        const t = await api.login();
        expect(t).to.equal('TOK');
        expect(attempts).to.equal(3);
    });

    it('rtspUrlPublic does not contain credentials', () => {
        const api = new ReolinkAPI({ host: '1.2.3.4', username: 'admin', password: 'secret', log: silentLog });
        const url = api.rtspUrlPublic(0, 'main');
        expect(url).to.not.match(/secret/);
        expect(url).to.not.match(/admin/);
        expect(url).to.equal('rtsp://1.2.3.4:554/h264Preview_01_main');
    });

    it('rtspUrlWithCreds does include credentials, URL-encoded', () => {
        const api = new ReolinkAPI({ host: '1.2.3.4', username: 'a@d', password: 'p w', log: silentLog });
        const url = api.rtspUrlWithCreds(0, 'main');
        expect(url).to.equal('rtsp://a%40d:p%20w@1.2.3.4:554/h264Preview_01_main');
    });

    it('rtmpUrlWithCreds interpolates channel correctly for sub stream', () => {
        const api = new ReolinkAPI({ host: '1.2.3.4', username: 'u', password: 'p', log: silentLog });
        // Regression test for v1.x literal `${ch}` bug.
        const url = api.rtmpUrlWithCreds(0, 'sub');
        expect(url).to.include('bcs/channel0_sub.bcs');
        expect(url).to.not.include('${');
    });

    it('re-login on 401 from a command', async () => {
        let loginCount = 0;
        let cmdCount = 0;
        nock('http://1.2.3.4:80')
            .persist()
            .post(/\/cgi-bin\/api\.cgi.*cmd=Login.*/)
            .reply(() => { loginCount++; return [200, [{ code: 0, value: { Token: { name: `TOK${loginCount}`, leaseTime: 3600 } } }]]; });
        nock('http://1.2.3.4:80')
            .persist()
            .post(/\/cgi-bin\/api\.cgi.*cmd=GetDevInfo.*/)
            .reply(() => {
                cmdCount++;
                if (cmdCount === 1) return [401, ''];
                return [200, [{ code: 0, value: { DevInfo: { model: 'CX810' } } }]];
            });
        const api = new ReolinkAPI({ host: '1.2.3.4', username: 'u', password: 'p', log: silentLog });
        const info = await api.getDevInfo();
        expect(info).to.have.property('DevInfo');
        expect(loginCount).to.be.at.least(2);
    });

    it('_batchCmd re-logins once when the batch returns rspCode -6', async () => {
        let loginCount = 0;
        let batchCount = 0;
        nock('http://1.2.3.4:80')
            .persist()
            .post(/\/cgi-bin\/api\.cgi\?cmd=Login/)
            .reply(() => { loginCount++; return [200, [{ code: 0, value: { Token: { name: `TOK${loginCount}`, leaseTime: 3600 } } }]]; });
        nock('http://1.2.3.4:80')
            .persist()
            .post(/\/cgi-bin\/api\.cgi\?cmd=GetMdState/)
            .reply(() => {
                batchCount++;
                // First batch: token invalidated server-side → per-entry -6 (no exception).
                if (batchCount === 1) {
                    return [200, [
                        { cmd: 'GetMdState', code: -6, error: { rspCode: -6 } },
                        { cmd: 'GetAiState', code: -6, error: { rspCode: -6 } },
                    ]];
                }
                return [200, [
                    { cmd: 'GetMdState', code: 0, value: { state: 0 } },
                    { cmd: 'GetAiState', code: 0, value: { AiState: { people: { support: 1, alarm_state: 0 } } } },
                ]];
            });
        const api = new ReolinkAPI({ host: '1.2.3.4', username: 'u', password: 'p', log: silentLog });
        const data = await api._batchCmd([
            { cmd: 'GetMdState', param: { channel: 0 } },
            { cmd: 'GetAiState', param: { channel: 0 } },
        ]);
        expect(loginCount).to.be.at.least(2);   // initial login + one re-login
        expect(batchCount).to.equal(2);         // first batch failed, retried once
        expect(Array.isArray(data)).to.equal(true);
        expect(data[0]).to.have.property('code', 0);
    });

    it('triggerSiren sends alarm_mode "times" with seconds (flat param)', async () => {
        let body;
        nock('http://1.2.3.4:80')
            .post(/\/api\.cgi\?cmd=AudioAlarmPlay/)
            .reply((uri, reqBody) => { body = reqBody; return [200, [{ cmd: 'AudioAlarmPlay', code: 0, value: { rspCode: 200 } }]]; });
        const api = new ReolinkAPI({ host: '1.2.3.4', username: 'u', password: 'p', log: silentLog });
        await api.triggerSiren(0, 7);
        expect(body[0].param.alarm_mode).to.equal('times');
        expect(body[0].param.times).to.equal(7);
        expect(body[0].param.manual_switch).to.equal(0);
        expect(body[0].param).to.not.have.property('AudioAlarmPlay'); // flat, not wrapped
    });

    it('setSirenManual sends both spellings (manul + manu), manual_switch, no times', async () => {
        let bodies = [];
        nock('http://1.2.3.4:80')
            .persist()
            .post(/\/api\.cgi\?cmd=AudioAlarmPlay/)
            .reply((uri, reqBody) => { bodies.push(reqBody[0].param); return [200, [{ cmd: 'AudioAlarmPlay', code: 0, value: { rspCode: 200 } }]]; });
        const api = new ReolinkAPI({ host: '1.2.3.4', username: 'u', password: 'p', log: silentLog });
        await api.setSirenManual(0, true);
        const modes = bodies.map((p) => p.alarm_mode);
        expect(modes).to.include('manul');
        expect(modes).to.include('manu');
        expect(bodies.every((p) => p.manual_switch === 1)).to.equal(true);
        expect(bodies.every((p) => !Object.prototype.hasOwnProperty.call(p, 'times'))).to.equal(true);
        bodies = [];
        await api.setSirenManual(0, false);
        expect(bodies.every((p) => p.manual_switch === 0)).to.equal(true);
    });
});
