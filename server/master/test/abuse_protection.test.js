"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { canonicalSource, trustedSource } = require("../src/address");
const { handle } = require("../src/app");
const { MasterService, MemoryLobbyStore } = require("../src/core");
const { RequestGuard } = require("../src/guard");
const {
    DEFAULT_LIMITS, MAX_RETRY_AFTER_SECONDS, MemoryRateStore, RateLimiter, localFallback,
    parseLimits
} = require("../src/ratelimit");
const { SecurityLog } = require("../src/security_log");
const { AzureRateLimitStore } = require("../src/store");
const { FakeTableClient } = require("./helpers/fake_table");

const KEY = Buffer.alloc(32, "r");
const T0 = 1_800_000_000;

// Both durable-store implementations run every limiter test.
const STORES = [
    ["memory", () => ({ store: new MemoryRateStore() })],
    ["azure-table", () => {
        const table = new FakeTableClient();
        return { store: new AzureRateLimitStore(table), table };
    }]
];

function limiterFor(makeStore, options = {}) {
    const clock = { now: T0 };
    const lines = [];
    const log = new SecurityLog(KEY, (line) => lines.push(line));
    const made = makeStore();
    const limiter = new RateLimiter({
        store: made.store, secretKey: KEY, clock: () => clock.now, log, storeTimeoutMs: 60_000,
        ...options
    });
    return { clock, limiter, lines, ...made };
}

// ---------------------------------------------------------------- addresses

test("IPv4 and IPv6 sources normalize to one canonical subject", () => {
    assert.equal(canonicalSource("203.0.113.7"), "203.0.113.7");
    assert.equal(canonicalSource("203.0.113.7:51000"), "203.0.113.7");
    assert.equal(canonicalSource("::ffff:203.0.113.7"), "203.0.113.7");
    assert.equal(canonicalSource("[::FFFF:CB00:7107]:443"), "203.0.113.7");
    const sixtyFour = "2001:db8:abcd:12::/64";
    for (const variant of ["2001:db8:abcd:12::1", "2001:DB8:ABCD:0012:ffff:ffff:ffff:ffff",
                           "[2001:db8:abcd:12:0:0:0:9]:443", "2001:0db8:abcd:0012::"]) {
        assert.equal(canonicalSource(variant), sixtyFour, variant);
    }
    assert.notEqual(canonicalSource("2001:db8:abcd:13::1"), sixtyFour);
    for (const bad of ["", "garbage", "1.2.3", "256.1.1.1", "fe80::1%eth0", "[2001:db8::1",
                       "2001:db8::1]:80", "1.2.3.4:99999x", "::ffff:1.2.3.4.5"]) {
        assert.equal(canonicalSource(bad), "", bad);
    }
});

test("only the forwarded entry appended by the Azure front end is trusted", () => {
    const req = (headers) => ({ headers });
    // Caller-supplied entries to the left are ignored.
    assert.equal(trustedSource(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.9:4000" })),
        "203.0.113.9");
    assert.equal(trustedSource(req({ "X-Forwarded-For": "1.1.1.1,2.2.2.2, 203.0.113.9" })),
        "203.0.113.9");
    // Headers a caller can set freely are never trusted.
    for (const name of ["x-azure-clientip", "x-real-ip", "x-client-ip", "forwarded",
                        "true-client-ip", "cf-connecting-ip"]) {
        assert.equal(trustedSource(req({ [name]: "6.6.6.6" })), "unknown", name);
    }
    // Missing, malformed or oversized trusted entries share one strict bucket.
    assert.equal(trustedSource(req({})), "unknown");
    assert.equal(trustedSource(req({ "x-forwarded-for": "203.0.113.9, garbage" })), "unknown");
    assert.equal(trustedSource(req({ "x-forwarded-for": `${"1.1.1.1,".repeat(40)}2.2.2.2` })),
        "unknown");
    assert.equal(trustedSource(req({ "x-forwarded-for": "x".repeat(4096) })), "unknown");
    // With one extra trusted proxy layer, the second-from-right entry is used.
    assert.equal(trustedSource(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.9, 10.0.0.4" }), 2),
        "203.0.113.9");
    assert.equal(trustedSource(req({ "x-forwarded-for": "203.0.113.9" }), 2), "unknown");
});

// ------------------------------------------------------------- the limiter

for (const [name, makeStore] of STORES) {
    test(`${name}: burst is allowed, then refused with a bounded Retry-After`, async () => {
        const { limiter } = limiterFor(makeStore);
        const { capacity, perHour } = DEFAULT_LIMITS.seat_source;
        for (let i = 0; i < capacity; ++i) {
            assert.equal((await limiter.consume("seat_source", "203.0.113.1")).allowed,
                true, `#${i}`);
        }
        const refused = await limiter.consume("seat_source", "203.0.113.1");
        assert.equal(refused.allowed, false);
        assert.equal(refused.retryAfter, Math.min(MAX_RETRY_AFTER_SECONDS, Math.ceil(3600 / perHour)));
        // Another subject is unaffected.
        assert.equal((await limiter.consume("seat_source", "203.0.113.2")).allowed, true);
    });

    test(`${name}: tokens refill at the sustained rate and cap at the burst`, async () => {
        const { clock, limiter } = limiterFor(makeStore);
        const { capacity, perHour } = DEFAULT_LIMITS.lobby_source;
        for (let i = 0; i < capacity; ++i) await limiter.consume("lobby_source", "s");
        assert.equal((await limiter.consume("lobby_source", "s")).allowed, false);
        clock.now += 3600 / perHour - 1;
        assert.equal((await limiter.consume("lobby_source", "s")).allowed, false);
        clock.now += 1;
        assert.equal((await limiter.consume("lobby_source", "s")).allowed, true);
        assert.equal((await limiter.consume("lobby_source", "s")).allowed, false);
        clock.now += 10 * 24 * 3600; // a long idle period refills only to capacity
        for (let i = 0; i < capacity; ++i) {
            assert.equal((await limiter.consume("lobby_source", "s")).allowed, true);
        }
        assert.equal((await limiter.consume("lobby_source", "s")).allowed, false);
    });

    test(`${name}: a zero-cost check never spends`, async () => {
        const { limiter } = limiterFor(makeStore);
        for (let i = 0; i < 100; ++i) {
            assert.equal((await limiter.consume("auth_failure", "s", 0)).allowed, true);
        }
        for (let i = 0; i < DEFAULT_LIMITS.auth_failure.capacity; ++i) {
            await limiter.consume("auth_failure", "s", 1);
        }
        assert.equal((await limiter.consume("auth_failure", "s", 0)).allowed, false);
    });

    test(`${name}: concurrent requests never spend more than the burst`, async () => {
        const { limiter, lines } = limiterFor(makeStore);
        const capacity = DEFAULT_LIMITS.auth_failure.capacity;
        const results = await Promise.all(Array.from({ length: 40 },
            () => limiter.consume("auth_failure", "203.0.113.5")));
        const allowed = results.filter((r) => r.allowed).length;
        assert.ok(allowed <= capacity, `allowed ${allowed}`);
        assert.ok(allowed >= 1);
        // Losers either saw an empty bucket or exhausted CAS retries (fail closed).
        for (const r of results.filter((x) => !x.allowed)) {
            assert.ok(r.retryAfter >= 1 && r.retryAfter <= MAX_RETRY_AFTER_SECONDS);
        }
        for (const line of lines) assert.match(JSON.parse(line).event, /^rate_limit_contention$/u);
    });

    test(`${name}: key cardinality is bounded by the shard count`, async () => {
        const { limiter, store } = limiterFor(makeStore, { shards: 64 });
        for (let i = 0; i < 2000; ++i) {
            await limiter.consume("lobby_source", `lobby:${i}|198.51.${i >> 8}.${i & 255}`);
        }
        const rows = store.rows !== undefined ? store.rows.size : undefined;
        const tableRows = store.table !== undefined ? store.table.rows.size : undefined;
        assert.ok((rows ?? tableRows) <= 64, `rows ${rows ?? tableRows}`);
    });

    test(`${name}: idle purge removes only fully refilled buckets`, async () => {
        const { clock, limiter, store } = limiterFor(makeStore);
        await limiter.consume("seat_source", "idle");
        clock.now += 60;
        await limiter.consume("seat_source", "busy");
        const size = () => (store.rows !== undefined ? store.rows.size : store.table.rows.size);
        assert.equal(size(), 2);
        const { capacity, perHour } = DEFAULT_LIMITS.seat_source;
        const fullAfter = (capacity * 3600) / perHour;
        // A cutoff just after "idle"'s write, before "busy"'s, removes only "idle".
        const removed = await store.purgeIdle("seat_source", (T0 + 30) * 1000, 100);
        assert.equal(removed, 1);
        assert.equal(size(), 1);
        // The automatic purge only runs on rows idle for a full refill.
        clock.now += fullAfter + 3600;
        limiter.lastPurge = -Infinity;
        await limiter.consume("read", "trigger");
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(size(), 1, "only the fresh 'read' row remains");
    });
}

test("a failing store degrades to the per-instance fallback, which still limits", async () => {
    const table = new FakeTableClient();
    const clock = { now: T0 };
    const lines = [];
    const log = new SecurityLog(KEY, (line) => lines.push(line));
    const limiter = new RateLimiter({
        store: new AzureRateLimitStore(table), secretKey: KEY, clock: () => clock.now, log,
        fallback: localFallback(KEY, undefined, () => clock.now, log)
    });
    table.failing = true;
    const results = [];
    for (let i = 0; i < DEFAULT_LIMITS.auth_failure.capacity + 1; ++i) {
        results.push(await limiter.consume("auth_failure", "203.0.113.8"));
    }
    assert.ok(results.every((r) => r.degraded === true));
    assert.equal(results.filter((r) => r.allowed).length, DEFAULT_LIMITS.auth_failure.capacity);
    const degraded = lines.map((line) => JSON.parse(line))
        .filter((event) => event.event === "rate_limit_store_degraded");
    assert.equal(degraded.length, 1, "degraded events are throttled to one per minute");
    // Recovery: the shared store is used again as soon as it answers.
    table.failing = false;
    const recovered = await limiter.consume("auth_failure", "203.0.113.8");
    assert.equal(recovered.degraded, undefined);
    assert.equal(recovered.allowed, true);
});

test("a store with no fallback fails closed", async () => {
    const table = new FakeTableClient();
    table.failing = true;
    const limiter = new RateLimiter({ store: new AzureRateLimitStore(table), secretKey: KEY });
    const result = await limiter.consume("seat_source", "203.0.113.8");
    assert.equal(result.allowed, false);
    assert.ok(result.retryAfter >= 1);
});

test("a hung store times out into the fallback instead of stalling requests", async () => {
    const table = new FakeTableClient();
    table.latencyMs = 200;
    const limiter = new RateLimiter({
        store: new AzureRateLimitStore(table), secretKey: KEY, storeTimeoutMs: 20,
        fallback: localFallback(KEY)
    });
    const started = Date.now();
    const result = await limiter.consume("seat_source", "203.0.113.8");
    assert.ok(Date.now() - started < 150);
    assert.equal(result.degraded, true);
    assert.equal(result.allowed, true);
});

test("limit overrides are validated and cannot disable a limit", () => {
    assert.deepEqual(parseLimits(undefined), parseLimits(""));
    assert.equal(parseLimits('{"seat_source":{"capacity":4,"perHour":2}}')
        .seat_source.capacity, 4);
    for (const bad of ['{"seat_source":{"capacity":0,"perHour":1}}',
                       '{"seat_source":{"capacity":5,"perHour":0}}',
                       '{"nope":{"capacity":1,"perHour":1}}', '{"read":{"capacity":1e9,"perHour":1}}',
                       "[1]", "not json"]) {
        assert.throws(() => parseLimits(bad), undefined, bad);
    }
});

// --------------------------------------------------------- the HTTP surface

async function api(options = {}) {
    const clock = { now: T0 };
    const lines = [];
    const log = new SecurityLog(KEY, (line) => lines.push(line));
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    const service = new MasterService(new MemoryLobbyStore(), KEY, () => clock.now,
        { address: "relay.example", udp_port: 30420 }, privateKey);
    const table = new FakeTableClient();
    const limiter = new RateLimiter({
        store: options.memory ? new MemoryRateStore() : new AzureRateLimitStore(table),
        secretKey: KEY, clock: () => clock.now, log, limits: options.limits,
        fallback: localFallback(KEY, options.limits, () => clock.now, log),
        // These scenarios run on a fake clock; a wall-clock timeout firing
        // under CPU load would silently switch them to the fallback store.
        storeTimeoutMs: 60_000
    });
    const guard = new RequestGuard({ limiter, log });
    const factory = async () => service;
    const call = (operation, { method = "POST", body, ip, lobbyId, auth, headers = {} } = {}) =>
        handle(operation, {
            method, body, rawBody: body === undefined ? "" : JSON.stringify(body), query: {},
            headers: {
                ...(ip === undefined ? {} : { "x-forwarded-for": ip }),
                ...(auth === undefined ? {} : { authorization: `Bearer ${auth}` }),
                ...headers
            }
        }, { lobbyId }, factory, guard);
    const host = async (ip = "192.0.2.1", name = "Desert Duel") => {
        const created = await call("lobbies", {
            ip, body: {
                name, protocol: 1, build: "pc-v1", platform: "pc", capabilities: 2,
                region: "eastus", max_players: 4, current_players: 1
            }
        });
        assert.equal(created.status, 201, created.body);
        const body = JSON.parse(created.body);
        const heartbeat = (mask, players = 1) => call("heartbeat", {
            method: "PUT", ip, lobbyId: body.lobby.id, auth: body.host_secret,
            body: { current_players: players, state: "playing", seat_mask: mask }
        });
        await heartbeat(0);
        return { ...body, id: body.lobby.id, heartbeat };
    };
    const join = (lobbyId, ip, extra = {}) => call("join", {
        ip, lobbyId, body: { protocol: 1, build: "pc-v1", platform: "pc", ...extra }
    });
    return { clock, lines, service, table, limiter, guard, call, host, join };
}

function json(response) {
    return JSON.parse(response.body);
}

test("four players behind one NAT join and resume; the fifth seat is refused", async () => {
    const a = await api();
    const lobby = await a.host();
    const household = "198.51.100.20";
    const players = [];
    for (let i = 0; i < 4; ++i) {
        const joined = await a.join(lobby.id, `6.6.6.${i}, ${household}`);
        assert.equal(joined.status, 200, joined.body);
        players.push(json(joined));
    }
    assert.deepEqual(players.map((p) => p.seat).sort(), [0, 1, 2, 3]);
    await lobby.heartbeat(0b1111, 4);
    // Every player crashes and resumes from the same address.
    for (const player of players) {
        const resumed = await a.join(lobby.id, household, { resume_token: player.resume_token });
        assert.equal(resumed.status, 200, resumed.body);
        assert.equal(json(resumed).seat, player.seat);
    }
    const fifth = await a.join(lobby.id, household);
    assert.equal(fifth.status, 409);
    assert.equal(json(fifth).error, "lobby_full");
});

test("one address cannot flood a lobby: 429 with Retry-After, independent of lobby existence", async () => {
    const a = await api();
    const lobby = await a.host();
    const attacker = "203.0.113.66";
    let first429;
    for (let i = 0; i < 100 && first429 === undefined; ++i) {
        const result = await a.join(lobby.id, attacker);
        if (result.status === 429) first429 = result;
    }
    assert.ok(first429, "flood was never limited");
    const retry = Number(first429.headers["retry-after"]);
    assert.ok(Number.isInteger(retry) && retry >= 1 && retry <= MAX_RETRY_AFTER_SECONDS);
    // A nonexistent lobby, and a forged resume token, produce byte-identical
    // refusals once the same buckets are exhausted.
    let missing;
    for (let i = 0; i < 100; ++i) {
        missing = await a.join("no-such-lobby", "203.0.113.67");
        if (missing.status === 429) break;
    }
    assert.equal(missing.status, 429);
    assert.equal(missing.body, first429.body);
    assert.deepEqual(Object.keys(missing.headers).sort(), Object.keys(first429.headers).sort());
    const body = json(first429);
    assert.deepEqual(Object.keys(body).sort(), ["error", "message"]);
    assert.equal(body.error, "rate_limited");
    // Other addresses are not rate limited (the flood did fill the lobby).
    assert.equal((await a.join(lobby.id, "203.0.113.68")).status, 409);
});

test("rotating spoofed X-Forwarded-For entries does not evade the limit", async () => {
    const a = await api();
    const lobby = await a.host();
    let limited = false;
    for (let i = 0; i < 200 && !limited; ++i) {
        const spoof = `${i % 250}.${i % 7}.1.1`;
        const result = await a.call("join", {
            lobbyId: lobby.id, body: { protocol: 1, build: "pc-v1", platform: "pc" },
            headers: {
                "x-forwarded-for": `${spoof}, 203.0.113.70`,
                "x-azure-clientip": spoof,
                "x-real-ip": spoof
            }
        });
        limited = result.status === 429;
    }
    assert.ok(limited);
});

test("callers without a trusted address share one strict bucket", async () => {
    const a = await api();
    const lobby = await a.host();
    let limited = false;
    for (let i = 0; i < 200 && !limited; ++i) {
        const result = await a.call("join", {
            lobbyId: lobby.id, body: { protocol: 1, build: "pc-v1", platform: "pc" },
            headers: { "x-azure-clientip": `10.0.${i}.1` }
        });
        limited = result.status === 429;
    }
    assert.ok(limited);
});

test("IPv6 callers rotating inside one /64 share a budget", async () => {
    const a = await api();
    const lobby = await a.host();
    let limited = false;
    for (let i = 0; i < 200 && !limited; ++i) {
        const result = await a.join(lobby.id, `2001:db8:1:2:${(i + 1).toString(16)}::1`);
        limited = result.status === 429;
    }
    assert.ok(limited);
    assert.notEqual((await a.join(lobby.id, "2001:db8:1:3::1")).status, 429);
});

test("credential failures exhaust a per-address budget, then even valid credentials wait", async () => {
    const a = await api();
    const lobby = await a.host("192.0.2.50");
    const attacker = "203.0.113.90";
    const statuses = [];
    for (let i = 0; i < DEFAULT_LIMITS.auth_failure.capacity + 2; ++i) {
        const result = await a.call("heartbeat", {
            method: "PUT", ip: attacker, lobbyId: lobby.id, auth: "wrong-secret",
            body: { current_players: 1 }
        });
        statuses.push(result.status);
    }
    assert.deepEqual(statuses.slice(0, DEFAULT_LIMITS.auth_failure.capacity),
        Array(DEFAULT_LIMITS.auth_failure.capacity).fill(403));
    assert.equal(statuses.at(-1), 429);
    // Forged resume tokens count against the same budget.
    const forged = await a.join(lobby.id, attacker, { resume_token: "a.b" });
    assert.equal(forged.status, 429);
    // The genuine host at its own address is unaffected.
    assert.equal((await lobby.heartbeat(0)).status, 200);
    const events = a.lines.map((line) => JSON.parse(line));
    assert.ok(events.some((e) => e.event === "auth_failure" && e.reason === "forbidden"));
    assert.ok(events.some((e) => e.event === "rate_limited" && e.scope === "auth_failure"));
});

test("lobby creation is limited per address and service-wide", async () => {
    const a = await api({ limits: { lobby_create: { capacity: 5, perHour: 60 } } });
    for (let i = 0; i < 5; ++i) await a.host(`192.0.2.${100 + i}`);
    const refused = await a.call("lobbies", {
        ip: "192.0.2.200", body: {
            name: "x", protocol: 1, build: "pc-v1", platform: "pc", capabilities: 0,
            region: "r", max_players: 4, current_players: 1
        }
    });
    assert.equal(refused.status, 429);
    a.clock.now += 60;
    await a.host("192.0.2.201");
});

test("heartbeats are limited per lobby", async () => {
    const a = await api();
    const lobby = await a.host();
    const statuses = [];
    for (let i = 0; i < DEFAULT_LIMITS.heartbeat.capacity + 1; ++i) {
        statuses.push((await lobby.heartbeat(0)).status);
    }
    assert.equal(statuses.at(-1), 429);
    a.clock.now += 5;
    assert.equal((await lobby.heartbeat(0)).status, 200);
});

test("public reads are limited per address", async () => {
    const a = await api({ limits: { read: { capacity: 3, perHour: 60 } } });
    const statuses = [];
    for (let i = 0; i < 4; ++i) {
        statuses.push((await a.call("status", { method: "GET", ip: "203.0.113.4" })).status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 429]);
    assert.equal((await a.call("health", { method: "GET", ip: "203.0.113.4" })).status, 200);
});

test("public reads use the fast limiter while mutations remain durable", async () => {
    const calls = { durable: [], fast: [] };
    const makeLimiter = (kind) => ({
        async consume(scope, subject, cost) {
            calls[kind].push({ scope, subject, cost });
            return { allowed: true, retryAfter: 0 };
        }
    });
    const guard = new RequestGuard({
        limiter: makeLimiter("durable"), readLimiter: makeLimiter("fast")
    });
    const request = {
        method: "GET", headers: { "x-forwarded-for": "203.0.113.44" }
    };

    await guard.admit("status", request);
    await guard.admit("dashboard", request);
    assert.deepEqual(calls.durable, []);
    assert.deepEqual(calls.fast.map((call) => call.scope), ["read", "read"]);

    const admitted = await guard.admit("join", {
        method: "POST", headers: request.headers,
        body: { protocol: 1, build: "pc-v1", platform: "pc" }
    }, { lobbyId: "lobby-1" });
    await guard.recordSuccess(admitted.context);
    assert.deepEqual(calls.durable.map((call) => [call.scope, call.cost]), [
        ["lobby_source", 1], ["seat_source", 0], ["lobby", 0],
        ["seat_source", 1], ["lobby", 1]
    ]);
    assert.equal(calls.fast.length, 2);

    calls.durable.length = 0;
    const resumed = await guard.admit("join", {
        method: "POST", headers: request.headers,
        body: { protocol: 1, build: "pc-v1", platform: "pc", resume_token: "token" }
    }, { lobbyId: "lobby-1" });
    await guard.recordSuccess(resumed.context);
    assert.deepEqual(calls.durable.map((call) => [call.scope, call.cost]), [
        ["auth_failure", 0], ["lobby_source", 1]
    ]);
});

test("storage outage keeps the API available with per-instance limits", async () => {
    const a = await api();
    const lobby = await a.host();
    a.table.failing = true;
    let limited = false;
    for (let i = 0; i < 200 && !limited; ++i) {
        const result = await a.join(lobby.id, "203.0.113.99");
        assert.ok([200, 409, 429].includes(result.status), result.body);
        limited = result.status === 429;
    }
    assert.ok(limited, "fallback still limits");
    assert.notEqual((await a.join(lobby.id, "203.0.113.98")).status, 429);
    assert.ok(a.lines.some((line) => JSON.parse(line).event === "rate_limit_store_degraded"));
});

test("security events contain no names, bodies, credentials or addresses", async () => {
    const a = await api();
    const hostile = "<script>alert(1)</script>‮";
    const lobby = await a.host("192.0.2.77", hostile.replace(/‮/u, ""));
    const joined = json(await a.join(lobby.id, "198.51.100.200"));
    for (let i = 0; i < 12; ++i) {
        await a.call("heartbeat", {
            method: "PUT", ip: "203.0.113.91", lobbyId: lobby.id, auth: lobby.host_secret.slice(1),
            body: { current_players: 1, name: hostile }
        });
        await a.join(lobby.id, "203.0.113.91", { resume_token: joined.resume_token.slice(2) });
    }
    for (let i = 0; i < 60; ++i) await a.join(lobby.id, "2001:db8:dead:beef::5");
    assert.ok(a.lines.length > 0);
    const forbidden = [
        "<script", "alert(", lobby.id, lobby.host_secret, lobby.relay_token, joined.resume_token,
        joined.join_token, lobby.session_id, "198.51.100.200", "203.0.113.91", "192.0.2.77",
        "2001:db8", "dead:beef", KEY.toString("utf8")
    ];
    const allowedFields = new Set([
        "type", "event", "scope", "route", "reason", "source_kind", "source", "lobby", "retry_after"
    ]);
    for (const line of a.lines) {
        for (const secret of forbidden) {
            assert.equal(line.includes(secret), false, `log leaked ${secret.slice(0, 12)}`);
        }
        const event = JSON.parse(line);
        for (const field of Object.keys(event)) assert.ok(allowedFields.has(field), field);
        assert.match(event.source, /^([0-9a-f]{12}|none)$/u);
        assert.match(event.lobby, /^([0-9a-f]{12}|none)$/u);
    }
    // Pseudonyms are stable per caller, so incidents can still be correlated.
    const sources = new Set(a.lines.map((line) => JSON.parse(line))
        .filter((event) => event.event === "auth_failure").map((event) => event.source));
    assert.equal(sources.size, 1);
    // The hostile name reaches the dashboard only escaped.
    const dashboard = await a.call("dashboard", { method: "GET", ip: "203.0.113.5" });
    assert.equal(dashboard.body.includes("<script>"), false);
    assert.ok(dashboard.body.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
});

// ------------------------------------------------------------- stress test

// Simulates a public four-seat lobby attacked by many addresses that join
// greedily and never bind the relay, while a four-player household (one NAT)
// tries to play. The authority confirms bound seats through seat_mask every
// 15 seconds. Time advances in 5-second steps. Every attacker address that is
// not currently throttled sends `aggression` joins per step (the household
// sends at most one per player); requests within a step arrive in a seeded
// random order, as concurrent HTTP requests would.
async function siege(attackerCount, hours, { seed = 1, aggression = 10 } = {}) {
    let state = seed;
    const random = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 2 ** 32;
    };
    const a = await api({ memory: true });
    const lobby = await a.host("192.0.2.10");
    const attackers = Array.from({ length: attackerCount },
        (_, i) => ({ ip: `100.${64 + (i >> 8)}.${i & 255}.9`, wakeAt: 0 }));
    const household = "198.51.100.30";
    const players = Array.from({ length: 4 }, () => ({ seat: null, wakeAt: 0, confirmedAt: null }));
    const stats = { attackerSeats: 0, attackerAllocations: 0, evictionsOfConfirmed: 0 };
    let held = new Map(); // seat -> "player" | "attacker"
    const confirmed = new Map(); // seat -> player index
    const start = a.clock.now;
    const steps = (hours * 3600) / 5;
    for (let step = 0; step < steps; ++step) {
        a.clock.now += 5;
        const now = a.clock.now;
        const actors = [
            ...attackers.filter((attacker) => now >= attacker.wakeAt)
                .flatMap((attacker) => Array(aggression).fill(attacker)),
            ...players.filter((player) => player.seat === null && now >= player.wakeAt)
        ];
        for (let i = actors.length - 1; i > 0; --i) {
            const j = Math.floor(random() * (i + 1));
            [actors[i], actors[j]] = [actors[j], actors[i]];
        }
        for (const actor of actors) {
            if (actor.ip !== undefined) {
                const attacker = actor;
                if (now < attacker.wakeAt) continue;
                const result = await a.join(lobby.id, attacker.ip);
                if (result.status === 200) {
                    const seat = json(result).seat;
                    if (confirmed.has(seat)) stats.evictionsOfConfirmed += 1;
                    held.set(seat, "attacker");
                    stats.attackerAllocations += 1;
                } else if (result.status === 429) {
                    attacker.wakeAt = now + Number(result.headers["retry-after"]);
                }
                continue;
            }
            const player = actor;
            const result = await a.join(lobby.id, household);
            if (result.status === 200) {
                player.seat = json(result).seat;
                held.set(player.seat, "player");
            } else if (result.status === 429) {
                player.wakeAt = now + Number(result.headers["retry-after"]);
            } else {
                player.wakeAt = now + 15; // lobby_full: polite retry
            }
        }
        if (step % 3 === 2) {
            // Heartbeat: seats bound by players are reported connected.
            let mask = 0;
            for (const [index, player] of players.entries()) {
                if (player.seat === null) continue;
                if (held.get(player.seat) !== "player") {
                    player.seat = null; // provisional seat lost before binding
                    continue;
                }
                mask |= 1 << player.seat;
                if (!confirmed.has(player.seat)) {
                    confirmed.set(player.seat, index);
                    player.confirmedAt = now;
                }
            }
            // The dedicated authority reports connected players only.
            assert.equal((await lobby.heartbeat(mask, Math.max(1, confirmed.size))).status, 200);
        }
        stats.attackerSeats = Math.max(stats.attackerSeats,
            [...held.values()].filter((owner) => owner === "attacker").length);
    }
    return {
        ...stats,
        seated: players.filter((p) => p.confirmedAt !== null).length,
        lastSeatedMinutes: Math.max(...players.map((p) =>
            p.confirmedAt === null ? Infinity : (p.confirmedAt - start) / 60))
    };
}

test("stress: many attacking addresses cannot keep a household out; confirmed seats hold", async () => {
    const hours = 3;
    const attackers = 24;
    const result = await siege(attackers, hours);
    // Seat allocations are bounded by the per-address budget, not by how hard
    // the attacker pushes.
    const { capacity, perHour } = DEFAULT_LIMITS.seat_source;
    assert.ok(result.attackerAllocations <= attackers * (capacity + perHour * hours),
        `attacker allocated ${result.attackerAllocations} seats`);
    assert.equal(result.evictionsOfConfirmed, 0, "a confirmed seat was reassigned");
    assert.equal(result.seated, 4, `only ${result.seated} household players seated`);
    assert.ok(result.lastSeatedMinutes < 30, `household waited ${result.lastSeatedMinutes} min`);
    assert.ok(result.attackerAllocations > 0, "the attack never got a seat; scenario too weak");
});

// Above roughly 30 addresses an attacker can afford to keep re-taking freed
// provisional seats until its per-address bursts run out (see
// docs/ABUSE_PROTECTION.md). What must still hold is that confirmed seats are
// never reassigned and that the household keeps making progress.
test("stress: a larger attacking population still never displaces confirmed seats", async () => {
    const result = await siege(200, 1);
    assert.equal(result.evictionsOfConfirmed, 0);
    assert.ok(result.seated >= 1, "household made no progress");
    assert.ok(result.attackerAllocations > 0);
});
