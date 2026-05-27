'use strict';

const { expect } = require('chai');
const TimerManager = require('../../lib/timer-manager');

describe('TimerManager', () => {
    it('runs scheduled timeouts and removes them from the tracker', (done) => {
        const tm = new TimerManager();
        tm.setTimeout(() => {
            expect(tm.pendingCount).to.equal(0);
            tm.dispose();
            done();
        }, 10);
        expect(tm.pendingCount).to.equal(1);
    });

    it('cancels every timer on dispose()', () => {
        const tm = new TimerManager();
        let fired = false;
        tm.setTimeout(() => { fired = true; }, 50);
        tm.setInterval(() => { fired = true; }, 50);
        tm.dispose();
        return new Promise((r) => setTimeout(r, 80)).then(() => {
            expect(fired).to.equal(false);
            expect(tm.pendingCount).to.equal(0);
        });
    });

    it('refuses to schedule after dispose()', () => {
        const tm = new TimerManager();
        tm.dispose();
        const h = tm.setTimeout(() => undefined, 10);
        expect(h).to.equal(null);
    });

    it('swallows synchronous errors in callbacks', (done) => {
        const tm = new TimerManager();
        tm.setTimeout(() => { throw new Error('boom'); }, 5);
        setTimeout(() => { tm.dispose(); done(); }, 25);
    });

    it('swallows rejections from async callbacks', (done) => {
        const tm = new TimerManager();
        tm.setTimeout(async () => { throw new Error('async boom'); }, 5);
        setTimeout(() => { tm.dispose(); done(); }, 25);
    });
});
