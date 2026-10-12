"use strict";

const net = require("node:net");
const { BUILD_PATTERN, MasterError, MasterService, PROTOCOL_VERSION } = require("./core");
const { AzureLobbyStore } = require("./store");

let servicePromise;

async function productionService() {
    if (servicePromise === undefined) {
        const connection = process.env.AzureWebJobsStorage;
        const secret = process.env.BTGA_MASTER_SECRET;
        const relayPrivateKeyText = process.env.BTGA_RELAY_PRIVATE_KEY;
        if (!connection || !secret || !relayPrivateKeyText) {
            throw new Error("required master-service settings are missing");
        }
        const relayPrivateKey = require("node:crypto").createPrivateKey({
            key: Buffer.from(relayPrivateKeyText, "base64"),
            format: "der",
            type: "pkcs8"
        });
        const relayHost = process.env.BTGA_RELAY_HOST;
        const relayPort = Number(process.env.BTGA_RELAY_PORT || 30420);
        const relayEndpoint = relayHost && Number.isInteger(relayPort) && relayPort >= 1 && relayPort <= 65535
            ? { address: relayHost, udp_port: relayPort }
            : null;
        servicePromise = AzureLobbyStore
            .connect(connection, process.env.BTGA_LOBBY_TABLE || "BtgaLobbies")
            .then((store) => new MasterService(
                store,
                Buffer.from(secret, "utf8"),
                undefined,
                relayEndpoint,
                relayPrivateKey
            ));
    }
    return servicePromise;
}

function response(data, status = 200) {
    return {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: data === undefined ? "" : JSON.stringify(data)
    };
}

function errorResponse(error) {
    if (error instanceof MasterError) {
        return response({ error: error.code, message: error.message }, error.status);
    }
    return response({ error: "internal_error", message: "request could not be completed" }, 500);
}

function jsonBody(req) {
    const raw = req.rawBody;
    if (Buffer.isBuffer(raw) ? raw.length > 4096 : typeof raw === "string" && Buffer.byteLength(raw) > 4096) {
        throw new MasterError(413, "request_too_large", "request body exceeds 4096 bytes");
    }
    if (req.body === null || typeof req.body !== "object" || Array.isArray(req.body)) {
        throw new MasterError(400, "invalid_json", "request body must be a JSON object");
    }
    return req.body;
}

function header(req, name) {
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(req.headers || {})) {
        if (key.toLowerCase() === lower) {
            return value;
        }
    }
    return undefined;
}

function normalizeForwardedAddress(value) {
    let candidate = value.trim();
    if (candidate.startsWith("[") && candidate.includes("]")) {
        candidate = candidate.slice(1, candidate.indexOf("]"));
    } else if (net.isIP(candidate) === 0 && candidate.split(":").length === 2) {
        candidate = candidate.slice(0, candidate.lastIndexOf(":"));
    }
    return net.isIP(candidate) === 0 ? "" : candidate;
}

function observedIp(req) {
    const forwarded = header(req, "x-forwarded-for") || "";
    const candidates = forwarded.split(",").map((part) => part.trim()).filter(Boolean);
    if (candidates.length > 0) {
        const candidate = normalizeForwardedAddress(candidates[candidates.length - 1]);
        if (candidate) {
            return candidate;
        }
    }
    return normalizeForwardedAddress(header(req, "x-azure-clientip") || "");
}

async function handle(operation, req, bindingData = {}, serviceFactory = productionService) {
    try {
        if (operation === "health") {
            return response({ status: "ok", protocol: PROTOCOL_VERSION });
        }
        const service = await serviceFactory();
        const lobbyId = bindingData.lobbyId;
        if (operation === "lobbies") {
            if (req.method === "POST") {
                return response(await service.register(jsonBody(req), observedIp(req)), 201);
            }
            const protocol = Number(req.query && req.query.protocol);
            const build = req.query && req.query.build;
            if (!Number.isInteger(protocol) || protocol !== PROTOCOL_VERSION || !BUILD_PATTERN.test(build || "")) {
                throw new MasterError(400, "invalid_field", "protocol or build is invalid");
            }
            return response({ lobbies: await service.listLobbies(protocol, build) });
        }
        if (operation === "heartbeat") {
            const data = jsonBody(req);
            return response(await service.heartbeat(lobbyId, header(req, "authorization"), data.current_players));
        }
        if (operation === "remove") {
            await service.remove(lobbyId, header(req, "authorization"));
            return { status: 204, body: "" };
        }
        if (operation === "join") {
            return response(await service.join(lobbyId, jsonBody(req)));
        }
        if (operation === "validateJoin") {
            const data = jsonBody(req);
            if (typeof data.join_token !== "string" || data.join_token.length > 1024) {
                throw new MasterError(400, "invalid_field", "join_token is invalid");
            }
            const claims = await service.validateJoinToken(
                lobbyId,
                header(req, "authorization"),
                data.join_token
            );
            return response({ valid: true, claims });
        }
        throw new Error(`unknown operation: ${operation}`);
    } catch (error) {
        return errorResponse(error);
    }
}

function azureHandler(operation) {
    return async function (context, req) {
        context.res = await handle(operation, req, context.bindingData);
    };
}

module.exports = {
    azureHandler,
    handle,
    jsonBody,
    normalizeForwardedAddress,
    observedIp,
    productionService,
    response
};
