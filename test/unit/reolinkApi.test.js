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
});
