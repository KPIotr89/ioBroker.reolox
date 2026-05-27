'use strict';

const { expect } = require('chai');
const { sanitize, mask, maskUrl } = require('../../lib/safe-log');

describe('safe-log helpers', () => {
    describe('sanitize', () => {
        it('strips CR/LF/control characters', () => {
            expect(sanitize('hello\r\nworld')).to.equal('hello__world_');
        });
        it('handles null/undefined gracefully', () => {
            expect(sanitize(null)).to.equal('');
            expect(sanitize(undefined)).to.equal('');
        });
        it('coerces numbers to strings', () => {
            expect(sanitize(42)).to.equal('42');
        });
    });

    describe('mask', () => {
        it('returns **** for short secrets', () => {
            expect(mask('ab')).to.equal('****');
            expect(mask('abcd')).to.equal('****');
        });
        it('keeps first and last two chars for longer secrets', () => {
            expect(mask('secret123')).to.equal('se***23');
        });
        it('returns empty for falsy input', () => {
            expect(mask('')).to.equal('');
            expect(mask(null)).to.equal('');
        });
    });

    describe('maskUrl', () => {
        it('masks user:password@host', () => {
            expect(maskUrl('rtsp://admin:pw@1.2.3.4/stream')).to.equal('rtsp://admin:****@1.2.3.4/stream');
        });
        it('masks ?password= query', () => {
            expect(maskUrl('http://h/api?cmd=x&password=secret&channel=0'))
                .to.equal('http://h/api?cmd=x&password=****&channel=0');
        });
        it('masks ?user= query', () => {
            expect(maskUrl('http://h/api?user=admin&cmd=x')).to.equal('http://h/api?user=****&cmd=x');
        });
        it('masks token in query', () => {
            expect(maskUrl('/cgi-bin/api.cgi?cmd=GetMdState&token=ABCDEF')).to.match(/token=\*+/);
        });
    });
});
