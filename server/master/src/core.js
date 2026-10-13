"use strict";

const crypto = require("node:crypto");
const net = require("node:net");

const PROTOCOL_VERSION = 1;
const MAX_PLAYERS = 4;
const LOBBY_TTL_SECONDS = 90;
const JOIN_TOKEN_TTL_SECONDS = 30;
const MAX_NAME_LENGTH = 48;
const MAX_BUILD_LENGTH = 64;
const VALID_PLATFORMS = new Set([
    "pc", "vita", "xbox", "xbox360", "ps3", "ps4", "ps5", "3ds"
]);
const BUILD_PATTERN = /^[A-Za-z0-9._+-]{1,64}$/;
const VALID_STATES = new Set(["lobby", "playing"]);

class MasterError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = "MasterError";
        this.status = status;
        this.code = code;
    }
}

class MemoryLobbyStore {
    constructor() {
        this.items = new Map();
    }

    async put(lobby) {
        this.items.set(lobby.id, structuredClone(lobby));
    }

    async get(lobbyId) {
        const item = this.items.get(lobbyId);
        return item === undefined ? null : structuredClone(item);
    }

    async delete(lobbyId) {
        this.items.delete(lobbyId);
    }

    async list() {
        return Array.from(this.items.values(), (item) => structuredClone(item));
    }
}

function integer(data, name, minimum, maximum) {
    const value = data[name];
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new MasterError(
            400,
            "invalid_field",
            `${name} must be an integer from ${minimum} to ${maximum}`
        );
    }
    return value;
}

function text(data, name, maximum) {
    const source = data[name];
    if (typeof source !== "string") {
        throw new MasterError(400, "invalid_field", `${name} must be text`);
    }
    const value = source.normalize("NFC").trim();
    if (!value || value.length > maximum ||
        /[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
        throw new MasterError(
            400,
            "invalid_field",
            `${name} is empty, too long, or contains controls`
        );
    }
    return value;
}

function constantTimeEqual(left, right) {
    const a = Buffer.from(left, "utf8");
    const b = Buffer.from(right, "utf8");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

class MasterService {
    constructor(store, secretKey, clock = () => Date.now() / 1000,
                relayEndpoint = null, relayPrivateKey) {
        this.store = store;
        this.secretKey = Buffer.from(secretKey);
        this.clock = clock;
        this.relayEndpoint = relayEndpoint;
        this.relayPrivateKey = relayPrivateKey;
        if (this.secretKey.length < 32) {
            throw new Error("secretKey must contain at least 32 bytes");
        }
        if (!this.relayPrivateKey || this.relayPrivateKey.type !== "private" ||
            this.relayPrivateKey.asymmetricKeyType !== "ed25519") {
            throw new Error("relayPrivateKey must be an Ed25519 private key");
        }
        this.relayPublicKey = crypto.createPublicKey(this.relayPrivateKey);
    }

    issueAdmissionToken(payload) {
        const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
        const signature = crypto.sign(
            null, Buffer.from(encoded, "ascii"), this.relayPrivateKey
        ).toString("base64url");
        return `${encoded}.${signature}`;
    }

    issueAuthorityRelayToken(lobby) {
        return this.issueAdmissionToken({
            lobby: lobby.id,
            session: lobby.session_id,
            protocol: lobby.protocol,
            build: lobby.build,
            platform: lobby.platform,
            role: "authority",
            max_players: lobby.max_players,
            expires: lobby.expires_at,
            nonce: crypto.randomBytes(8).toString("hex")
        });
    }

    // Compatibility alias for callers migrating from the peer-host design.
    issueHostRelayToken(lobby) {
        return this.issueAuthorityRelayToken(lobby);
    }

    secretHash(lobbyId, secret) {
        return crypto
            .createHmac("sha256", this.secretKey)
            .update(`host:${lobbyId}:${secret}`)
            .digest("hex");
    }

    authenticate(lobby, bearer) {
        if (typeof bearer !== "string" || !bearer.startsWith("Bearer ")) {
            throw new MasterError(401, "unauthorized", "a host bearer credential is required");
        }
        const candidate = this.secretHash(lobby.id, bearer.slice(7));
        if (!constantTimeEqual(candidate, lobby.secret_hash)) {
            throw new MasterError(403, "forbidden", "the host credential is invalid");
        }
    }

    static publicLobby(lobby) {
        const result = {};
        for (const key of [
            "id", "name", "protocol", "build", "platform", "capabilities", "region",
            "max_players", "current_players", "state", "expires_at"
        ]) {
            result[key] = lobby[key];
        }
        return result;
    }

    async register(data, observedIp) {
        if (net.isIP(observedIp) === 0) {
            throw new MasterError(400, "invalid_address", "the observed client address is invalid");
        }
        const protocol = integer(data, "protocol", PROTOCOL_VERSION, PROTOCOL_VERSION);
        const build = text(data, "build", MAX_BUILD_LENGTH);
        if (!BUILD_PATTERN.test(build)) {
            throw new MasterError(400, "invalid_field", "build contains unsupported characters");
        }
        const platform = text(data, "platform", 16).toLowerCase();
        if (!VALID_PLATFORMS.has(platform)) {
            throw new MasterError(400, "invalid_field", "platform is not supported");
        }
        const maxPlayers = integer(data, "max_players", 1, MAX_PLAYERS);
        const currentPlayers = integer(data, "current_players", 1, maxPlayers);
        const udpPort = data.udp_port === undefined
            ? 0 : integer(data, "udp_port", 1, 65535);
        const now = Math.floor(this.clock());
        const lobbyId = crypto.randomBytes(12).toString("base64url");
        const hostSecret = crypto.randomBytes(32).toString("base64url");
        const lobby = {
            id: lobbyId,
            name: text(data, "name", MAX_NAME_LENGTH),
            protocol,
            build,
            platform,
            capabilities: integer(data, "capabilities", 0, 0xffffffff),
            region: text(data, "region", 24),
            max_players: maxPlayers,
            current_players: currentPlayers,
            state: data.state === undefined ? "lobby" : text(data, "state", 16).toLowerCase(),
            host_ip: observedIp,
            udp_port: udpPort,
            session_id: crypto.randomBytes(8).toString("hex"),
            secret_hash: this.secretHash(lobbyId, hostSecret),
            expires_at: now + LOBBY_TTL_SECONDS,
            updated_at: now
        };
        if (!VALID_STATES.has(lobby.state)) {
            throw new MasterError(400, "invalid_field", "state must be lobby or playing");
        }
        await this.store.put(lobby);
        return {
            lobby: MasterService.publicLobby(lobby),
            host_secret: hostSecret,
            session_id: lobby.session_id,
            relay: this.relayEndpoint,
            relay_token: this.issueAuthorityRelayToken(lobby)
        };
    }

    async listLobbies(protocol, build) {
        const now = Math.floor(this.clock());
        const result = [];
        for (const lobby of await this.store.list()) {
            if (lobby.expires_at <= now) {
                await this.store.delete(lobby.id);
            } else if (lobby.protocol === protocol && lobby.build === build) {
                result.push(MasterService.publicLobby(lobby));
            }
        }
        result.sort((a, b) => b.current_players - a.current_players || a.id.localeCompare(b.id));
        return result;
    }

    async publicSnapshot() {
        const now = Math.floor(this.clock());
        const lobbies = [];
        for (const lobby of await this.store.list()) {
            if (lobby.expires_at <= now) {
                await this.store.delete(lobby.id);
                continue;
            }
            const publicLobby = MasterService.publicLobby(lobby);
            if (publicLobby.state === undefined) publicLobby.state = "lobby";
            lobbies.push(publicLobby);
        }
        lobbies.sort((a, b) => b.current_players - a.current_players || a.id.localeCompare(b.id));
        return {
            generated_at: now,
            games: lobbies.filter((lobby) => lobby.state === "playing").length,
            open_lobbies: lobbies.filter((lobby) => lobby.state !== "playing").length,
            players: lobbies.reduce((total, lobby) => total + lobby.current_players, 0),
            sessions: lobbies
        };
    }

    async heartbeat(lobbyId, bearer, currentPlayers, state) {
        const lobby = await this.store.get(lobbyId);
        if (lobby === null) {
            throw new MasterError(404, "not_found", "lobby not found");
        }
        this.authenticate(lobby, bearer);
        if (!Number.isInteger(currentPlayers) || currentPlayers < 1 || currentPlayers > lobby.max_players) {
            throw new MasterError(400, "invalid_field", "current_players is outside the lobby limit");
        }
        const now = Math.floor(this.clock());
        lobby.current_players = currentPlayers;
        if (state !== undefined) {
            if (typeof state !== "string" || !VALID_STATES.has(state.toLowerCase())) {
                throw new MasterError(400, "invalid_field", "state must be lobby or playing");
            }
            lobby.state = state.toLowerCase();
        } else if (lobby.state === undefined) {
            lobby.state = "lobby";
        }
        lobby.updated_at = now;
        lobby.expires_at = now + LOBBY_TTL_SECONDS;
        await this.store.put(lobby);
        return {
            ...MasterService.publicLobby(lobby),
            relay_token: this.issueAuthorityRelayToken(lobby)
        };
    }

    async remove(lobbyId, bearer) {
        const lobby = await this.store.get(lobbyId);
        if (lobby === null) {
            return;
        }
        this.authenticate(lobby, bearer);
        await this.store.delete(lobbyId);
    }

    async join(lobbyId, data) {
        const lobby = await this.store.get(lobbyId);
        const now = Math.floor(this.clock());
        if (lobby === null || lobby.expires_at <= now) {
            throw new MasterError(404, "not_found", "lobby not found");
        }
        if (lobby.current_players >= lobby.max_players) {
            throw new MasterError(409, "lobby_full", "lobby is full");
        }
        if (
            integer(data, "protocol", PROTOCOL_VERSION, PROTOCOL_VERSION) !== lobby.protocol ||
            text(data, "build", MAX_BUILD_LENGTH) !== lobby.build
        ) {
            throw new MasterError(409, "incompatible", "client build is incompatible");
        }
        const platform = text(data, "platform", 16).toLowerCase();
        if (!VALID_PLATFORMS.has(platform)) {
            throw new MasterError(400, "invalid_field", "platform is not supported");
        }
        const payload = {
            lobby: lobbyId,
            session: lobby.session_id,
            protocol: lobby.protocol,
            build: lobby.build,
            platform,
            role: "client",
            max_players: lobby.max_players,
            expires: now + JOIN_TOKEN_TTL_SECONDS,
            nonce: crypto.randomBytes(8).toString("hex")
        };
        return {
            host: lobby.udp_port === 0
                ? null : { address: lobby.host_ip, udp_port: lobby.udp_port },
            relay: this.relayEndpoint,
            session_id: lobby.session_id,
            join_token: this.issueAdmissionToken(payload),
            expires_at: payload.expires
        };
    }

    async validateJoinToken(lobbyId, bearer, token) {
        const lobby = await this.store.get(lobbyId);
        if (lobby === null) {
            throw new MasterError(404, "not_found", "lobby not found");
        }
        this.authenticate(lobby, bearer);
        try {
            const parts = token.split(".");
            if (parts.length !== 2) {
                throw new Error("invalid token parts");
            }
            const [encoded, suppliedSignature] = parts;
            const signature = Buffer.from(suppliedSignature, "base64url");
            if (signature.length !== 64 || !crypto.verify(
                null, Buffer.from(encoded, "ascii"), this.relayPublicKey, signature
            )) {
                throw new Error("invalid token signature");
            }
            const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
            if (
                payload.lobby !== lobbyId ||
                payload.session !== lobby.session_id ||
                payload.role !== "client" ||
                !Number.isInteger(payload.expires) ||
                payload.expires < Math.floor(this.clock())
            ) {
                throw new Error("invalid token claims");
            }
            return payload;
        } catch (error) {
            if (error instanceof MasterError) {
                throw error;
            }
            throw new MasterError(403, "invalid_token", "join token is invalid or expired");
        }
    }
}

module.exports = {
    BUILD_PATTERN,
    JOIN_TOKEN_TTL_SECONDS,
    LOBBY_TTL_SECONDS,
    MAX_PLAYERS,
    MasterError,
    MasterService,
    MemoryLobbyStore,
    PROTOCOL_VERSION,
    VALID_PLATFORMS
};
