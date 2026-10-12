"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { MasterError, MasterService, MemoryLobbyStore } = require("../src/core");

function fixture() {
    const state = { now: 1_800_000_000 };
    const store = new MemoryLobbyStore();
    const service = new MasterService(store, Buffer.alloc(32, "t"), () => state.now);
    const registration = {
        name: "Desert Duel",
        protocol: 1,
        build: "pc-v0.3.0",
        platform: "pc",
        capabilities: 3,
        region: "us-central",
        max_players: 4,
        current_players: 1,
        udp_port: 30420
    };
    return { state, store, service, registration };
}

test("lobby lifecycle exposes only public fields", async () => {
    const { service, registration } = fixture();
    const result = await service.register(registration, "203.0.113.7");
    assert.match(result.session_id, /^[0-9a-f]{16}$/);
    assert.equal(result.lobby.host_ip, undefined);
    assert.equal(result.lobby.secret_hash, undefined);
    assert.equal((await service.listLobbies(1, "pc-v0.3.0")).length, 1);
    const auth = `Bearer ${result.host_secret}`;
    const updated = await service.heartbeat(result.lobby.id, auth, 2);
    assert.equal(updated.current_players, 2);
    await service.remove(result.lobby.id, auth);
    assert.deepEqual(await service.listLobbies(1, "pc-v0.3.0"), []);
});

test("expired lobbies are purged", async () => {
    const { state, store, service, registration } = fixture();
    await service.register(registration, "203.0.113.7");
    state.now += 91;
    assert.deepEqual(await service.listLobbies(1, "pc-v0.3.0"), []);
    assert.equal(store.items.size, 0);
});

test("join tokens are bound to a lobby and expire", async () => {
    const { state, service, registration } = fixture();
    const result = await service.register(registration, "203.0.113.7");
    const joined = await service.join(result.lobby.id, {
        protocol: 1,
        build: "pc-v0.3.0",
        platform: "vita"
    });
    assert.deepEqual(joined.host, { address: "203.0.113.7", udp_port: 30420 });
    assert.equal(joined.session_id, result.session_id);
    const auth = `Bearer ${result.host_secret}`;
    const payload = await service.validateJoinToken(result.lobby.id, auth, joined.join_token);
    assert.equal(payload.platform, "vita");
    assert.equal(payload.session, result.session_id);
    assert.equal(payload.protocol, 1);
    assert.equal(payload.build, registration.build);
    assert.equal(payload.role, "client");
    assert.equal(payload.max_players, 4);
    state.now += 31;
    await assert.rejects(
        service.validateJoinToken(result.lobby.id, auth, joined.join_token),
        (error) => error instanceof MasterError && error.code === "invalid_token"
    );
});

test("relay-only hosts need no public UDP port", async () => {
    const { store, state, registration } = fixture();
    const relay = { address: "relay.example", udp_port: 30420 };
    const service = new MasterService(store, Buffer.alloc(32, "t"), () => state.now, relay);
    const withoutPort = { ...registration };
    delete withoutPort.udp_port;
    const result = await service.register(withoutPort, "203.0.113.7");
    assert.deepEqual(result.relay, relay);
    assert.equal(typeof result.relay_token, "string");
    const joined = await service.join(result.lobby.id, {
        protocol: 1, build: registration.build, platform: "pc"
    });
    assert.equal(joined.host, null);
    assert.deepEqual(joined.relay, relay);
    const refreshed = await service.heartbeat(
        result.lobby.id, `Bearer ${result.host_secret}`, 1
    );
    assert.notEqual(refreshed.relay_token, result.relay_token);
});

test("invalid and full lobbies are rejected", async () => {
    const { service, registration } = fixture();
    await assert.rejects(
        service.register({ ...registration, max_players: 17 }, "203.0.113.7"),
        MasterError
    );
    const result = await service.register(registration, "203.0.113.7");
    const auth = `Bearer ${result.host_secret}`;
    await service.heartbeat(result.lobby.id, auth, 4);
    await assert.rejects(
        service.join(result.lobby.id, { protocol: 1, build: "pc-v0.3.0", platform: "pc" }),
        (error) => error instanceof MasterError && error.code === "lobby_full"
    );
});

test("all declared platforms and full capability mask are accepted", async () => {
    for (const platform of ["pc", "vita", "xbox", "xbox360", "ps3", "ps4", "ps5", "3ds"]) {
        const { service, registration } = fixture();
        const result = await service.register(
            { ...registration, platform, capabilities: 0xffffffff },
            "2001:db8::7"
        );
        assert.equal(result.lobby.platform, platform);
        assert.equal(result.lobby.capabilities, 0xffffffff);
    }
});
