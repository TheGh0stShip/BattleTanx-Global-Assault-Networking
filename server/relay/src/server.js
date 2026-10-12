"use strict";

const dgram = require("node:dgram");
const crypto = require("node:crypto");
const { RelayCore } = require("./core");
const { MAX_DATAGRAM } = require("./protocol");

function boundedInteger(name, fallback, minimum, maximum) {
    const text = process.env[name];
    if (text === undefined || text === "") return fallback;
    const value = Number(text);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
    }
    return value;
}

function createRelayServer(options = {}) {
    const publicKeyText = options.publicKeyText || process.env.BTGA_RELAY_PUBLIC_KEY;
    const publicKey = options.publicKey || (publicKeyText && crypto.createPublicKey({
        key: Buffer.from(publicKeyText, "base64"),
        format: "der",
        type: "spki"
    }));
    if (!publicKey || publicKey.type !== "public" ||
        publicKey.asymmetricKeyType !== "ed25519") {
        throw new Error("BTGA_RELAY_PUBLIC_KEY must contain an Ed25519 SPKI key");
    }
    const core = new RelayCore(publicKey, {
        ...options,
        maxSessions: options.maxSessions || boundedInteger(
            "BTGA_RELAY_MAX_SESSIONS", 256, 1, 4096
        ),
        bytesPerSecond: options.bytesPerSecond || boundedInteger(
            "BTGA_RELAY_PEER_BYTES_PER_SECOND", 128 * 1024, 1024, 1024 * 1024
        ),
        egressBytesPerSecond: options.egressBytesPerSecond || boundedInteger(
            "BTGA_RELAY_EGRESS_BYTES_PER_SECOND", 160 * 1024, 1024, 1024 * 1024
        )
    });
    const socket = dgram.createSocket({ type: options.type || "udp6", ipv6Only: false });
    socket.on("message", (packet, remote) => {
        if (packet.length > MAX_DATAGRAM) {
            core.metrics.dropped += 1;
            return;
        }
        for (const output of core.handle(packet, remote)) {
            socket.send(output.packet, output.remote.port, output.remote.address);
        }
    });
    return { core, socket };
}

if (require.main === module) {
    const port = Number(process.env.BTGA_RELAY_PORT || 30420);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("BTGA_RELAY_PORT must be a valid UDP port");
    }
    const relay = createRelayServer();
    relay.socket.bind(port, "::", () => {
        process.stdout.write(`BTGA UDP relay listening on ${port}\n`);
    });
}

module.exports = { boundedInteger, createRelayServer };
