"use strict";

const {
    BROADCAST_SLOT,
    TYPE_BIND,
    TYPE_BOUND,
    TYPE_DATA,
    TYPE_ERROR,
    decodeEnvelope,
    encodeEnvelope,
    validInnerDatagram,
    verifyAdmissionToken
} = require("./protocol");

const DEFAULT_IDLE_SECONDS = 90;
const DEFAULT_MAX_SESSIONS = 256;
const DEFAULT_BYTES_PER_SECOND = 128 * 1024;
// This global ceiling bounds worst-case Azure egress independently of how many
// authenticated sessions or broadcast recipients are active.
const DEFAULT_EGRESS_BYTES_PER_SECOND = 160 * 1024;

function endpointKey(remote) {
    return `${remote.family}|${remote.address}|${remote.port}`;
}

class RelayCore {
    constructor(publicKey, options = {}) {
        this.publicKey = publicKey;
        if (!this.publicKey || this.publicKey.type !== "public" ||
            this.publicKey.asymmetricKeyType !== "ed25519") {
            throw new Error("publicKey must be an Ed25519 public key");
        }
        this.clock = options.clock || (() => Date.now() / 1000);
        this.idleSeconds = options.idleSeconds || DEFAULT_IDLE_SECONDS;
        this.maxSessions = options.maxSessions || DEFAULT_MAX_SESSIONS;
        this.bytesPerSecond = options.bytesPerSecond || DEFAULT_BYTES_PER_SECOND;
        this.egressBytesPerSecond = options.egressBytesPerSecond ||
            DEFAULT_EGRESS_BYTES_PER_SECOND;
        this.egressTokens = this.egressBytesPerSecond;
        this.egressTokenTime = this.clock();
        this.sessions = new Map();
        this.endpoints = new Map();
        this.nonces = new Map();
        this.metrics = { accepted: 0, forwarded: 0, dropped: 0, expired: 0 };
    }

    purge(now = this.clock()) {
        for (const [key, session] of this.sessions) {
            for (const [slot, peer] of session.peers) {
                if (now - peer.lastSeen > this.idleSeconds) {
                    session.peers.delete(slot);
                    this.endpoints.delete(peer.endpointKey);
                    this.nonces.delete(peer.nonce);
                    this.metrics.expired += 1;
                }
            }
            if (!session.peers.has(0) || session.peers.size === 0) {
                for (const peer of session.peers.values()) {
                    this.endpoints.delete(peer.endpointKey);
                    this.nonces.delete(peer.nonce);
                }
                this.sessions.delete(key);
            }
        }
    }

    errorFor(envelope, code) {
        const payload = Buffer.from(code, "ascii");
        return encodeEnvelope(TYPE_ERROR, envelope.sessionId, 0, envelope.sourceSlot, payload);
    }

    bind(envelope, remote, now) {
        let claims;
        try {
            claims = verifyAdmissionToken(
                envelope.payload.toString("ascii"), this.publicKey, Math.floor(now)
            );
        } catch {
            /* Never answer unauthenticated traffic: no reflection oracle. */
            return [];
        }
        if (claims.sessionId !== envelope.sessionId) {
            return [{ remote, packet: this.errorFor(envelope, "SESSION") }];
        }
        const key = envelope.sessionId.toString(16).padStart(16, "0");
        const remoteKey = endpointKey(remote);
        const priorNonce = this.nonces.get(claims.nonce);
        if (priorNonce !== undefined) {
            if (priorNonce.endpointKey !== remoteKey) {
                return [{ remote, packet: this.errorFor(envelope, "REPLAY") }];
            }
            priorNonce.lastSeen = now;
            return [{
                remote,
                packet: encodeEnvelope(TYPE_BOUND, envelope.sessionId, priorNonce.slot, priorNonce.slot)
            }];
        }

        let session = this.sessions.get(key);
        if (claims.role === "host") {
            if (session === undefined && this.sessions.size >= this.maxSessions) {
                return [{ remote, packet: this.errorFor(envelope, "BUSY") }];
            }
            if (session === undefined) {
                session = { maxPlayers: claims.max_players, peers: new Map() };
                this.sessions.set(key, session);
            } else {
                const oldHost = session.peers.get(0);
                if (oldHost !== undefined) {
                    session.peers.delete(0);
                    this.endpoints.delete(oldHost.endpointKey);
                    this.nonces.delete(oldHost.nonce);
                }
            }
        } else if (session === undefined || !session.peers.has(0)) {
            return [{ remote, packet: this.errorFor(envelope, "NOHOST") }];
        }

        let slot = 0;
        if (claims.role === "client") {
            for (slot = 1; slot < session.maxPlayers && session.peers.has(slot); ++slot) {
                // Find the first bounded free relay slot.
            }
            if (slot >= session.maxPlayers) {
                return [{ remote, packet: this.errorFor(envelope, "FULL") }];
            }
        }
        const peer = {
            slot,
            role: claims.role,
            nonce: claims.nonce,
            remote: { address: remote.address, port: remote.port, family: remote.family },
            endpointKey: remoteKey,
            lastSeen: now,
            tokens: this.bytesPerSecond,
            tokenTime: now
        };
        session.peers.set(slot, peer);
        this.endpoints.set(remoteKey, { sessionKey: key, peer });
        this.nonces.set(claims.nonce, peer);
        this.metrics.accepted += 1;
        return [{ remote, packet: encodeEnvelope(TYPE_BOUND, envelope.sessionId, slot, slot) }];
    }

    consume(peer, amount, now) {
        const elapsed = Math.max(0, now - peer.tokenTime);
        peer.tokens = Math.min(this.bytesPerSecond, peer.tokens + elapsed * this.bytesPerSecond);
        peer.tokenTime = now;
        if (amount > peer.tokens) {
            return false;
        }
        peer.tokens -= amount;
        return true;
    }

    consumeEgress(amount, now) {
        const elapsed = Math.max(0, now - this.egressTokenTime);
        this.egressTokens = Math.min(
            this.egressBytesPerSecond,
            this.egressTokens + elapsed * this.egressBytesPerSecond
        );
        this.egressTokenTime = now;
        if (amount > this.egressTokens) return false;
        this.egressTokens -= amount;
        return true;
    }

    forward(envelope, remote, packetSize, now) {
        const binding = this.endpoints.get(endpointKey(remote));
        if (
            binding === undefined ||
            binding.sessionKey !== envelope.sessionId.toString(16).padStart(16, "0") ||
            binding.peer.slot !== envelope.sourceSlot ||
            !validInnerDatagram(envelope.payload, envelope.sessionId,
                                envelope.sourceSlot) ||
            !this.consume(binding.peer, packetSize, now)
        ) {
            return [];
        }
        const session = this.sessions.get(binding.sessionKey);
        const destinations = [];
        if (binding.peer.role === "client") {
            if (envelope.destinationSlot !== 0) {
                return [];
            }
            const host = session.peers.get(0);
            if (host !== undefined) {
                destinations.push(host);
            }
        } else if (envelope.destinationSlot === BROADCAST_SLOT) {
            for (const [slot, peer] of session.peers) {
                if (slot !== 0) {
                    destinations.push(peer);
                }
            }
        } else {
            const destination = session.peers.get(envelope.destinationSlot);
            if (destination !== undefined && destination.slot !== 0) {
                destinations.push(destination);
            }
        }
        binding.peer.lastSeen = now;
        const output = [];
        for (const peer of destinations) {
            const packet = encodeEnvelope(
                TYPE_DATA,
                envelope.sessionId,
                binding.peer.slot,
                peer.slot,
                envelope.payload
            );
            if (this.consumeEgress(packet.length, now)) {
                output.push({ remote: peer.remote, packet });
            }
        }
        this.metrics.forwarded += output.length;
        return output;
    }

    handle(packet, remote) {
        const now = this.clock();
        this.purge(now);
        const envelope = decodeEnvelope(packet);
        if (envelope === null) {
            this.metrics.dropped += 1;
            return [];
        }
        let output = [];
        if (envelope.type === TYPE_BIND) {
            output = this.bind(envelope, remote, now);
        } else if (envelope.type === TYPE_DATA) {
            output = this.forward(envelope, remote, packet.length, now);
        }
        if (output.length === 0) {
            this.metrics.dropped += 1;
        }
        return output;
    }
}

module.exports = { RelayCore, endpointKey };
