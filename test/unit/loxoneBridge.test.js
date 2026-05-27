'use strict';

const { expect } = require('chai');
const LoxoneBridge = require('../../lib/loxone-bridge');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

describe('LoxoneBridge.inputName', () => {
    const b = new LoxoneBridge({
        host: '192.168.1.10', username: 'u', password: 'p', log: silentLog, mode: 'udp',
    });

    it('uses ReoLox prefix by default', () => {
        expect(b.inputName('Front', 'Motion')).to.equal('ReoLox_Front_Motion');
    });

    it('sanitises camera names', () => {
        expect(b.inputName('Front Door!', 'Motion')).to.equal('ReoLox_Front_Door__Motion');
    });

    it('sanitises event suffixes', () => {
        expect(b.inputName('Front', 'AI/person')).to.equal('ReoLox_Front_AI_person');
    });

    it('respects custom prefix', () => {
        const b2 = new LoxoneBridge({
            host: '192.168.1.10', username: 'u', password: 'p',
            prefix: 'MyCam', log: silentLog, mode: 'udp',
        });
        expect(b2.inputName('Front', 'Motion')).to.equal('MyCam_Front_Motion');
    });

    it('strips disallowed prefix characters', () => {
        const b2 = new LoxoneBridge({
            host: '192.168.1.10', username: 'u', password: 'p',
            prefix: 'Reo Lox!', log: silentLog, mode: 'udp',
        });
        expect(b2.inputName('Front', 'Motion')).to.equal('ReoLox_Front_Motion');
    });
});

describe('LoxoneBridge disabled', () => {
    it('does not throw when host is missing', async () => {
        const b = new LoxoneBridge({ host: '', username: 'u', password: 'p', log: silentLog });
        await b.sendMotion('Front', true);
        await b.sendEvent('X', 1);
        b.destroy();
    });
});
