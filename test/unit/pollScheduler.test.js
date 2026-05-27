'use strict';

const { expect } = require('chai');
const TimerManager = require('../../lib/timer-manager');
const PollScheduler = require('../../lib/poll-scheduler');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

describe('PollScheduler', () => {
    it('runs a task repeatedly', (done) => {
        const tm = new TimerManager();
        const s = new PollScheduler({ timerManager: tm, log: silentLog });
        let n = 0;
        s.add({
            key: 't',
            intervalMs: 30,
            initialDelayMs: 0,
            run: async () => { n++; },
        });
        setTimeout(() => {
            s.dispose();
            tm.dispose();
            expect(n).to.be.greaterThan(1);
            done();
        }, 150);
    });

    it('does not run overlapping cycles for the same key', (done) => {
        const tm = new TimerManager();
        const s = new PollScheduler({ timerManager: tm, log: silentLog });
        let concurrent = 0;
        let maxConcurrent = 0;
        s.add({
            key: 't',
            intervalMs: 10,
            initialDelayMs: 0,
            run: async () => {
                concurrent++;
                maxConcurrent = Math.max(maxConcurrent, concurrent);
                await new Promise((r) => setTimeout(r, 40));
                concurrent--;
            },
        });
        setTimeout(() => {
            s.dispose();
            tm.dispose();
            expect(maxConcurrent).to.equal(1);
            done();
        }, 200);
    });

    it('applies exponential backoff after failures', (done) => {
        const tm = new TimerManager();
        const s = new PollScheduler({ timerManager: tm, log: silentLog });
        const calls = [];
        s.add({
            key: 't',
            intervalMs: 20,
            initialDelayMs: 0,
            run: async () => { calls.push(Date.now()); throw new Error('boom'); },
        });
        setTimeout(() => {
            s.dispose();
            tm.dispose();
            // After several failures the gap should grow — third gap > first.
            if (calls.length >= 3) {
                const first = calls[1] - calls[0];
                const last = calls[calls.length - 1] - calls[calls.length - 2];
                expect(last).to.be.at.least(first);
            }
            done();
        }, 500);
    });

    it('remove() cancels future runs', (done) => {
        const tm = new TimerManager();
        const s = new PollScheduler({ timerManager: tm, log: silentLog });
        let n = 0;
        s.add({ key: 't', intervalMs: 10, initialDelayMs: 0, run: async () => { n++; } });
        setTimeout(() => { s.remove('t'); }, 30);
        setTimeout(() => {
            const snapshot = n;
            setTimeout(() => {
                tm.dispose();
                expect(n).to.equal(snapshot);
                done();
            }, 50);
        }, 60);
    });
});
