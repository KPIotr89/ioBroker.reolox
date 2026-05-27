'use strict';

/**
 * PollScheduler — drives every periodic camera task.
 *
 * Replaces N separate setInterval calls with a single scheduler that:
 *
 *  - adds startup jitter so N cameras don't all log in at the same instant,
 *  - runs each task through a per-task mutex (no overlapping cycles),
 *  - applies exponential backoff on failures (with cap and reset on success),
 *  - is fully cancellable via dispose().
 *
 * Tasks are identified by string keys so callers can stop/replace one task
 * without touching the others.
 */
class PollScheduler {
    /**
     * @param {object} opts
     * @param {import('./timer-manager')} opts.timerManager
     * @param {object} [opts.log]
     */
    constructor(opts) {
        this.tm = opts.timerManager;
        this.log = opts.log || console;
        /** @type {Map<string, {timer:any,running:boolean,attempt:number,baseMs:number,maxBackoffMs:number,fn:Function}>} */
        this.tasks = new Map();
    }

    /**
     * Register and start a recurring task.
     * @param {object} t
     * @param {string} t.key            Unique task identifier
     * @param {number} t.intervalMs     Nominal interval between runs
     * @param {Function} t.run          async function performing one cycle
     * @param {number} [t.maxBackoffMs] Backoff cap (default 5 minutes)
     * @param {number} [t.initialDelayMs] First-run delay (default random 0…intervalMs/2)
     */
    add(t) {
        if (this.tasks.has(t.key)) {
            this.remove(t.key);
        }
        const entry = {
            running: false,
            attempt: 0,
            baseMs: t.intervalMs,
            maxBackoffMs: t.maxBackoffMs || 5 * 60 * 1000,
            fn: t.run,
            timer: null,
        };
        const initial = t.initialDelayMs !== undefined
            ? t.initialDelayMs
            : Math.floor(Math.random() * Math.max(50, Math.min(t.intervalMs / 2, 2000)));

        const tick = async () => {
            if (entry.running) {
                this._schedule(entry, tick);
                return;
            }
            entry.running = true;
            let removed = false;
            try {
                await entry.fn();
                entry.attempt = 0;
            } catch (e) {
                entry.attempt += 1;
                this.log.debug(`[PollScheduler] "${t.key}" attempt ${entry.attempt} failed: ${e.message}`);
            } finally {
                entry.running = false;
                removed = !this.tasks.has(t.key);
            }
            if (!removed) this._schedule(entry, tick);
        };

        entry.timer = this.tm.setTimeout(tick, initial);
        this.tasks.set(t.key, entry);
    }

    _schedule(entry, tick) {
        // Exponential backoff: base * 2^(attempt-1), capped, with ±20% jitter.
        let next = entry.baseMs;
        if (entry.attempt > 0) {
            next = Math.min(entry.maxBackoffMs, entry.baseMs * Math.pow(2, entry.attempt - 1));
        }
        const jitter = next * 0.2 * (Math.random() * 2 - 1);
        entry.timer = this.tm.setTimeout(tick, Math.max(50, Math.floor(next + jitter)));
    }

    /** Stop and forget a task. */
    remove(key) {
        const e = this.tasks.get(key);
        if (!e) return;
        if (e.timer) this.tm.clearTimeout(e.timer);
        this.tasks.delete(key);
    }

    /** Stop everything. The tm.dispose() in the adapter does the same, but this
     * exists for tests and for swapping schedulers without unloading. */
    dispose() {
        for (const key of Array.from(this.tasks.keys())) this.remove(key);
    }

    has(key) { return this.tasks.has(key); }
    size() { return this.tasks.size; }
}

module.exports = PollScheduler;
