"use strict";

const dgram = require("node:dgram");
const { RelayCore } = require("./core");
const { MAX_DATAGRAM } = require("./protocol");

function createRelayServer(options = {}) {
    const secret = options.secret || process.env.BTGA_MASTER_SECRET;
    if (!secret || Buffer.byteLength(secret) < 32) {
        throw new Error("BTGA_MASTER_SECRET must contain at least 32 bytes");
    }
    const core = new RelayCore(Buffer.from(secret), options);
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

module.exports = { createRelayServer };
