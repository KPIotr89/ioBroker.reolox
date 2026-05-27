'use strict';

const { expect } = require('chai');
const { parseReolinkPushPayload } = require('../../lib/webhook-server');

describe('parseReolinkPushPayload', () => {
    it('handles NotifyAlarmEvent in value', () => {
        const r = parseReolinkPushPayload([
            { cmd: 'NotifyAlarmEvent', code: 0, value: { AlarmEvent: { channel: 0, type: 'visitor', alarm_state: 1 } } },
        ]);
        expect(r.list).to.deep.equal([{ type: 'visitor', active: true }]);
    });

    it('handles NotifyAlarmEvent in param', () => {
        const r = parseReolinkPushPayload([
            { cmd: 'NotifyAlarmEvent', param: { AlarmEvent: { type: 'md', alarm_state: 1 } } },
        ]);
        expect(r.list).to.deep.equal([{ type: 'md', active: true }]);
    });

    it('handles flat format', () => {
        const r = parseReolinkPushPayload({ event: 'visitor', state: 1 });
        expect(r.list).to.deep.equal([{ type: 'visitor', active: true }]);
    });

    it('returns empty list for null / empty', () => {
        expect(parseReolinkPushPayload(null).list).to.deep.equal([]);
        expect(parseReolinkPushPayload({}).list).to.deep.equal([]);
        expect(parseReolinkPushPayload([]).list).to.deep.equal([]);
    });

    it('lowercases types', () => {
        const r = parseReolinkPushPayload({ type: 'Visitor', state: 1 });
        expect(r.list[0].type).to.equal('visitor');
    });

    it('strips CRLF from type to prevent log injection', () => {
        const r = parseReolinkPushPayload({ type: 'visitor\r\nINJECTED', state: 1 });
        expect(r.list[0].type).to.equal('visitor__injected');
    });

    it('handles multiple commands in one array', () => {
        const r = parseReolinkPushPayload([
            { cmd: 'NotifyAlarmEvent', value: { AlarmEvent: { type: 'md', alarm_state: 1 } } },
            { cmd: 'NotifyAlarmEvent', value: { AlarmEvent: { type: 'people', alarm_state: 0 } } },
        ]);
        expect(r.list).to.deep.equal([
            { type: 'md', active: true },
            { type: 'people', active: false },
        ]);
    });

    it('treats alarm_state=true as active', () => {
        const r = parseReolinkPushPayload([{ value: { AlarmEvent: { type: 'md', alarm_state: true } } }]);
        expect(r.list[0].active).to.equal(true);
    });

    it('preserves camera name when present', () => {
        const r = parseReolinkPushPayload([{ value: { AlarmEvent: { type: 'md', alarm_state: 1, name: 'Front' } } }]);
        expect(r.cameraName).to.equal('Front');
    });
});
