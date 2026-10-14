"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const test = require("node:test");
const { CAP_DEDICATED_AUTHORITY } = require("../src/core");
const { createLocalMasterServer } = require("../src/local_server");

async function request(base, route, method = "GET", body, bearer) {
    const response = await fetch(`${base}${route}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` })
        }
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

test("loopback adapter drives a four-seat dedicated lobby and rotating resume", async (t) => {
    const instance = createLocalMasterServer({ relayPort: 31420 });
    instance.server.listen(0, "127.0.0.1");
    await once(instance.server, "listening");
    t.after(() => instance.server.close());
    const address = instance.server.address();
    const base = `http://127.0.0.1:${address.port}/api/v1`;
    const registration = await request(base, "/lobbies", "POST", {
        name: "Local recovery gate",
        protocol: 1,
        build: "pc-port-v2",
        platform: "pc",
        capabilities: CAP_DEDICATED_AUTHORITY,
        region: "local",
        max_players: 4,
        current_players: 0,
        state: "lobby"
    });
    assert.equal(registration.status, 201);
    assert.deepEqual(registration.body.relay, {
        address: "127.0.0.1", udp_port: 31420
    });

    const seats = [];
    for (let seat = 0; seat < 4; ++seat) {
        const joined = await request(
            base, `/lobbies/${registration.body.lobby.id}/join`, "POST", {
                protocol: 1, build: "pc-port-v2", platform: "pc"
            });
        assert.equal(joined.status, 200);
        assert.equal(joined.body.seat, seat);
        seats.push(joined.body);
    }
    const heartbeat = await request(
        base, `/lobbies/${registration.body.lobby.id}/heartbeat`, "PUT", {
            current_players: 4, state: "playing", seat_mask: 15
        }, registration.body.host_secret);
    assert.equal(heartbeat.status, 200);
    assert.equal(heartbeat.body.current_players, 4);
    assert.equal(typeof heartbeat.body.relay_token, "string");

    const resumed = await request(
        base, `/lobbies/${registration.body.lobby.id}/join`, "POST", {
            protocol: 1,
            build: "pc-port-v2",
            platform: "pc",
            resume_token: seats[2].resume_token
        });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.seat, 2);
    assert.notEqual(resumed.body.resume_token, seats[2].resume_token);

    const status = await request(base, "/status");
    assert.equal(status.status, 200);
    assert.equal(status.body.players, 4);
    assert.equal(status.body.games, 1);
});

test("loopback adapter rejects malformed and unknown routes", async (t) => {
    const instance = createLocalMasterServer({ relayPort: 31421 });
    instance.server.listen(0, "127.0.0.1");
    await once(instance.server, "listening");
    t.after(() => instance.server.close());
    const address = instance.server.address();
    const base = `http://127.0.0.1:${address.port}/api/v1`;

    assert.equal((await request(base, "/health")).status, 200);
    assert.equal((await request(base, "/missing")).status, 404);
    const malformed = await fetch(`${base}/lobbies`, {
        method: "POST", body: "not-json"
    });
    assert.equal(malformed.status, 400);
});
