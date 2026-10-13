"use strict";

// Small per-instance cache for public, read-only lobby projections. It is
// primarily a single-flight barrier: a burst of identical reads performs one
// Azure Table query instead of fanning out one query per HTTP request.
class PublicReadCache {
    constructor({ ttlMs = 2000, maxEntries = 64, clock = Date.now } = {}) {
        if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 30_000) {
            throw new Error("ttlMs must be an integer from 1 to 30000");
        }
        if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 1024) {
            throw new Error("maxEntries must be an integer from 1 to 1024");
        }
        this.ttlMs = ttlMs;
        this.maxEntries = maxEntries;
        this.clock = clock;
        this.entries = new Map();
    }

    get(key, load) {
        const now = this.clock();
        const current = this.entries.get(key);
        if (current !== undefined) {
            if (current.pending !== null) return current.pending;
            if (current.expires > now) {
                this.entries.delete(key);
                this.entries.set(key, current);
                return Promise.resolve(current.value);
            }
            this.entries.delete(key);
        }

        while (this.entries.size >= this.maxEntries) {
            this.entries.delete(this.entries.keys().next().value);
        }
        const entry = { pending: null, value: undefined, expires: 0 };
        const pending = Promise.resolve().then(load).then((value) => {
            entry.pending = null;
            entry.value = value;
            entry.expires = this.clock() + this.ttlMs;
            return value;
        }, (error) => {
            if (this.entries.get(key) === entry) this.entries.delete(key);
            throw error;
        });
        entry.pending = pending;
        this.entries.set(key, entry);
        return pending;
    }
}

module.exports = { PublicReadCache };
