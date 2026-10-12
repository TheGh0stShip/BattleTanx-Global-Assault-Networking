"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { handle, normalizeForwardedAddress, observedIp } = require("../src/app");
const { MasterService, MemoryLobbyStore } = require("../src/core");

function setup() {
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    const service = new MasterService(
        new MemoryLobbyStore(), Buffer.alloc(32, "s"),
        () => 1_800_000_000, null, privateKey
    );
    return { service, factory: async () => service };
}

function request(method, body, extra = {}) {
    return {
        method,
        body,
        rawBody: body === undefined ? "" : JSON.stringify(body),
        headers: {},
        query: {},
        ...extra
    };
}

test("health does not initialize storage", async () => {
    const result = await handle("health", request("GET"), {}, async () => {
        throw new Error("health must not initialize storage");
    });
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body), { status: "ok", protocol: 1 });
});

test("HTTP lifecycle registers, lists, joins, validates, and removes", async () => {
    const { factory } = setup();
    const registration = {
        name: "Desert Duel", protocol: 1, build: "pc-v0.3.0", platform: "pc",
        capabilities: 3, region: "us-central", max_players: 4, current_players: 1,
        udp_port: 30420
    };
    let result = await handle("lobbies", request("POST", registration, {
        headers: { "x-forwarded-for": "198.51.100.2, 203.0.113.7:443" }
    }), {}, factory);
    assert.equal(result.status, 201);
    const created = JSON.parse(result.body);
    assert.match(created.session_id, /^[0-9a-f]{16}$/);
    const lobbyId = created.lobby.id;
    const authorization = `Bearer ${created.host_secret}`;

    result = await handle("lobbies", request("GET", undefined, {
        query: { protocol: "1", build: "pc-v0.3.0" }
    }), {}, factory);
    assert.equal(JSON.parse(result.body).lobbies.length, 1);

    result = await handle("join", request("POST", {
        protocol: 1, build: "pc-v0.3.0", platform: "vita"
    }), { lobbyId }, factory);
    assert.equal(result.status, 200);
    const joined = JSON.parse(result.body);
    assert.equal(joined.session_id, created.session_id);

    result = await handle("validateJoin", request("POST", { join_token: joined.join_token }, {
        headers: { authorization }
    }), { lobbyId }, factory);
    assert.equal(JSON.parse(result.body).valid, true);

    result = await handle("remove", request("DELETE", undefined, {
        headers: { authorization }
    }), { lobbyId }, factory);
    assert.equal(result.status, 204);
});

test("forwarded addresses are validated and request bodies are bounded", async () => {
    assert.equal(normalizeForwardedAddress("203.0.113.7:443"), "203.0.113.7");
    assert.equal(normalizeForwardedAddress("[2001:db8::7]:443"), "2001:db8::7");
    assert.equal(normalizeForwardedAddress("garbage"), "");
    assert.equal(observedIp({ headers: { "x-forwarded-for": "bad, 203.0.113.9" } }), "203.0.113.9");

    const { factory } = setup();
    const result = await handle("lobbies", {
        method: "POST", body: {}, rawBody: "x".repeat(4097), headers: {}, query: {}
    }, {}, factory);
    assert.equal(result.status, 413);
});
