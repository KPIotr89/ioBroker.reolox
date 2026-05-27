'use strict';

/**
 * TimerManager — tracks every setTimeout / setInterval so they can be cleared
 * deterministically on adapter unload. Replaces ad-hoc timer arrays scattered
 * across the codebase.
 *
 * All callbacks are wrapped so the timer auto-removes itself from the tracker
 * when it fires.
 */
class TimerManager {
    constructor() {
        /** @type {Set<NodeJS.Timeout>} */
        this.timeouts = new Set();
        /** @type {Set<NodeJS.Timeout>} */
        this.intervals = new Set();
        /** @type {boolean} */
        this.disposed = false;
    }

    /**
     * Schedule a one-shot timer. Returns the underlying Timeout for callers
     * that need to clear it manually (e.g. debouncing).
     * @param {() => any|Promise<any>} fn
     * @param {number} ms
     * @returns {NodeJS.Timeout|null}
     */
    setTimeout(fn, ms) {
        if (this.disposed) return null;
        const handle = setTimeout(() => {
            this.timeouts.delete(handle);
            try {
                const r = fn();
                if (r && typeof r.catch === 'function') r.catch(() => { /* swallow */ });
            } catch (_) { /* swallow */ }
        }, ms);
        this.timeouts.add(handle);
        return handle;
    }

    /**
     * Schedule a repeating timer.
     * @param {() => any|Promise<any>} fn
     * @param {number} ms
     * @returns {NodeJS.Timeout|null}
     */
    setInterval(fn, ms) {
        if (this.disposed) return null;
        const handle = setInterval(() => {
            try {
                const r = fn();
                if (r && typeof r.catch === 'function') r.catch(() => { /* swallow */ });
            } catch (_) { /* swallow */ }
        }, ms);
        this.intervals.add(handle);
        return handle;
    }

    /** Cancel a specific timeout previously returned by setTimeout(). */
    clearTimeout(handle) {
        if (!handle) return;
        clearTimeout(handle);
        this.timeouts.delete(handle);
    }

    /** Cancel a specific interval previously returned by setInterval(). */
    clearInterval(handle) {
        if (!handle) return;
        clearInterval(handle);
        this.intervals.delete(handle);
    }

    /**
     * Cancel everything. Safe to call multiple times.
     */
    dispose() {
        this.disposed = true;
        for (const h of this.timeouts) clearTimeout(h);
        for (const h of this.intervals) clearInterval(h);
        this.timeouts.clear();
        this.intervals.clear();
    }

    get pendingCount() {
        return this.timeouts.size + this.intervals.size;
    }
}

module.exports = TimerManager;
