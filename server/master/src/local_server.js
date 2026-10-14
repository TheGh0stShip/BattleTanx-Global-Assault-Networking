"use strict";

// Loopback-only HTTP adapter for deterministic native integration tests. It
// runs the same MasterService used by Azure, but keeps lobby state in memory
// and deliberately refuses non-loopback binds. No production deployment
// imports this module.

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const {
    MasterError,
    MasterService,
    MemoryLobbyStore,
    PROTOCOL_VERSION
} = require("./core");

const MAX_BODY_BYTES = 4096;

function integerSetting(value, fallback, minimum, maximum, name) {
    if (value === undefined || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
    }
    return parsed;
}

function send(response, status, value) {
    const body = value === undefined ? "" : JSON.stringify(value);
    response.writeHead(status, {
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(body),
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff"
    });
    response.end(body);
}

async function readJson(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
            throw new MasterError(413, "request_too_large", "request body exceeds 4096 bytes");
        }
        chunks.push(chunk);
    }
    try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("not an object");
        }
        return parsed;
    } catch {
        throw new MasterError(400, "invalid_json", "request body must be a JSON object");
    }
}

function bearer(request) {
    return typeof request.headers.authorization === "string"
        ? request.headers.authorization : "";
}

function localPath(url) {
    const prefix = "/api/v1";
    return url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : null;
}

function createLocalMasterServer(options = {}) {
    const relayHost = options.relayHost || "127.0.0.1";
    if (net.isIP(relayHost) === 0) throw new Error("relayHost must be an IP address");
    const relayPort = integerSetting(
        options.relayPort, 30420, 1, 65535, "relayPort");
    const keys = options.keys || crypto.generateKeyPairSync("ed25519");
    const service = options.service || new MasterService(
        new MemoryLobbyStore(), options.secretKey || crypto.randomBytes(32),
        options.clock, { address: relayHost, udp_port: relayPort }, keys.privateKey
    );

    const server = http.createServer(async (request, response) => {
        try {
            const url = new URL(request.url, "http://127.0.0.1");
            const route = localPath(url);
            if (route === null) {
                send(response, 404, { error: "not_found", message: "route not found" });
                return;
            }
            if (request.method === "GET" && route === "/health") {
                send(response, 200, { status: "ok", protocol: PROTOCOL_VERSION });
                return;
            }
            if (request.method === "GET" && route === "/status") {
                send(response, 200, await service.publicSnapshot());
                return;
            }
            if (request.method === "GET" && route === "/lobbies") {
                const protocol = Number(url.searchParams.get("protocol"));
                const build = url.searchParams.get("build") || "";
                send(response, 200, {
                    lobbies: await service.listLobbies(protocol, build)
                });
                return;
            }
            if (request.method === "POST" && route === "/lobbies") {
                send(response, 201, await service.register(
                    await readJson(request), "127.0.0.1"));
                return;
            }
            const match = /^\/lobbies\/([A-Za-z0-9_-]{1,64})(?:\/(join|heartbeat))?$/.exec(route);
            if (match === null) {
                send(response, 404, { error: "not_found", message: "route not found" });
                return;
            }
            const [, lobbyId, operation] = match;
            if (request.method === "POST" && operation === "join") {
                send(response, 200, await service.join(
                    lobbyId, await readJson(request), "127.0.0.1"));
                return;
            }
            if (request.method === "PUT" && operation === "heartbeat") {
                const body = await readJson(request);
                send(response, 200, await service.heartbeat(
                    lobbyId, bearer(request), body.current_players,
                    body.state, body.seat_mask));
                return;
            }
            if (request.method === "DELETE" && operation === undefined) {
                await service.remove(lobbyId, bearer(request));
                send(response, 204);
                return;
            }
            send(response, 404, { error: "not_found", message: "route not found" });
        } catch (error) {
            if (error instanceof MasterError) {
                send(response, error.status, { error: error.code, message: error.message });
            } else {
                send(response, 500, {
                    error: "internal_error", message: "request could not be completed"
                });
            }
        }
    });
    return { server, service, keys };
}

function writeReadyFile(file, document) {
    if (!file) return;
    const target = path.resolve(file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(document)}\n`, {
        encoding: "utf8", mode: 0o600
    });
    fs.renameSync(temporary, target);
}

async function main() {
    const host = process.env.BTGA_LOCAL_MASTER_HOST || "127.0.0.1";
    if (host !== "127.0.0.1" && host !== "::1") {
        throw new Error("BTGA_LOCAL_MASTER_HOST must be a loopback address");
    }
    const port = integerSetting(
        process.env.BTGA_LOCAL_MASTER_PORT, 30419, 1, 65535,
        "BTGA_LOCAL_MASTER_PORT");
    const relayPort = integerSetting(
        process.env.BTGA_RELAY_PORT, 30420, 1, 65535, "BTGA_RELAY_PORT");
    const instance = createLocalMasterServer({
        relayHost: process.env.BTGA_RELAY_HOST || "127.0.0.1", relayPort
    });
    await new Promise((resolve, reject) => {
        instance.server.once("error", reject);
        instance.server.listen(port, host, resolve);
    });
    const address = instance.server.address();
    const actualPort = typeof address === "object" && address !== null
        ? address.port : port;
    const ready = {
        url: `http://${host === "::1" ? "[::1]" : host}:${actualPort}/api/v1`,
        relay_public_key: instance.keys.publicKey.export({
            format: "der", type: "spki"
        }).toString("base64"),
        relay_host: process.env.BTGA_RELAY_HOST || "127.0.0.1",
        relay_port: relayPort
    };
    writeReadyFile(process.env.BTGA_LOCAL_MASTER_READY_FILE, ready);
    process.stdout.write(`${JSON.stringify(ready)}\n`);

    const close = () => instance.server.close(() => process.exit(0));
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { createLocalMasterServer, integerSetting, readJson };
