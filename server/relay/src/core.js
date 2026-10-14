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
const DEFAULT_EGRESS_QUEUE_PACKETS = 64;

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
        this.queuedEgress = options.queuedEgress === true;
        this.egressQueuePackets = options.egressQueuePackets ||
            DEFAULT_EGRESS_QUEUE_PACKETS;
        this.egressSessionCursor = 0;
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
                    session.egress.delete(slot);
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
        const authority = claims.role === "authority" || claims.role === "host";
        if (authority) {
            if (session === undefined && this.sessions.size >= this.maxSessions) {
                return [{ remote, packet: this.errorFor(envelope, "BUSY") }];
            }
            if (session === undefined) {
                session = {
                    maxPlayers: claims.max_players, peers: new Map(), seatSequences: new Map(),
                    egress: new Map(), egressPeerCursor: 0
                };
                this.sessions.set(key, session);
            } else {
                const oldAuthority = session.peers.get(0);
                if (oldAuthority !== undefined) {
                    session.peers.delete(0);
                    session.egress.delete(0);
                    this.endpoints.delete(oldAuthority.endpointKey);
                    this.nonces.delete(oldAuthority.nonce);
                }
            }
        } else if (session === undefined || !session.peers.has(0)) {
            return [{ remote, packet: this.errorFor(envelope, "NOHOST") }];
        }

        let slot = 0;
        if (claims.role === "client") {
            if (claims.seat !== undefined) {
                slot = claims.seat + 1;
                // The master numbers every seat issuance. Once this relay has
                // admitted a seat at some sequence, an older admission token
                // for it (issued before a resume rotated the lease) is stale.
                // This uses only this session's own state; it is lost if the
                // session is purged, which leaves at most the 30-second token
                // lifetime as the exposure window.
                const sequence = claims.lease_seq === undefined ? 0 : claims.lease_seq;
                if (sequence < (session.seatSequences.get(slot) || 0)) {
                    return [{ remote, packet: this.errorFor(envelope, "STALE") }];
                }
                session.seatSequences.set(slot, sequence);
                const previous = session.peers.get(slot);
                if (previous !== undefined) {
                    // The master is the seat allocator. A newly signed token
                    // for the same seat is therefore an authenticated resume,
                    // and atomically replaces the stale network mapping.
                    session.peers.delete(slot);
                    session.egress.delete(slot);
                    this.endpoints.delete(previous.endpointKey);
                    this.nonces.delete(previous.nonce);
                }
            } else {
                // Compatibility for tokens issued before stable seat claims.
                // New master-service tokens always carry a seat.
                for (slot = 1; slot <= session.maxPlayers && session.peers.has(slot); ++slot) {
                    // Slot zero is the authoritative simulation server.
                }
                if (slot > session.maxPlayers) {
                    return [{ remote, packet: this.errorFor(envelope, "FULL") }];
                }
            }
        }
        const peer = {
            slot,
            role: authority ? "authority" : claims.role,
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
        // A wall-clock correction backwards must not manufacture refill time
        // when the clock later catches up.
        this.egressTokenTime = Math.max(this.egressTokenTime, now);
        if (amount > this.egressTokens) return false;
        this.egressTokens -= amount;
        return true;
    }

    enqueueEgress(session, peer, packet) {
        let queue = session.egress.get(peer.slot);
        if (queue === undefined) {
            queue = [];
            session.egress.set(peer.slot, queue);
        }
        if (queue.length >= this.egressQueuePackets) {
            this.metrics.dropped += 1;
            return false;
        }
        queue.push({ remote: peer.remote, packet });
        return true;
    }

    drain(now = this.clock()) {
        const sessionKeys = Array.from(this.sessions.keys()).filter((key) => {
            const session = this.sessions.get(key);
            return session !== undefined && session.egress.size !== 0;
        });
        if (sessionKeys.length === 0) return [];
        this.egressSessionCursor %= sessionKeys.length;
        const output = [];
        let madeProgress = true;
        while (madeProgress) {
            madeProgress = false;
            for (let offset = 0; offset < sessionKeys.length; ++offset) {
                const index = (this.egressSessionCursor + offset) % sessionKeys.length;
                const session = this.sessions.get(sessionKeys[index]);
                if (session === undefined) continue;
                const slots = Array.from(session.egress.keys()).filter((slot) => {
                    const queue = session.egress.get(slot);
                    return queue !== undefined && queue.length !== 0;
                });
                if (slots.length === 0) continue;
                session.egressPeerCursor %= slots.length;
                for (let peerOffset = 0; peerOffset < slots.length; ++peerOffset) {
                    const peerIndex = (session.egressPeerCursor + peerOffset) % slots.length;
                    const slot = slots[peerIndex];
                    const queue = session.egress.get(slot);
                    const item = queue[0];
                    if (!this.consumeEgress(item.packet.length, now)) continue;
                    queue.shift();
                    if (queue.length === 0) session.egress.delete(slot);
                    session.egressPeerCursor = peerIndex + 1;
                    output.push(item);
                    this.metrics.forwarded += 1;
                    madeProgress = true;
                    break;
                }
            }
            this.egressSessionCursor = (this.egressSessionCursor + 1) % sessionKeys.length;
        }
        return output;
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
            const authorityPeer = session.peers.get(0);
            if (authorityPeer !== undefined) {
                destinations.push(authorityPeer);
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
        let accepted = false;
        for (const peer of destinations) {
            const packet = encodeEnvelope(
                TYPE_DATA,
                envelope.sessionId,
                binding.peer.slot,
                peer.slot,
                envelope.payload
            );
            if (this.queuedEgress) {
                accepted = true;
                this.enqueueEgress(session, peer, packet);
            } else if (this.consumeEgress(packet.length, now)) {
                output.push({ remote: peer.remote, packet });
                accepted = true;
            }
        }
        this.metrics.forwarded += output.length;
        this.lastForwardAccepted = accepted;
        return output;
    }

    handle(packet, remote) {
        const now = this.clock();
        this.lastForwardAccepted = false;
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
        if (output.length === 0 && !this.lastForwardAccepted) {
            this.metrics.dropped += 1;
        }
        return output;
    }
}

module.exports = { RelayCore, endpointKey };
