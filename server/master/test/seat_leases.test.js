"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { dashboardHtml, handle } = require("../src/app");
const {
    JOIN_TOKEN_TTL_SECONDS,
    MasterService,
    MemoryLobbyStore,
    PROVISIONAL_EVICTION_SECONDS,
    PROVISIONAL_SEAT_TTL_SECONDS,
    SEAT_LEASE_TTL_SECONDS
} = require("../src/core");
const { AzureLobbyStore } = require("../src/store");
const { verifyAdmissionToken } = require("../../relay/src/protocol");

test("seat lease timing constants are defined and ordered", () => {
    for (const value of [JOIN_TOKEN_TTL_SECONDS, PROVISIONAL_EVICTION_SECONDS,
                         PROVISIONAL_SEAT_TTL_SECONDS, SEAT_LEASE_TTL_SECONDS]) {
        assert.ok(Number.isInteger(value) && value > 0);
    }
    assert.ok(PROVISIONAL_EVICTION_SECONDS < PROVISIONAL_SEAT_TTL_SECONDS);
    assert.ok(PROVISIONAL_SEAT_TTL_SECONDS < SEAT_LEASE_TTL_SECONDS);
});

// Yields to the event loop around every store operation so concurrent requests
// interleave between their read and their compare-and-swap.
class InterleavingStore extends MemoryLobbyStore {
    async get(id) {
        await new Promise(setImmediate);
        return super.get(id);
    }

    async compareAndSwap(lobby, etag) {
        await new Promise(setImmediate);
        return super.compareAndSwap(lobby, etag);
    }
}

async function fixture() {
    const state = { now: 1_800_000_000 };
    const store = new InterleavingStore();
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    const service = new MasterService(store, Buffer.alloc(32, "k"), () => state.now,
        { address: "relay.example", udp_port: 30420 }, privateKey);
    const reg = await service.register({
        name: "<img src=x onerror=alert(1)>", protocol: 1, build: "pc-v1", platform: "pc",
        capabilities: 2, region: "eastus", max_players: 4, current_players: 1
    }, "203.0.113.9");
    const join = (extra = {}, ip = undefined) => service.join(reg.lobby.id,
        { protocol: 1, build: "pc-v1", platform: "pc", ...extra }, ip);
    const heartbeat = (players, mask) => service.heartbeat(reg.lobby.id,
        `Bearer ${reg.host_secret}`, players, "playing", mask);
    const advance = async (seconds, players, mask) => {
        assert.ok(Number.isInteger(seconds));
        for (let elapsed = 0; elapsed < seconds; elapsed += 15) {
            state.now += Math.min(15, seconds - elapsed);
            await heartbeat(players, mask);
        }
    };
    return { state, store, service, reg, join, heartbeat, advance, privateKey };
}

function claims(token) {
    return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
}

async function code(promise) {
    try {
        await promise;
        return "ok";
    } catch (error) {
        return error.code || error.message;
    }
}

function seatsMask(...players) {
    return players.reduce((mask, player) => mask | (1 << player.seat), 0);
}

test("simultaneous new joins allocate unique seats and reject extras", async () => {
    const f = await fixture();
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => f.join()));
    const seats = results.filter((r) => r.status === "fulfilled").map((r) => r.value.seat);
    assert.equal(new Set(seats).size, seats.length);
    assert.ok(seats.length <= 4);
    for (const seat of seats) assert.ok(seat >= 0 && seat <= 3);
    for (const r of results.filter((x) => x.status === "rejected")) {
        assert.ok(["lobby_full", "join_race"].includes(r.reason.code), r.reason.code);
    }
});

test("CAS contention is bounded and never duplicates a seat", async () => {
    const f = await fixture();
    let casCalls = 0;
    const original = f.store.compareAndSwap.bind(f.store);
    f.store.compareAndSwap = (...args) => {
        casCalls += 1;
        return original(...args);
    };
    const results = await Promise.allSettled(Array.from({ length: 24 }, () => f.join()));
    const seats = results.filter((r) => r.status === "fulfilled").map((r) => r.value.seat);
    assert.equal(new Set(seats).size, seats.length);
    for (const r of results.filter((x) => x.status === "rejected")) {
        assert.ok(["lobby_full", "join_race"].includes(r.reason.code), r.reason.code);
    }
    assert.ok(casCalls <= 24 * 8, `cas calls ${casCalls}`);
    const persisted = JSON.parse((await f.store.get(f.reg.lobby.id)).seat_leases_json);
    assert.deepEqual(persisted.map((lease) => lease.seat).sort(), seats.slice().sort());
});

test("concurrent resumes of one credential have exactly one winner", async () => {
    const f = await fixture();
    const first = await f.join();
    const outcomes = await Promise.allSettled(
        Array.from({ length: 6 }, () => f.join({ resume_token: first.resume_token })));
    const winners = outcomes.filter((o) => o.status === "fulfilled");
    assert.equal(winners.length, 1);
    for (const o of outcomes.filter((x) => x.status === "rejected")) {
        assert.equal(o.reason.code, "resume_expired");
    }
    const winner = winners[0].value;
    assert.equal(winner.seat, first.seat);
    assert.equal((await f.join({ resume_token: winner.resume_token })).seat, first.seat);
});

test("an old resume token is rejected after rotation", async () => {
    const f = await fixture();
    const first = await f.join();
    const second = await f.join({ resume_token: first.resume_token });
    assert.notEqual(claims(second.resume_token).lease, claims(first.resume_token).lease);
    assert.equal(await code(f.join({ resume_token: first.resume_token })), "resume_expired");
});

test("join racing resume never takes the resumed seat", async () => {
    const f = await fixture();
    const players = [await f.join(), await f.join(), await f.join()];
    const [resumed, fresh] = await Promise.all([
        f.join({ resume_token: players[0].resume_token }), f.join()]);
    assert.equal(resumed.seat, players[0].seat);
    assert.equal(fresh.seat, 3);
});

test("heartbeats racing joins preserve every lease", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
        f.join(), f.heartbeat(1), f.join(), f.heartbeat(2, 0), f.join(), f.heartbeat(2)]);
    for (const r of results) assert.equal(r.status, "fulfilled", r.reason && r.reason.message);
    const lobby = await f.store.get(f.reg.lobby.id);
    assert.equal(JSON.parse(lobby.seat_leases_json).length, 3);
});

test("join tokens carry the seat and a strictly increasing lease sequence", async () => {
    const f = await fixture();
    const a = await f.join();
    const b = await f.join();
    const c = await f.join({ resume_token: a.resume_token });
    const sequences = [a, b, c].map((joined) => claims(joined.join_token).lease_seq);
    assert.deepEqual(sequences, [1, 2, 3]);
    assert.equal(claims(c.join_token).seat, a.seat);
    assert.equal(claims(a.join_token).expires, f.state.now + JOIN_TOKEN_TTL_SECONDS);
    const auth = `Bearer ${f.reg.host_secret}`;
    f.state.now = claims(c.join_token).expires;
    await f.service.validateJoinToken(f.reg.lobby.id, auth, c.join_token);
    f.state.now += 1;
    await assert.rejects(f.service.validateJoinToken(f.reg.lobby.id, auth, c.join_token),
        { code: "invalid_token" });
});

test("wrong lobby, session, seat, key, role and malformed resume claims fail closed", async () => {
    const f = await fixture();
    const other = await fixture();
    const mine = await f.join();
    const theirs = await other.join();
    assert.equal(await code(f.join({ resume_token: theirs.resume_token })), "invalid_resume");
    for (const bad of ["", ".", "a.b.c", "x".repeat(1025), 7, null, {}]) {
        const result = await code(f.join({ resume_token: bad }));
        assert.ok(["invalid_resume", "invalid_field"].includes(result), `${bad}: ${result}`);
    }
    const mineClaims = claims(mine.resume_token);
    const sign = (value) => f.service.issueAdmissionToken(value);
    assert.equal(await code(f.join({
        resume_token: other.service.issueAdmissionToken(mineClaims)
    })), "invalid_resume");
    assert.equal(await code(f.join({ resume_token: mine.join_token })), "invalid_resume");
    assert.equal(await code(f.join({
        resume_token: sign({ ...mineClaims, session: "0000000000000000" })
    })), "invalid_resume");
    assert.equal(await code(f.join({ resume_token: sign({ ...mineClaims, seat: 4 }) })),
        "invalid_resume");
    assert.equal(await code(f.join({
        resume_token: sign({ ...mineClaims, seat: (mine.seat + 1) % 4 })
    })), "resume_expired");
});

test("resume token expiry: valid at its expiry second, rejected after", async () => {
    const f = await fixture();
    const mine = await f.join();
    const c = claims(mine.resume_token);
    const atBoundary = f.service.issueAdmissionToken({ ...c, expires: f.state.now });
    assert.equal(await code(f.join({ resume_token: atBoundary })), "ok");
    const past = f.service.issueAdmissionToken({ ...c, expires: f.state.now - 1 });
    assert.equal(await code(f.join({ resume_token: past })), "invalid_resume");
});

test("resume tokens are never valid relay admission tokens", async () => {
    const f = await fixture();
    const joined = await f.join();
    assert.throws(() => verifyAdmissionToken(joined.resume_token,
        crypto.createPublicKey(f.privateKey), f.state.now));
});

test("an authority-confirmed seat stays reserved past the lease TTL", async () => {
    const f = await fixture();
    const players = [await f.join(), await f.join(), await f.join()];
    await f.advance(11 * 60, 3, seatsMask(...players));
    const stranger = await f.join();
    assert.ok(!players.some((p) => p.seat === stranger.seat),
        `stranger was given occupied seat ${stranger.seat}`);
});

test("a disconnected confirmed seat can resume until its lease lapses", async () => {
    const f = await fixture();
    const kept = await f.join();
    const dropped = await f.join();
    await f.advance(11 * 60, 2, seatsMask(kept, dropped));
    // `dropped` disconnects: the authority stops reporting its seat.
    await f.advance(SEAT_LEASE_TTL_SECONDS - 15, 1, seatsMask(kept));
    const resumed = await f.join({ resume_token: dropped.resume_token });
    assert.equal(resumed.seat, dropped.seat);
    // After resuming, the player never binds: the lease lapses on schedule.
    await f.advance(SEAT_LEASE_TTL_SECONDS, 1, seatsMask(kept));
    assert.equal(await code(f.join({ resume_token: resumed.resume_token })), "resume_expired");
    assert.equal(await code(f.join({ resume_token: kept.resume_token })), "ok");
});

test("heartbeat renews only seats present in seat_mask", async () => {
    const f = await fixture();
    const a = await f.join();
    const b = await f.join();
    await f.heartbeat(2, seatsMask(a, b));
    await f.advance(SEAT_LEASE_TTL_SECONDS + 15, 1, seatsMask(a));
    const lobby = await f.store.get(f.reg.lobby.id);
    const seats = JSON.parse(lobby.seat_leases_json)
        .filter((lease) => lease.expires > f.state.now).map((lease) => lease.seat);
    assert.deepEqual(seats, [a.seat]);
});

test("unconfirmed seats expire after the provisional TTL", async () => {
    const f = await fixture();
    await f.heartbeat(1, 0);
    const squatter = await f.join();
    const resumed = await f.join({ resume_token: squatter.resume_token });
    const current = await f.store.get(f.reg.lobby.id);
    const reissued = JSON.parse(current.seat_leases_json)[0];
    assert.equal(reissued.expires, f.state.now + PROVISIONAL_SEAT_TTL_SECONDS);
    f.state.now = reissued.expires;
    await f.heartbeat(1, 0);
    assert.equal(await code(f.join({ resume_token: resumed.resume_token })),
        "resume_expired");
    assert.equal((await f.join()).seat, squatter.seat);
});

test("anonymous joins cannot exhaust a lobby", async () => {
    const f = await fixture();
    await f.heartbeat(1, 0);
    // One address holds at most two unconfirmed seats.
    const fromOne = [];
    for (let i = 0; i < 4; ++i) fromOne.push(await f.join({}, "198.51.100.1"));
    assert.equal(new Set(fromOne.map((joined) => joined.seat)).size, 2);
    // Many addresses can fill the lobby, but only briefly.
    await f.join({}, "198.51.100.2");
    await f.join({}, "198.51.100.3");
    assert.equal(await code(f.join({}, "198.51.100.4")), "lobby_full");
    f.state.now += PROVISIONAL_EVICTION_SECONDS;
    const real = await f.join({}, "198.51.100.5");
    // The real player binds and the authority confirms the seat; it is then
    // never handed to anyone else, however many joins follow.
    await f.heartbeat(2, 1 << real.seat);
    for (let round = 0; round < 8; ++round) {
        f.state.now += PROVISIONAL_EVICTION_SECONDS;
        const joined = await f.join({}, `198.51.100.${10 + round}`);
        assert.notEqual(joined.seat, real.seat);
        await f.heartbeat(2, 1 << real.seat);
    }
});

test("resuming an unconfirmed seat cannot keep it alive", async () => {
    const f = await fixture();
    await f.heartbeat(1, 0);
    let squats = [];
    for (let i = 0; i < 4; ++i) squats.push(await f.join({}, `198.51.100.${20 + i}`));
    const firstExpiry = f.state.now + PROVISIONAL_SEAT_TTL_SECONDS;
    while (f.state.now + 10 < firstExpiry) {
        f.state.now += 10;
        squats = await Promise.all(squats.map((s) => f.join({ resume_token: s.resume_token })));
    }
    // Every resume kept the original eviction clock, so a real player gets in.
    assert.equal((await code(f.join({}, "198.51.100.99"))), "ok");
    f.state.now = firstExpiry;
    for (const s of squats) {
        assert.equal(await code(f.join({ resume_token: s.resume_token })), "resume_expired");
    }
});

test("lobbies whose authority never sent seat_mask keep full-length leases", async () => {
    const f = await fixture();
    const players = [await f.join({}, "198.51.100.1"), await f.join({}, "198.51.100.1"),
                     await f.join({}, "198.51.100.1"), await f.join({}, "198.51.100.1")];
    assert.equal(new Set(players.map((p) => p.seat)).size, 4);
    await f.advance(SEAT_LEASE_TTL_SECONDS - 15, 3);
    assert.equal(await code(f.join({}, "198.51.100.2")), "lobby_full");
    assert.equal(await code(f.join({ resume_token: players[0].resume_token })), "ok");
});

test("seat_mask outside the lobby seats is rejected", async () => {
    const f = await fixture();
    for (const mask of [-1, 16, 1.5, "1", null]) {
        assert.equal(await code(f.heartbeat(1, mask)), "invalid_field", String(mask));
    }
    const lobby = await f.store.get(f.reg.lobby.id);
    assert.notEqual(lobby.seat_mask_seen, true);
});

test("unreadable seat state fails closed instead of freeing every seat", async () => {
    const f = await fixture();
    await f.join();
    const lobby = await f.store.get(f.reg.lobby.id);
    lobby.seat_leases_json = "{not json";
    await f.store.put(lobby);
    assert.equal(await code(f.join()), "lobby_state_invalid");
});

test("both stores fail closed on a stale, absent or wildcard etag", async () => {
    // Fake TableClient with the SDK's documented If-Match semantics,
    // including its default of "*" when no etag is passed.
    const rows = new Map();
    let version = 0;
    const statusError = (statusCode) =>
        Object.assign(new Error(String(statusCode)), { statusCode });
    const table = {
        async upsertEntity(entity) {
            rows.set(entity.rowKey, { ...entity, etag: `W/"${++version}"` });
        },
        async getEntity(partition, row) {
            if (!rows.has(row)) throw statusError(404);
            return { ...rows.get(row) };
        },
        async updateEntity(entity, mode, options = {}) {
            const { etag = "*" } = options;
            const row = rows.get(entity.rowKey);
            if (!row) throw statusError(404);
            if (etag !== "*" && etag !== row.etag) throw statusError(412);
            rows.set(entity.rowKey, { ...entity, etag: `W/"${++version}"` });
        }
    };
    for (const store of [new AzureLobbyStore(table), new MemoryLobbyStore()]) {
        await store.put({ id: "L", capabilities: 1, n: 0 });
        const a = await store.get("L");
        const b = await store.get("L");
        assert.equal(await store.compareAndSwap({ ...a, n: 1 }, a._etag), true);
        assert.equal(await store.compareAndSwap({ ...b, n: 2 }, b._etag), false);
        for (const etag of [undefined, null, "", "*"]) {
            assert.equal(await store.compareAndSwap({ ...a, n: 3 }, etag), false, String(etag));
        }
        assert.equal((await store.get("L")).n, 1);
    }
});

test("public outputs carry no credentials, leases or addresses and escape names", async () => {
    const f = await fixture();
    const joined = await f.join({}, "198.51.100.77");
    const listed = JSON.stringify(await f.service.listLobbies(1, "pc-v1"));
    const snapshot = await f.service.publicSnapshot();
    const html = dashboardHtml(snapshot);
    const lobby = await f.store.get(f.reg.lobby.id);
    const secrets = [joined.resume_token, joined.join_token, f.reg.host_secret,
        f.reg.session_id, claims(joined.resume_token).lease,
        JSON.parse(lobby.seat_leases_json)[0].source, "seat_leases", "lease_seq",
        "secret_hash", "203.0.113.9", "198.51.100.77"];
    for (const blob of [listed, JSON.stringify(snapshot), html]) {
        for (const secret of secrets) {
            assert.equal(blob.includes(secret), false, `leaked ${secret.slice(0, 16)}`);
        }
    }
    assert.equal(html.includes("<img"), false);
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
});

test("HTTP routes pass seat_mask and the caller address to the service", async () => {
    const f = await fixture();
    const factory = async () => f.service;
    const request = (method, body, headers = {}) => ({
        method, body, rawBody: JSON.stringify(body), headers, query: {}
    });
    const joinBody = { protocol: 1, build: "pc-v1", platform: "pc" };
    const forwarded = { "x-forwarded-for": "198.51.100.9" };
    const lobbyId = f.reg.lobby.id;
    let result = await handle("heartbeat", request("PUT", { current_players: 1, seat_mask: 0 },
        { authorization: `Bearer ${f.reg.host_secret}` }), { lobbyId }, factory);
    assert.equal(result.status, 200);
    const seats = [];
    for (let i = 0; i < 3; ++i) {
        result = await handle("join", request("POST", joinBody, forwarded), { lobbyId }, factory);
        assert.equal(result.status, 200);
        seats.push(JSON.parse(result.body).seat);
    }
    assert.equal(new Set(seats).size, 2, "one address is limited to two unconfirmed seats");
    result = await handle("heartbeat", request("PUT", { current_players: 1, seat_mask: 99 },
        { authorization: `Bearer ${f.reg.host_secret}` }), { lobbyId }, factory);
    assert.equal(result.status, 400);
});
