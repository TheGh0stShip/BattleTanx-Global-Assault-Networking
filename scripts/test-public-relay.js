#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const dgram = require("node:dgram");
const {
    TYPE_BIND, TYPE_BOUND, TYPE_DATA, decodeEnvelope, encodeEnvelope
} = require("../server/relay/src/protocol");

const base = (process.argv[2] || "").replace(/\/$/u, "");
if (!/^https:\/\//u.test(base)) {
    process.stderr.write("usage: test-public-relay.js https://MASTER/api/v1\n");
    process.exit(2);
}

async function request(path, init = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
        const response = await fetch(`${base}${path}`, {
            ...init,
            signal: controller.signal,
            headers: {
                ...(init.body ? { "content-type": "application/json" } : {}),
                ...(init.headers || {})
            }
        });
        if (!response.ok) {
            throw new Error(`${init.method || "GET"} ${path}: HTTP ${response.status}`);
        }
        return response.status === 204 ? null : response.json();
    } finally {
        clearTimeout(timeout);
    }
}

function bind(socket) {
    return new Promise((resolve, reject) => {
        socket.once("error", reject);
        socket.bind(0, "0.0.0.0", () => {
            socket.removeListener("error", reject);
            resolve();
        });
    });
}

function receive(socket) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("public UDP receive timeout")), 5000);
        socket.once("message", (packet) => {
            clearTimeout(timeout);
            resolve(packet);
        });
    });
}

function send(socket, packet, relay) {
    return new Promise((resolve, reject) => {
        socket.send(packet, relay.udp_port, relay.address,
                    (error) => error ? reject(error) : resolve());
    });
}

function gameplayPacket(sessionId, peerId) {
    const packet = Buffer.alloc(32);
    packet.writeUInt32BE(0x42544741, 0);
    packet.writeUInt16BE(1, 4);
    packet[6] = 8;
    packet[7] = 4;
    packet.writeBigUInt64BE(sessionId, 8);
    packet.writeUInt16BE(peerId, 30);
    return packet;
}

async function main() {
    let lobbyId;
    let hostSecret;
    const host = dgram.createSocket("udp4");
    const client = dgram.createSocket("udp4");
    const resumedClient = dgram.createSocket("udp4");
    try {
        const registration = await request("/lobbies", {
            method: "POST",
            body: JSON.stringify({
                name: "Public relay smoke test",
                protocol: 1,
                build: "public-relay-smoke-v1",
                platform: "pc",
                capabilities: 0,
                region: "eastus",
                max_players: 4,
                current_players: 1
            })
        });
        lobbyId = registration.lobby.id;
        hostSecret = registration.host_secret;
        const joined = await request(`/lobbies/${lobbyId}/join`, {
            method: "POST",
            body: JSON.stringify({
                protocol: 1, build: "public-relay-smoke-v1", platform: "pc"
            })
        });
        assert.deepEqual(joined.relay, registration.relay);
        assert.equal(joined.session_id, registration.session_id);
        assert.equal(joined.seat, 0);
        assert.equal(typeof joined.resume_token, "string");
        assert.match(registration.relay.address, /^[A-Za-z0-9.-]+$/u);

        const relay = registration.relay;
        const sessionId = BigInt(`0x${registration.session_id}`);
        await Promise.all([bind(host), bind(client)]);

        await send(host, encodeEnvelope(
            TYPE_BIND, sessionId, 0xffff, 0, Buffer.from(registration.relay_token)
        ), relay);
        const hostBound = decodeEnvelope(await receive(host));
        assert.equal(hostBound.type, TYPE_BOUND);
        assert.equal(hostBound.sourceSlot, 0);

        await send(client, encodeEnvelope(
            TYPE_BIND, sessionId, 0xffff, 0, Buffer.from(joined.join_token)
        ), relay);
        const clientBound = decodeEnvelope(await receive(client));
        assert.equal(clientBound.type, TYPE_BOUND);
        assert.equal(clientBound.sourceSlot, 1);

        const gameplay = gameplayPacket(sessionId, 1);
        await send(client, encodeEnvelope(TYPE_DATA, sessionId, 1, 0, gameplay), relay);
        const forwarded = decodeEnvelope(await receive(host));
        assert.equal(forwarded.type, TYPE_DATA);
        assert.equal(forwarded.sourceSlot, 1);
        assert.deepEqual(forwarded.payload, gameplay);

        const resumed = await request(`/lobbies/${lobbyId}/join`, {
            method: "POST",
            body: JSON.stringify({
                protocol: 1, build: "public-relay-smoke-v1", platform: "pc",
                resume_token: joined.resume_token
            })
        });
        assert.equal(resumed.seat, joined.seat);
        assert.notEqual(resumed.resume_token, joined.resume_token);
        await bind(resumedClient);
        await send(resumedClient, encodeEnvelope(
            TYPE_BIND, sessionId, 0xffff, 0, Buffer.from(resumed.join_token)
        ), relay);
        const rebound = decodeEnvelope(await receive(resumedClient));
        assert.equal(rebound.type, TYPE_BOUND);
        assert.equal(rebound.sourceSlot, clientBound.sourceSlot);
        await send(resumedClient, encodeEnvelope(
            TYPE_DATA, sessionId, rebound.sourceSlot, 0,
            gameplayPacket(sessionId, rebound.sourceSlot)
        ), relay);
        const resumedForward = decodeEnvelope(await receive(host));
        assert.equal(resumedForward.type, TYPE_DATA);
        assert.equal(resumedForward.sourceSlot, rebound.sourceSlot);
        process.stdout.write(
            `public relay bind/resume smoke test passed via ${relay.address}:${relay.udp_port}\n`
        );
    } finally {
        host.close();
        client.close();
        resumedClient.close();
        if (lobbyId && hostSecret) {
            await request(`/lobbies/${lobbyId}`, {
                method: "DELETE",
                headers: { authorization: `Bearer ${hostSecret}` }
            }).catch(() => {});
        }
    }
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
});
