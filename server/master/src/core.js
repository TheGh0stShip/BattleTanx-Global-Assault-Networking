"use strict";

const crypto = require("node:crypto");
const net = require("node:net");

const PROTOCOL_VERSION = 1;
const MAX_PLAYERS = 4;
// Must remain aligned with BTGA_NET_CAP_DEDICATED_AUTHORITY in btga_net.h.
const CAP_DEDICATED_AUTHORITY = 1 << 5;
const LOBBY_TTL_SECONDS = 90;
const JOIN_TOKEN_TTL_SECONDS = 30;
const SEAT_LEASE_TTL_SECONDS = 10 * 60;
// Join is anonymous, so a new seat is only provisional. It becomes a full
// lease when the authority's heartbeat reports that seat in `seat_mask`.
const PROVISIONAL_SEAT_TTL_SECONDS = 60;
// An unconfirmed seat older than this may be reassigned to a new joiner. It
// exceeds the 15-second authority heartbeat plus relay binding time.
const PROVISIONAL_EVICTION_SECONDS = 30;
// One household NAT must be able to place every supported player into the
// same lobby. A further join from that address replaces its oldest provisional
// seat; the 30-second stale takeover and 60-second expiry still bound abuse.
const PROVISIONAL_SEATS_PER_SOURCE = MAX_PLAYERS;
const RESUME_TOKEN_TTL_SECONDS = 24 * 60 * 60;
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

// A compare-and-swap must name a concrete version. Azure's SDK turns a missing
// etag into "*" (an unconditional write), so both stores fail closed instead.
function validEtag(etag) {
    return typeof etag === "string" && etag !== "" && etag !== "*";
}

class MemoryLobbyStore {
    constructor() {
        this.items = new Map();
        this.versions = new Map();
    }

    async put(lobby) {
        const version = (this.versions.get(lobby.id) || 0) + 1;
        this.versions.set(lobby.id, version);
        const copy = structuredClone(lobby);
        delete copy._etag;
        this.items.set(lobby.id, copy);
    }

    async get(lobbyId) {
        const item = this.items.get(lobbyId);
        if (item === undefined) return null;
        const copy = structuredClone(item);
        copy._etag = String(this.versions.get(lobbyId));
        return copy;
    }

    async compareAndSwap(lobby, etag) {
        if (!validEtag(etag)) return false;
        if (String(this.versions.get(lobby.id)) !== etag) return false;
        await this.put(lobby);
        return true;
    }

    async delete(lobbyId) {
        this.items.delete(lobbyId);
        this.versions.delete(lobbyId);
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

function seatLeases(lobby, now) {
    let parsed;
    try {
        parsed = JSON.parse(lobby.seat_leases_json || "[]");
    } catch {
        parsed = null;
    }
    // Unreadable reservations must not turn into "every seat is free".
    if (!Array.isArray(parsed)) {
        throw new MasterError(503, "lobby_state_invalid", "lobby seat state is unreadable");
    }
    return parsed.filter((lease) =>
        lease && Number.isInteger(lease.seat) && lease.seat >= 0 &&
        lease.seat < lobby.max_players && typeof lease.id === "string" &&
        /^[0-9a-f]{32}$/.test(lease.id) && Number.isInteger(lease.expires) &&
        lease.expires > now
    ).map((lease) => ({
        seat: lease.seat,
        id: lease.id,
        expires: lease.expires,
        // Leases written before confirmation existed were full leases.
        confirmed: lease.confirmed !== false,
        issued: Number.isInteger(lease.issued) ? lease.issued : 0,
        source: typeof lease.source === "string" ? lease.source : ""
    }));
}

function leaseSequence(lobby) {
    return Number.isSafeInteger(lobby.lease_seq) && lobby.lease_seq >= 0 ? lobby.lease_seq : 0;
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
        const capabilities = integer(data, "capabilities", 0, 0xffffffff);
        // A peer host occupies a player seat; a headless authority does not.
        // Its seat_mask heartbeat is the source of truth for actual players.
        const minimumPlayers = (capabilities & CAP_DEDICATED_AUTHORITY) !== 0 ? 0 : 1;
        const reportedPlayers = integer(
            data, "current_players", minimumPlayers, maxPlayers);
        // The authority process itself never consumes a seat. Accept an older
        // authority that still reports itself as player one, but normalize the
        // public value to zero. This keeps master-first deployments compatible
        // while seat_mask remains the sole source of truth after registration.
        const currentPlayers = (capabilities & CAP_DEDICATED_AUTHORITY) !== 0
            ? 0 : reportedPlayers;
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
            capabilities,
            region: text(data, "region", 24),
            max_players: maxPlayers,
            current_players: currentPlayers,
            state: data.state === undefined ? "lobby" : text(data, "state", 16).toLowerCase(),
            host_ip: observedIp,
            udp_port: udpPort,
            session_id: crypto.randomBytes(8).toString("hex"),
            secret_hash: this.secretHash(lobbyId, hostSecret),
            expires_at: now + LOBBY_TTL_SECONDS,
            updated_at: now,
            seat_leases_json: "[]"
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

    sourceTag(observedIp) {
        return crypto.createHmac("sha256", this.secretKey)
            .update(`source:${observedIp}`).digest("hex").slice(0, 16);
    }

    async heartbeat(lobbyId, bearer, currentPlayers, state, seatMask) {
        for (let attempt = 0; attempt < 8; ++attempt) {
            const lobby = await this.store.get(lobbyId);
            if (lobby === null) {
                throw new MasterError(404, "not_found", "lobby not found");
            }
            this.authenticate(lobby, bearer);
            const minimumPlayers =
                (lobby.capabilities & CAP_DEDICATED_AUTHORITY) !== 0 ? 0 : 1;
            if (!Number.isInteger(currentPlayers) || currentPlayers < minimumPlayers ||
                currentPlayers > lobby.max_players) {
                throw new MasterError(
                    400, "invalid_field", "current_players is outside the lobby limit");
            }
            const now = Math.floor(this.clock());
            if (state !== undefined) {
                if (typeof state !== "string" || !VALID_STATES.has(state.toLowerCase())) {
                    throw new MasterError(
                        400, "invalid_field", "state must be lobby or playing");
                }
                lobby.state = state.toLowerCase();
            } else if (lobby.state === undefined) {
                lobby.state = "lobby";
            }
            if (seatMask !== undefined) {
                if (!Number.isInteger(seatMask) || seatMask < 0 ||
                    seatMask >= (1 << lobby.max_players)) {
                    throw new MasterError(
                        400, "invalid_field", "seat_mask is outside the lobby seats");
                }
                // Only seats the authority reports connected are renewed. A
                // seat absent from the mask keeps its remaining lease, which is
                // the window in which its player may resume.
                lobby.seat_leases_json = JSON.stringify(seatLeases(lobby, now).map((lease) =>
                    (seatMask & (1 << lease.seat)) === 0 ? lease : {
                        ...lease, confirmed: true, expires: now + SEAT_LEASE_TTL_SECONDS
                    }));
                lobby.seat_mask_seen = true;
            }
            let authoritativePlayers = currentPlayers;
            if ((lobby.capabilities & CAP_DEDICATED_AUTHORITY) !== 0) {
                if (seatMask === undefined) {
                    throw new MasterError(
                        400, "invalid_field", "a dedicated authority heartbeat needs seat_mask");
                }
                authoritativePlayers = 0;
                for (let mask = seatMask; mask !== 0; mask >>>= 1) {
                    authoritativePlayers += mask & 1;
                }
            }
            lobby.current_players = authoritativePlayers;
            lobby.updated_at = now;
            lobby.expires_at = now + LOBBY_TTL_SECONDS;
            if (!await this.store.compareAndSwap(lobby, lobby._etag)) continue;
            return {
                ...MasterService.publicLobby(lobby),
                relay_token: this.issueAuthorityRelayToken(lobby)
            };
        }
        throw new MasterError(409, "heartbeat_race", "lobby changed; retry the heartbeat");
    }

    async remove(lobbyId, bearer) {
        const lobby = await this.store.get(lobbyId);
        if (lobby === null) {
            return;
        }
        this.authenticate(lobby, bearer);
        await this.store.delete(lobbyId);
    }

    // `observedIp` is the caller address seen by the HTTP front end. When it is
    // supplied, it bounds how many unconfirmed seats one address can hold.
    async join(lobbyId, data, observedIp) {
        const now = Math.floor(this.clock());
        const requestedResume = data.resume_token;
        if (requestedResume !== undefined &&
            (typeof requestedResume !== "string" || requestedResume.length > 1024)) {
            throw new MasterError(400, "invalid_field", "resume_token is invalid");
        }
        for (let attempt = 0; attempt < 8; ++attempt) {
            const lobby = await this.store.get(lobbyId);
            if (lobby === null || lobby.expires_at <= now) {
                throw new MasterError(404, "not_found", "lobby not found");
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
            const leases = seatLeases(lobby, now);
            const source = observedIp === undefined ? "" : this.sourceTag(observedIp);
            // Lobbies whose authority has never sent seat_mask keep the
            // original full-length leases so active players are not evicted.
            const strict = lobby.seat_mask_seen === true;
            let seat = -1;
            let previous;
            if (requestedResume !== undefined) {
                const claims = this.verifyResumeToken(requestedResume, lobby, now);
                previous = leases.find((candidate) =>
                    candidate.seat === claims.seat && candidate.id === claims.lease);
                if (!previous) {
                    throw new MasterError(409, "resume_expired", "the player seat is no longer reserved");
                }
                seat = claims.seat;
            } else {
                if (lobby.current_players >= lobby.max_players) {
                    throw new MasterError(409, "lobby_full", "lobby is full");
                }
                const unconfirmed = strict
                    ? leases.filter((lease) => !lease.confirmed)
                    : [];
                const own = source === "" ? [] : unconfirmed
                    .filter((lease) => lease.source === source)
                    .sort((a, b) => a.issued - b.issued || a.seat - b.seat);
                if (own.length < PROVISIONAL_SEATS_PER_SOURCE) {
                    for (let candidate = 0; candidate < lobby.max_players; ++candidate) {
                        if (!leases.some((lease) => lease.seat === candidate)) {
                            seat = candidate;
                            break;
                        }
                    }
                }
                if (seat < 0) {
                    const stale = unconfirmed
                        .filter((lease) => now - lease.issued >= PROVISIONAL_EVICTION_SECONDS)
                        .sort((a, b) => a.issued - b.issued || a.seat - b.seat)[0];
                    if (stale === undefined) {
                        throw new MasterError(409, "lobby_full", "lobby is full");
                    }
                    seat = stale.seat;
                }
            }
            const leaseId = crypto.randomBytes(16).toString("hex");
            const sequence = leaseSequence(lobby) + 1;
            const renewed = leases.filter((lease) => lease.seat !== seat);
            const confirmed = previous !== undefined ? previous.confirmed : !strict;
            let expires = now + (strict ? PROVISIONAL_SEAT_TTL_SECONDS : SEAT_LEASE_TTL_SECONDS);
            let issued = now;
            if (previous !== undefined && strict) {
                // Resuming never extends an unconfirmed seat or restarts its
                // eviction clock; otherwise repeated resumes could hold it.
                expires = confirmed
                    ? Math.max(previous.expires, now + PROVISIONAL_SEAT_TTL_SECONDS)
                    : previous.expires;
                issued = confirmed ? now : previous.issued;
            }
            renewed.push({ seat, id: leaseId, expires, confirmed, issued, source });
            lobby.seat_leases_json = JSON.stringify(renewed);
            lobby.lease_seq = sequence;
            if (!await this.store.compareAndSwap(lobby, lobby._etag)) continue;
            const payload = {
                lobby: lobbyId, session: lobby.session_id, protocol: lobby.protocol,
                build: lobby.build, platform, role: "client", seat, lease_seq: sequence,
                max_players: lobby.max_players, expires: now + JOIN_TOKEN_TTL_SECONDS,
                nonce: crypto.randomBytes(8).toString("hex")
            };
            const resume = {
                lobby: lobbyId, session: lobby.session_id, role: "resume", seat,
                lease: leaseId, expires: now + RESUME_TOKEN_TTL_SECONDS
            };
            return {
                host: lobby.udp_port === 0
                    ? null : { address: lobby.host_ip, udp_port: lobby.udp_port },
                relay: this.relayEndpoint,
                session_id: lobby.session_id,
                seat,
                join_token: this.issueAdmissionToken(payload),
                resume_token: this.issueAdmissionToken(resume),
                expires_at: payload.expires
            };
        }
        throw new MasterError(409, "join_race", "seat allocation changed; retry the request");
    }

    verifyResumeToken(token, lobby, now) {
        try {
            const parts = token.split(".");
            if (parts.length !== 2) throw new Error("invalid token parts");
            const [encoded, suppliedSignature] = parts;
            const signature = Buffer.from(suppliedSignature, "base64url");
            if (signature.length !== 64 || !crypto.verify(
                null, Buffer.from(encoded, "ascii"), this.relayPublicKey, signature
            )) throw new Error("invalid signature");
            const claims = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
            if (claims.lobby !== lobby.id || claims.session !== lobby.session_id ||
                claims.role !== "resume" || !Number.isInteger(claims.seat) ||
                claims.seat < 0 || claims.seat >= lobby.max_players ||
                typeof claims.lease !== "string" || !Number.isInteger(claims.expires) ||
                claims.expires < now) throw new Error("invalid claims");
            return claims;
        } catch {
            throw new MasterError(403, "invalid_resume", "resume token is invalid or expired");
        }
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
    CAP_DEDICATED_AUTHORITY,
    JOIN_TOKEN_TTL_SECONDS,
    RESUME_TOKEN_TTL_SECONDS,
    SEAT_LEASE_TTL_SECONDS,
    LOBBY_TTL_SECONDS,
    MAX_PLAYERS,
    MasterError,
    MasterService,
    MemoryLobbyStore,
    PROTOCOL_VERSION,
    PROVISIONAL_EVICTION_SECONDS,
    PROVISIONAL_SEATS_PER_SOURCE,
    PROVISIONAL_SEAT_TTL_SECONDS,
    VALID_PLATFORMS,
    validEtag
};
