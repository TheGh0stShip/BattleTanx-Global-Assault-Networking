"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const dgram = require("node:dgram");
const test = require("node:test");
const { MasterService, MemoryLobbyStore } = require("../../master/src/core");
const { RelayCore } = require("../src/core");
const {
    BROADCAST_SLOT, TYPE_BIND, TYPE_BOUND, TYPE_DATA, TYPE_ERROR,
    decodeEnvelope, encodeEnvelope
} = require("../src/protocol");
const { createRelayServer } = require("../src/server");

const SECRET = "relay-test-secret-is-at-least-32-bytes-long";
const NOW = 1_800_000_000;

function remote(port) {
    return { address: "127.0.0.1", port, family: "IPv4" };
}

function innerDatagram(sessionId, peerId = 0) {
    const packet = Buffer.alloc(32);
    packet.writeUInt32BE(0x42544741, 0);
    packet.writeUInt16BE(1, 4);
    packet[6] = 8;
    packet[7] = 4;
    packet.writeBigUInt64BE(sessionId, 8);
    packet.writeUInt16BE(peerId, 30);
    return packet;
}

async function credentials() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const service = new MasterService(
        new MemoryLobbyStore(), Buffer.from(SECRET), () => NOW,
        { address: "relay.example", udp_port: 30420 }, privateKey
    );
    const registration = await service.register({
        name: "Relay test", protocol: 1, build: "test", platform: "pc",
        capabilities: 2, region: "local", max_players: 4,
        current_players: 1, udp_port: 30420
    }, "203.0.113.1");
    const joined = await service.join(registration.lobby.id, {
        protocol: 1, build: "test", platform: "vita"
    });
    return {
        sessionId: BigInt(`0x${registration.session_id}`),
        hostToken: registration.relay_token,
        clientToken: joined.join_token,
        privateKey,
        publicKey
    };
}

test("relay binds signed peers and enforces authority topology", async () => {
    const auth = await credentials();
    const core = new RelayCore(auth.publicKey, { clock: () => NOW });
    const host = remote(40000);
    const client = remote(40001);
    const stranger = remote(40002);
    let result = core.handle(encodeEnvelope(
        TYPE_BIND, auth.sessionId, 0xffff, 0, Buffer.from(auth.hostToken)
    ), host);
    assert.equal(decodeEnvelope(result[0].packet).type, TYPE_BOUND);
    assert.equal(decodeEnvelope(result[0].packet).sourceSlot, 0);
    result = core.handle(encodeEnvelope(
        TYPE_BIND, auth.sessionId, 0xffff, 0, Buffer.from(auth.clientToken)
    ), client);
    assert.equal(decodeEnvelope(result[0].packet).sourceSlot, 1);

    const gameplay = innerDatagram(auth.sessionId, 1);
    result = core.handle(encodeEnvelope(TYPE_DATA, auth.sessionId, 1, 0, gameplay), client);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].remote, host);
    assert.deepEqual(decodeEnvelope(result[0].packet).payload, gameplay);
    assert.deepEqual(core.handle(
        encodeEnvelope(TYPE_DATA, auth.sessionId, 1, 0, gameplay), stranger
    ), []);
    assert.deepEqual(core.handle(
        encodeEnvelope(TYPE_DATA, auth.sessionId, 1, BROADCAST_SLOT, gameplay), client
    ), []);
    gameplay.writeUInt16BE(2, 30);
    assert.deepEqual(core.handle(
        encodeEnvelope(TYPE_DATA, auth.sessionId, 1, 0, gameplay), client
    ), []);
});

test("authority slot zero admits four independent player clients", async () => {
    const auth = await credentials();
    const core = new RelayCore(auth.publicKey, { clock: () => NOW });
    const host = remote(40500);
    let result = core.handle(encodeEnvelope(
        TYPE_BIND, auth.sessionId, 0xffff, 0, Buffer.from(auth.hostToken)
    ), host);
    assert.equal(decodeEnvelope(result[0].packet).sourceSlot, 0);

    for (let player = 0; player < 4; ++player) {
        const service = new MasterService(
            new MemoryLobbyStore(), Buffer.from(SECRET), () => NOW, null,
            auth.privateKey
        );
        const token = service.issueAdmissionToken({
            session: auth.sessionId.toString(16).padStart(16, "0"),
            protocol: 1, role: "client", max_players: 4,
            expires: NOW + 90, nonce: player.toString(16).padStart(16, "0")
        });
        result = core.handle(encodeEnvelope(
            TYPE_BIND, auth.sessionId, 0xffff, 0, Buffer.from(token)
        ), remote(40501 + player));
        assert.equal(decodeEnvelope(result[0].packet).type, TYPE_BOUND);
        assert.equal(decodeEnvelope(result[0].packet).sourceSlot, player + 1);
    }

    const service = new MasterService(
        new MemoryLobbyStore(), Buffer.from(SECRET), () => NOW, null,
        auth.privateKey
    );
    const overflowToken = service.issueAdmissionToken({
        session: auth.sessionId.toString(16).padStart(16, "0"),
        protocol: 1, role: "client", max_players: 4,
        expires: NOW + 90, nonce: "ffffffffffffffff"
    });
    result = core.handle(encodeEnvelope(
        TYPE_BIND, auth.sessionId, 0xffff, 0, Buffer.from(overflowToken)
    ), remote(40505));
    assert.equal(decodeEnvelope(result[0].packet).type, TYPE_ERROR);
    assert.equal(decodeEnvelope(result[0].packet).payload.toString("ascii"), "FULL");
});

test("invalid and replayed admission tokens cannot redirect traffic", async () => {
    const auth = await credentials();
    const core = new RelayCore(auth.publicKey, { clock: () => NOW });
    core.handle(encodeEnvelope(
        TYPE_BIND, auth.sessionId, 0xffff, 0, Buffer.from(auth.hostToken)
    ), remote(41000));
    const replay = core.handle(encodeEnvelope(
        TYPE_BIND, auth.sessionId, 0xffff, 0, Buffer.from(auth.hostToken)
    ), remote(41001));
    assert.equal(decodeEnvelope(replay[0].packet).type, TYPE_ERROR);
    assert.equal(decodeEnvelope(replay[0].packet).payload.toString("ascii"), "REPLAY");
    // Always change the signature text. For 64-byte Ed25519 signatures some
    // last-character substitutions alter only unused base64url bits; the
    // relay must reject those noncanonical aliases as well as changed bytes.
    const replacement = auth.clientToken.endsWith("A") ? "B" : "A";
    const tampered = `${auth.clientToken.slice(0, -1)}${replacement}`;
    const denied = core.handle(encodeEnvelope(
        TYPE_BIND, auth.sessionId, 0xffff, 0, Buffer.from(tampered)
    ), remote(41001));
    assert.deepEqual(denied, []);
});

test("global egress bucket bounds authenticated relay traffic", async () => {
    const auth = await credentials();
    const core = new RelayCore(auth.publicKey, {
        clock: () => NOW,
        egressBytesPerSecond: 1
    });
    const host = remote(41500);
    const client = remote(41501);
    core.handle(encodeEnvelope(
        TYPE_BIND, auth.sessionId, 0xffff, 0, Buffer.from(auth.hostToken)
    ), host);
    core.handle(encodeEnvelope(
        TYPE_BIND, auth.sessionId, 0xffff, 0, Buffer.from(auth.clientToken)
    ), client);
    const gameplay = innerDatagram(auth.sessionId, 1);
    assert.deepEqual(core.handle(
        encodeEnvelope(TYPE_DATA, auth.sessionId, 1, 0, gameplay), client
    ), []);
    assert.equal(core.metrics.forwarded, 0);
});

test("a refreshed signed authority token can replace a changed NAT mapping", async () => {
    const auth = await credentials();
    const core = new RelayCore(auth.publicKey, { clock: () => NOW });
    core.handle(encodeEnvelope(
        TYPE_BIND, auth.sessionId, 0xffff, 0, Buffer.from(auth.hostToken)
    ), remote(42000));
    const service = new MasterService(
        new MemoryLobbyStore(), Buffer.from(SECRET), () => NOW, null,
        auth.privateKey
    );
    const replacementToken = service.issueAdmissionToken({
        session: auth.sessionId.toString(16).padStart(16, "0"),
        protocol: 1, role: "authority", max_players: 4,
        expires: NOW + 90, nonce: "0123456789abcdef"
    });
    const rebound = core.handle(encodeEnvelope(
        TYPE_BIND, auth.sessionId, 0xffff, 0, Buffer.from(replacementToken)
    ), remote(42001));
    assert.equal(decodeEnvelope(rebound[0].packet).sourceSlot, 0);
    assert.equal(core.endpoints.has("IPv4|127.0.0.1|42000"), false);
    assert.equal(core.endpoints.has("IPv4|127.0.0.1|42001"), true);
});

test("a fresh signed token resumes the same stable player seat", async () => {
    const auth = await credentials();
    const core = new RelayCore(auth.publicKey, { clock: () => NOW });
    const authority = remote(42100);
    core.handle(encodeEnvelope(
        TYPE_BIND, auth.sessionId, 0xffff, 0, Buffer.from(auth.hostToken)
    ), authority);
    const service = new MasterService(
        new MemoryLobbyStore(), Buffer.from(SECRET), () => NOW, null,
        auth.privateKey
    );
    const token = (nonce) => service.issueAdmissionToken({
        session: auth.sessionId.toString(16).padStart(16, "0"),
        protocol: 1, role: "client", seat: 2, max_players: 4,
        expires: NOW + 90, nonce
    });
    const oldRemote = remote(42101);
    let result = core.handle(encodeEnvelope(
        TYPE_BIND, auth.sessionId, 0xffff, 0,
        Buffer.from(token("1111111111111111"))
    ), oldRemote);
    assert.equal(decodeEnvelope(result[0].packet).sourceSlot, 3);

    const newRemote = remote(42102);
    result = core.handle(encodeEnvelope(
        TYPE_BIND, auth.sessionId, 0xffff, 0,
        Buffer.from(token("2222222222222222"))
    ), newRemote);
    assert.equal(decodeEnvelope(result[0].packet).sourceSlot, 3);
    assert.equal(core.endpoints.has("IPv4|127.0.0.1|42101"), false);
    assert.equal(core.endpoints.has("IPv4|127.0.0.1|42102"), true);

    const gameplay = innerDatagram(auth.sessionId, 3);
    assert.equal(core.handle(
        encodeEnvelope(TYPE_DATA, auth.sessionId, 3, 0, gameplay), oldRemote
    ).length, 0);
    result = core.handle(
        encodeEnvelope(TYPE_DATA, auth.sessionId, 3, 0, gameplay), newRemote
    );
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].remote, authority);
});

test("seat claims outside the four-player session are rejected", async () => {
    const auth = await credentials();
    const core = new RelayCore(auth.publicKey, { clock: () => NOW });
    core.handle(encodeEnvelope(
        TYPE_BIND, auth.sessionId, 0xffff, 0, Buffer.from(auth.hostToken)
    ), remote(42200));
    const service = new MasterService(
        new MemoryLobbyStore(), Buffer.from(SECRET), () => NOW, null,
        auth.privateKey
    );
    for (const seat of [-1, 4]) {
        const token = service.issueAdmissionToken({
            session: auth.sessionId.toString(16).padStart(16, "0"),
            protocol: 1, role: "client", seat, max_players: 4,
            expires: NOW + 90,
            nonce: (seat + 2).toString(16).padStart(16, "0")
        });
        assert.deepEqual(core.handle(encodeEnvelope(
            TYPE_BIND, auth.sessionId, 0xffff, 0, Buffer.from(token)
        ), remote(42210 + seat)), []);
    }
});

function bindSocket(socket) {
    return new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
}

function receive(socket) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("UDP receive timeout")), 2000);
        socket.once("message", (packet) => {
            clearTimeout(timer);
            resolve(packet);
        });
    });
}

function send(socket, packet, relayPort) {
    return new Promise((resolve, reject) => {
        socket.send(packet, relayPort, "127.0.0.1", (error) => error ? reject(error) : resolve());
    });
}

test("two real UDP sockets exchange a gameplay datagram through the relay", async (t) => {
    const auth = await credentials();
    const relay = createRelayServer({
        publicKey: auth.publicKey, type: "udp4", clock: () => NOW
    });
    const host = dgram.createSocket("udp4");
    const client = dgram.createSocket("udp4");
    t.after(() => relay.socket.close());
    t.after(() => host.close());
    t.after(() => client.close());
    await Promise.all([bindSocket(host), bindSocket(client), bindSocket(relay.socket)]);
    const relayPort = relay.socket.address().port;

    await send(host, encodeEnvelope(
        TYPE_BIND, auth.sessionId, 0xffff, 0, Buffer.from(auth.hostToken)
    ), relayPort);
    assert.equal(decodeEnvelope(await receive(host)).sourceSlot, 0);
    await send(client, encodeEnvelope(
        TYPE_BIND, auth.sessionId, 0xffff, 0, Buffer.from(auth.clientToken)
    ), relayPort);
    assert.equal(decodeEnvelope(await receive(client)).sourceSlot, 1);

    const gameplay = innerDatagram(auth.sessionId, 1);
    await send(client, encodeEnvelope(TYPE_DATA, auth.sessionId, 1, 0, gameplay), relayPort);
    const forwarded = decodeEnvelope(await receive(host));
    assert.equal(forwarded.type, TYPE_DATA);
    assert.equal(forwarded.sourceSlot, 1);
    assert.deepEqual(forwarded.payload, gameplay);
});
