"use strict";

const crypto = require("node:crypto");

const MAGIC = 0x4254524c; // BTRL
const VERSION = 1;
const HEADER_SIZE = 24;
const MAX_INNER_DATAGRAM = 1200;
const MAX_DATAGRAM = HEADER_SIZE + MAX_INNER_DATAGRAM;
const MAX_TOKEN = 1024;
const BROADCAST_SLOT = 0xffff;
const TYPE_BIND = 1;
const TYPE_BOUND = 2;
const TYPE_DATA = 3;
const TYPE_ERROR = 4;
const MAX_PLAYER_SEATS = 4;

function decodeEnvelope(packet) {
    if (!Buffer.isBuffer(packet) || packet.length < HEADER_SIZE || packet.length > MAX_DATAGRAM) {
        return null;
    }
    const payloadSize = packet.readUInt16BE(20);
    if (
        packet.readUInt32BE(0) !== MAGIC ||
        packet[4] !== VERSION ||
        packet[5] < TYPE_BIND || packet[5] > TYPE_ERROR ||
        packet.readUInt16BE(6) !== 0 ||
        packet.readUInt16BE(22) !== 0 ||
        payloadSize !== packet.length - HEADER_SIZE
    ) {
        return null;
    }
    return {
        type: packet[5],
        sessionId: packet.readBigUInt64BE(8),
        sourceSlot: packet.readUInt16BE(16),
        destinationSlot: packet.readUInt16BE(18),
        payload: packet.subarray(HEADER_SIZE)
    };
}

function encodeEnvelope(type, sessionId, sourceSlot, destinationSlot, payload = Buffer.alloc(0)) {
    if (!Buffer.isBuffer(payload) || payload.length > MAX_INNER_DATAGRAM) {
        throw new RangeError("relay payload is too large");
    }
    const packet = Buffer.alloc(HEADER_SIZE + payload.length);
    packet.writeUInt32BE(MAGIC, 0);
    packet[4] = VERSION;
    packet[5] = type;
    packet.writeBigUInt64BE(sessionId, 8);
    packet.writeUInt16BE(sourceSlot, 16);
    packet.writeUInt16BE(destinationSlot, 18);
    packet.writeUInt16BE(payload.length, 20);
    payload.copy(packet, HEADER_SIZE);
    return packet;
}

function sessionIdFromText(text) {
    if (typeof text !== "string" || !/^[0-9a-f]{16}$/u.test(text)) {
        throw new Error("invalid token session");
    }
    return BigInt(`0x${text}`);
}

function verifyAdmissionToken(token, publicKey, nowSeconds) {
    if (
        typeof token !== "string" || token.length < 3 || token.length > MAX_TOKEN ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)
    ) {
        throw new Error("invalid token syntax");
    }
    const [encoded, suppliedSignature] = token.split(".");
    const encodedClaims = Buffer.from(encoded, "base64url");
    const signature = Buffer.from(suppliedSignature, "base64url");
    // Node's decoder accepts non-zero unused trailing bits, which permits
    // several textual encodings of the same signature bytes. Require the
    // unique canonical encoding before signature verification so admission
    // tokens cannot be rewritten into aliases that bypass text-keyed policy.
    if (encodedClaims.toString("base64url") !== encoded ||
        signature.toString("base64url") !== suppliedSignature ||
        signature.length !== 64 || !crypto.verify(
        null, Buffer.from(encoded, "ascii"), publicKey, signature
    )) {
        throw new Error("invalid token signature");
    }
    const claims = JSON.parse(encodedClaims.toString("utf8"));
    if (
        claims.protocol !== 1 ||
        (claims.role !== "authority" && claims.role !== "host" && claims.role !== "client") ||
        !Number.isInteger(claims.expires) || claims.expires < nowSeconds ||
        typeof claims.nonce !== "string" || !/^[0-9a-f]{16}$/u.test(claims.nonce) ||
        !Number.isInteger(claims.max_players) ||
        claims.max_players < 1 || claims.max_players > MAX_PLAYER_SEATS ||
        (claims.role === "client" && claims.seat !== undefined &&
            (!Number.isInteger(claims.seat) || claims.seat < 0 ||
             claims.seat >= claims.max_players)) ||
        (claims.lease_seq !== undefined &&
            (claims.role !== "client" || claims.seat === undefined ||
             !Number.isSafeInteger(claims.lease_seq) || claims.lease_seq < 1))
    ) {
        throw new Error("invalid token claims");
    }
    claims.sessionId = sessionIdFromText(claims.session);
    return claims;
}

function validInnerDatagram(packet, sessionId, sourceSlot) {
    if (!(Buffer.isBuffer(packet) &&
        packet.length >= 32 && packet.length <= MAX_INNER_DATAGRAM &&
        packet.readUInt32BE(0) === 0x42544741 &&
        packet.readUInt16BE(4) === 1 &&
        (packet[7] & 0x04) !== 0 &&
        packet.readBigUInt64BE(8) === sessionId &&
        packet.readUInt16BE(28) === packet.length - 32)) {
        return false;
    }
    const peerId = packet.readUInt16BE(30);
    const unassignedHandshake = peerId === 0xffff && (packet[6] === 1 || packet[6] === 3);
    return peerId === sourceSlot || unassignedHandshake;
}

module.exports = {
    BROADCAST_SLOT,
    HEADER_SIZE,
    MAX_DATAGRAM,
    MAX_INNER_DATAGRAM,
    MAX_PLAYER_SEATS,
    TYPE_BIND,
    TYPE_BOUND,
    TYPE_DATA,
    TYPE_ERROR,
    decodeEnvelope,
    encodeEnvelope,
    validInnerDatagram,
    verifyAdmissionToken
};
