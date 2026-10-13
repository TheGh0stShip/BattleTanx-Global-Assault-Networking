"use strict";

const crypto = require("node:crypto");
const { validEtag } = require("./core");

// Durable token-bucket rate limiting shared by every Function instance.
//
// Each (scope, subject) pair maps to one bucket row. Subjects (canonical
// addresses, lobby IDs, "lobbyId|address") are never stored: they are keyed
// with HMAC and reduced to one of `shards` row keys per scope. The table can
// therefore never hold more than scopes x shards rows, however many
// addresses or lobby IDs an attacker uses; two subjects that collide simply
// share a bucket, which can only make a limit stricter.
//
// Buckets are read and written with ETag compare-and-swap, so concurrent
// instances cannot both spend the last token. A bucket that has been idle long
// enough to refill completely is indistinguishable from a missing row, which
// lets idle rows be purged at any time without changing any decision.

const DEFAULT_SHARDS = 4096;
const MAX_RETRY_AFTER_SECONDS = 900;
const CAS_ATTEMPTS = 4;
const STORE_TIMEOUT_MS = 1500;
const PURGE_INTERVAL_SECONDS = 3600;
const PURGE_BATCH = 200;

// capacity = burst size; perHour = sustained refill.
const DEFAULT_LIMITS = Object.freeze({
    // Seats (join or resume) successfully allocated to one address, plus its
    // lobby creations. 32 lets a four-player household play several matches
    // back to back; 8/hour (192/day) is the sustained budget. Holding all four
    // seats of a lobby with unconfirmed reservations needs 240 allocations an
    // hour, i.e. at least 30 distinct addresses (IPv4 or IPv6 /64).
    source: Object.freeze({ capacity: 32, perHour: 8 }),
    // Join and resume attempts per lobby per address, successful or not:
    // throttles polling while still letting four players behind one NAT join
    // and retry.
    lobby_source: Object.freeze({ capacity: 20, perHour: 120 }),
    // Seats successfully allocated in one lobby by everyone. Bounds seat churn
    // and write pressure on one lobby row.
    lobby: Object.freeze({ capacity: 20, perHour: 720 }),
    // Rejected credentials (host secret, resume token, join token) per address.
    auth_failure: Object.freeze({ capacity: 10, perHour: 20 }),
    // Lobby creation across the whole service.
    lobby_create: Object.freeze({ capacity: 60, perHour: 240 }),
    // Authenticated heartbeats per lobby (expected: one per 15 seconds).
    heartbeat: Object.freeze({ capacity: 8, perHour: 720 }),
    // Public read routes (list, status, dashboard) per address.
    read: Object.freeze({ capacity: 60, perHour: 3600 })
});

const SCOPES = Object.freeze(Object.keys(DEFAULT_LIMITS));

// Accepts operator overrides as {scope: {capacity, perHour}} and refuses
// anything outside sane bounds instead of silently disabling a limit.
function parseLimits(overrides) {
    const limits = {};
    for (const scope of SCOPES) limits[scope] = { ...DEFAULT_LIMITS[scope] };
    if (overrides === undefined || overrides === null || overrides === "") return limits;
    const parsed = typeof overrides === "string" ? JSON.parse(overrides) : overrides;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("rate limit overrides must be an object");
    }
    for (const [scope, value] of Object.entries(parsed)) {
        if (!SCOPES.includes(scope)) throw new Error(`unknown rate limit scope ${scope}`);
        const { capacity, perHour } = value || {};
        if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10000 ||
            typeof perHour !== "number" || !(perHour > 0) || perHour > 360000) {
            throw new Error(`rate limit ${scope} is outside the supported range`);
        }
        limits[scope] = { capacity, perHour };
    }
    return limits;
}

class MemoryRateStore {
    constructor() {
        this.rows = new Map();
        this.version = 0;
        this.failing = false;
    }

    check() {
        if (this.failing) throw new Error("rate store unavailable");
    }

    async get(partition, row) {
        this.check();
        const item = this.rows.get(`${partition}|${row}`);
        return item === undefined ? null : { ...item.state, etag: item.etag };
    }

    async create(partition, row, state) {
        this.check();
        const key = `${partition}|${row}`;
        if (this.rows.has(key)) return false;
        this.rows.set(key, { state: { ...state }, etag: String(++this.version) });
        return true;
    }

    async replace(partition, row, state, etag) {
        this.check();
        if (!validEtag(etag)) return false;
        const key = `${partition}|${row}`;
        const item = this.rows.get(key);
        if (item === undefined || item.etag !== etag) return false;
        this.rows.set(key, { state: { ...state }, etag: String(++this.version) });
        return true;
    }

    async purgeIdle(partition, olderThanMs, limit) {
        this.check();
        let removed = 0;
        for (const [key, item] of this.rows) {
            if (removed >= limit) break;
            if (key.startsWith(`${partition}|`) && item.state.updated < olderThanMs) {
                this.rows.delete(key);
                removed += 1;
            }
        }
        return removed;
    }

    get size() {
        return this.rows.size;
    }
}

function withTimeout(promise, milliseconds) {
    let timer;
    return Promise.race([
        promise,
        new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error("rate store timeout")), milliseconds);
        })
    ]).finally(() => clearTimeout(timer));
}

class RateLimiter {
    // options: store, secretKey, clock (seconds), limits, shards, log
    // (SecurityLog), fallback (RateLimiter used when the store is unavailable),
    // storeTimeoutMs.
    constructor(options) {
        const {
            store, secretKey, clock = () => Date.now() / 1000, limits = DEFAULT_LIMITS,
            shards = DEFAULT_SHARDS, log = null, fallback = null,
            storeTimeoutMs = STORE_TIMEOUT_MS
        } = options;
        if (!store) throw new Error("a rate store is required");
        if (!secretKey || Buffer.from(secretKey).length < 32) {
            throw new Error("rate limiter secretKey must contain at least 32 bytes");
        }
        if (!Number.isInteger(shards) || shards < 1 || shards > 65536) {
            throw new Error("shards must be an integer from 1 to 65536");
        }
        this.store = store;
        this.key = crypto.createHmac("sha256", Buffer.from(secretKey))
            .update("btga-rate-limit-v1").digest();
        this.clock = clock;
        this.limits = parseLimits(limits);
        this.shards = shards;
        this.log = log;
        this.fallback = fallback;
        this.storeTimeoutMs = storeTimeoutMs;
        this.lastPurge = -Infinity;
        this.lastDegradedLog = -Infinity;
    }

    rowKey(scope, subject) {
        const digest = crypto.createHmac("sha256", this.key)
            .update(`${scope}\0${subject}`).digest();
        return (digest.readUInt32BE(0) % this.shards).toString(16).padStart(4, "0");
    }

    retryAfter(limit, tokens, cost) {
        const seconds = Math.ceil(((cost - tokens) * 3600) / limit.perHour);
        return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, seconds));
    }

    // Spends `cost` tokens. Returns { allowed, retryAfter, degraded }.
    // `cost` 0 inspects a bucket without spending (used to refuse callers
    // whose credential-failure budget is already exhausted).
    async consume(scope, subject, cost = 1, context = {}) {
        const limit = this.limits[scope];
        if (limit === undefined) throw new Error(`unknown rate limit scope ${scope}`);
        const row = this.rowKey(scope, String(subject));
        try {
            return await withTimeout(this.consumeRow(scope, row, limit, cost, context),
                this.storeTimeoutMs);
        } catch {
            return this.degraded(scope, subject, cost, context);
        }
    }

    async consumeRow(scope, row, limit, cost, context) {
        for (let attempt = 0; attempt < CAS_ATTEMPTS; ++attempt) {
            const now = this.clock();
            const stored = await this.store.get(scope, row);
            const perSecond = limit.perHour / 3600;
            let tokens = limit.capacity;
            if (stored !== null && Number.isFinite(stored.tokens) &&
                Number.isFinite(stored.updated)) {
                const elapsed = Math.max(0, now - stored.updated / 1000);
                tokens = Math.min(limit.capacity, Math.max(0, stored.tokens) + elapsed * perSecond);
            }
            if (tokens < Math.max(cost, 1)) {
                return { allowed: false, retryAfter: this.retryAfter(limit, tokens, Math.max(cost, 1)) };
            }
            if (cost === 0) return { allowed: true, retryAfter: 0 };
            const state = { tokens: tokens - cost, updated: Math.round(now * 1000) };
            const written = stored === null
                ? await this.store.create(scope, row, state)
                : await this.store.replace(scope, row, state, stored.etag);
            if (written) {
                this.maybePurge(now);
                return { allowed: true, retryAfter: 0 };
            }
        }
        // Persistent contention on one bucket only happens under a burst far
        // above any legitimate rate, so it is treated as abuse (fail closed).
        if (this.log) {
            this.log.emit("rate_limit_contention", {
                scope, route: context.route, source: context.source, lobby: context.lobby,
                reason: "cas_exhausted", retry_after: 1
            });
        }
        return { allowed: false, retryAfter: 1 };
    }

    async degraded(scope, subject, cost, context) {
        const now = this.clock();
        if (this.log && now - this.lastDegradedLog >= 60) {
            this.lastDegradedLog = now;
            this.log.emit("rate_limit_store_degraded", {
                scope, route: context.route, reason: "store_error"
            });
        }
        if (this.fallback === null) {
            // No fallback configured: refuse rather than run unlimited.
            return { allowed: false, retryAfter: 5, degraded: true };
        }
        const result = await this.fallback.consume(scope, subject, cost, context);
        return { ...result, degraded: true };
    }

    // Opportunistically deletes rows idle long enough to have fully refilled.
    // Rows are already bounded by the shard count; this only reclaims space.
    maybePurge(now) {
        if (typeof this.store.purgeIdle !== "function" ||
            now - this.lastPurge < PURGE_INTERVAL_SECONDS) return;
        this.lastPurge = now;
        for (const [scope, limit] of Object.entries(this.limits)) {
            const fullAfterSeconds = (limit.capacity * 3600) / limit.perHour;
            const cutoff = Math.floor((now - fullAfterSeconds - 60) * 1000);
            Promise.resolve()
                .then(() => this.store.purgeIdle(scope, cutoff, PURGE_BATCH))
                .catch(() => {});
        }
    }
}

// Builds the per-instance fallback used while the shared store is unavailable.
function localFallback(secretKey, limits, clock, log) {
    return new RateLimiter({
        store: new MemoryRateStore(), secretKey, clock, limits, log, fallback: null
    });
}

module.exports = {
    DEFAULT_LIMITS,
    DEFAULT_SHARDS,
    MAX_RETRY_AFTER_SECONDS,
    MemoryRateStore,
    RateLimiter,
    SCOPES,
    localFallback,
    parseLimits
};
