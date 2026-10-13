"use strict";

const net = require("node:net");
const { BUILD_PATTERN, MasterError, MasterService, PROTOCOL_VERSION } = require("./core");
const { AzureLobbyStore, AzureRateLimitStore } = require("./store");
const { stripPort, trustedSource } = require("./address");
const { RequestGuard } = require("./guard");
const { PublicReadCache } = require("./public_cache");
const { RateLimiter, MemoryRateStore, localFallback, parseLimits } = require("./ratelimit");
const { SecurityLog } = require("./security_log");

let servicePromise;
let productionGuardInstance;
const testGuards = new WeakMap();
const publicReadCaches = new WeakMap();

function publicCache(service) {
    let cache = publicReadCaches.get(service);
    if (cache === undefined) {
        cache = new PublicReadCache();
        publicReadCaches.set(service, cache);
    }
    return cache;
}

// Connects to the shared rate-limit table on first use and retries at most
// once a minute after a failure. While it is unavailable every operation
// throws, which the limiter treats as a degraded store (see ratelimit.js).
class LazyRateStore {
    constructor(connect) {
        this.connect = connect;
        this.store = null;
        this.pending = null;
        this.failedAt = -Infinity;
    }

    async ready() {
        if (this.store !== null) return this.store;
        if (Date.now() - this.failedAt < 60_000) throw new Error("rate store unavailable");
        if (this.pending === null) {
            this.pending = this.connect().then((store) => {
                this.store = store;
                return store;
            }, (error) => {
                this.failedAt = Date.now();
                this.pending = null;
                throw error;
            });
        }
        return this.pending;
    }

    async get(...args) { return (await this.ready()).get(...args); }
    async create(...args) { return (await this.ready()).create(...args); }
    async replace(...args) { return (await this.ready()).replace(...args); }
    async purgeIdle(...args) { return (await this.ready()).purgeIdle(...args); }
}

function trustedHopsSetting() {
    const text = process.env.BTGA_TRUSTED_FORWARD_HOPS;
    const value = text === undefined || text === "" ? 1 : Number(text);
    if (!Number.isInteger(value) || value < 1 || value > 4) {
        throw new Error("BTGA_TRUSTED_FORWARD_HOPS must be an integer from 1 to 4");
    }
    return value;
}

function productionGuard() {
    if (productionGuardInstance === undefined) {
        const connection = process.env.AzureWebJobsStorage;
        const secret = process.env.BTGA_MASTER_SECRET;
        if (!connection || !secret) {
            throw new Error("required master-service settings are missing");
        }
        const key = Buffer.from(secret, "utf8");
        const limits = parseLimits(process.env.BTGA_RATE_LIMITS);
        const log = new SecurityLog(key);
        const tableName = process.env.BTGA_RATE_LIMIT_TABLE || "BtgaRateLimits";
        const fastLimiter = localFallback(key, limits, undefined, log);
        const limiter = new RateLimiter({
            store: new LazyRateStore(() => AzureRateLimitStore.connect(connection, tableName)),
            secretKey: key,
            limits,
            log,
            fallback: fastLimiter
        });
        productionGuardInstance = new RequestGuard({
            limiter, readLimiter: fastLimiter, log, trustedHops: trustedHopsSetting()
        });
    }
    return productionGuardInstance;
}

// Callers that inject their own service (tests, local tools) get an isolated
// in-memory guard per service factory, with production limits.
function defaultGuard(serviceFactory) {
    if (serviceFactory === productionService) return productionGuard();
    let guard = testGuards.get(serviceFactory);
    if (guard === undefined) {
        const key = require("node:crypto").randomBytes(32);
        guard = new RequestGuard({
            limiter: new RateLimiter({ store: new MemoryRateStore(), secretKey: key }),
            log: new SecurityLog(key, () => {})
        });
        testGuards.set(serviceFactory, guard);
    }
    return guard;
}

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

function htmlResponse(body) {
    return {
        status: 200,
        headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
            "x-frame-options": "DENY"
        },
        body
    };
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/gu, (character) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
}

function dashboardHtml(snapshot) {
    const rows = snapshot.sessions.length === 0
        ? '<tr><td colspan="6" class="empty">No active sessions. Start the PC port and host the first battle.</td></tr>'
        : snapshot.sessions.map((session) => `<tr>
            <td>${escapeHtml(session.name)}</td><td><span class="state ${session.state === "playing" ? "playing" : "lobby"}">${escapeHtml(session.state)}</span></td>
            <td>${escapeHtml(session.current_players)} / ${escapeHtml(session.max_players)}</td><td>${escapeHtml(session.platform)}</td>
            <td>${escapeHtml(session.region)}</td><td>${escapeHtml(session.build)}</td>
        </tr>`).join("");
    const updated = new Date(snapshot.generated_at * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="15"><title>BattleTanx: Global Assault Multiplayer</title><style>
:root{color-scheme:dark;--bg:#080b0d;--panel:#12181b;--line:#293438;--ink:#eef4ef;--muted:#9daba5;--acid:#b8e038;--orange:#ff8a35}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% 0,#233027 0,#080b0d 42%);color:var(--ink);font:16px/1.45 system-ui,sans-serif}main{width:min(1100px,calc(100% - 32px));margin:auto;padding:54px 0}header{border-left:6px solid var(--acid);padding-left:20px}h1{font-size:clamp(2rem,6vw,4.4rem);line-height:.95;margin:0;letter-spacing:-.05em}header p{color:var(--muted);max-width:720px}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:34px 0}.card,.sessions{background:rgba(18,24,27,.92);border:1px solid var(--line);box-shadow:0 18px 50px #0008}.card{padding:22px}.number{font-size:2.8rem;font-weight:800;color:var(--acid)}.label{color:var(--muted);text-transform:uppercase;letter-spacing:.12em;font-size:.78rem}.sessions{overflow:auto}table{width:100%;border-collapse:collapse}th,td{padding:15px 18px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--muted);font-size:.75rem;text-transform:uppercase;letter-spacing:.1em}.state{display:inline-block;padding:3px 9px;border-radius:99px;background:#27311d;color:var(--acid);text-transform:uppercase;font-size:.7rem;font-weight:800}.state.playing{background:#382115;color:var(--orange)}.empty{text-align:center;color:var(--muted);padding:40px}footer{color:var(--muted);font-size:.82rem;margin-top:18px}@media(max-width:650px){.stats{grid-template-columns:1fr}main{padding-top:28px}}
</style></head><body><main><header><h1>BATTLETANX<br>MULTIPLAYER</h1><p>Live cross-platform BattleTanx: Global Assault sessions. The service uses a dedicated relay—no port forwarding, UPnP, or public player addresses.</p></header>
<section class="stats"><div class="card"><div class="number">${snapshot.games}</div><div class="label">Games in progress</div></div><div class="card"><div class="number">${snapshot.open_lobbies}</div><div class="label">Open lobbies</div></div><div class="card"><div class="number">${snapshot.players}</div><div class="label">Players online</div></div></section>
<section class="sessions"><table><thead><tr><th>Session</th><th>Status</th><th>Players</th><th>Platform</th><th>Region</th><th>Build</th></tr></thead><tbody>${rows}</tbody></table></section>
<footer>Updated ${updated}. This dashboard refreshes every 15 seconds. Only public lobby metadata is shown.</footer></main></body></html>`;
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

// The full caller address, used only for a host's optional legacy direct
// endpoint. Only the entry appended by the Azure front end is trusted; see
// address.js. Headers a caller can forge (X-Azure-ClientIP etc.) are ignored.
function observedIp(req, trustedHops = 1) {
    const forwarded = header(req, "x-forwarded-for");
    if (typeof forwarded !== "string" || forwarded.length > 2048) return "";
    const entries = forwarded.split(",").map((part) => part.trim());
    if (entries.length < trustedHops || entries.length > 32) return "";
    return stripPort(entries[entries.length - trustedHops]);
}

async function handle(operation, req, bindingData = {}, serviceFactory = productionService,
                      guard = undefined) {
    if (operation === "health") {
        return response({ status: "ok", protocol: PROTOCOL_VERSION });
    }
    let admitted;
    try {
        const activeGuard = guard || defaultGuard(serviceFactory);
        admitted = await activeGuard.admit(operation, req, bindingData);
        if (admitted.response !== null) return admitted.response;
        return await dispatch(operation, req, bindingData, serviceFactory, activeGuard,
            admitted.context);
    } catch (error) {
        return errorResponse(error);
    }
}

async function dispatch(operation, req, bindingData, serviceFactory, guard, context) {
    try {
        const result = await route(operation, req, bindingData, serviceFactory, guard);
        await guard.recordSuccess(context);
        return result;
    } catch (error) {
        await guard.recordFailure(context, error);
        throw error;
    }
}

async function route(operation, req, bindingData, serviceFactory, guard) {
    const service = await serviceFactory();
    if (operation === "status") {
        return response(await publicCache(service).get("status", () => service.publicSnapshot()));
    }
    if (operation === "dashboard") {
        if (bindingData.path) {
            return response({ error: "not_found", message: "route not found" }, 404);
        }
        return htmlResponse(dashboardHtml(
            await publicCache(service).get("status", () => service.publicSnapshot())
        ));
    }
    const lobbyId = bindingData.lobbyId;
    if (operation === "lobbies") {
        if (req.method === "POST") {
            return response(await service.register(jsonBody(req), observedIp(req, guard.trustedHops)), 201);
        }
        const protocol = Number(req.query && req.query.protocol);
        const build = req.query && req.query.build;
        if (!Number.isInteger(protocol) || protocol !== PROTOCOL_VERSION || !BUILD_PATTERN.test(build || "")) {
            throw new MasterError(400, "invalid_field", "protocol or build is invalid");
        }
        const key = `lobbies:${protocol}:${build}`;
        const lobbies = await publicCache(service).get(
            key, () => service.listLobbies(protocol, build)
        );
        return response({ lobbies });
    }
    if (operation === "heartbeat") {
        const data = jsonBody(req);
        return response(await service.heartbeat(
            lobbyId, header(req, "authorization"), data.current_players, data.state,
            data.seat_mask
        ));
    }
    if (operation === "remove") {
        await service.remove(lobbyId, header(req, "authorization"));
        return { status: 204, body: "" };
    }
    if (operation === "join") {
        return response(await service.join(lobbyId, jsonBody(req), guard.source(req)));
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
}

function azureHandler(operation) {
    return async function (context, req) {
        context.res = await handle(operation, req, context.bindingData);
    };
}

module.exports = {
    azureHandler,
    handle,
    dashboardHtml,
    jsonBody,
    normalizeForwardedAddress,
    observedIp,
    productionService,
    response,
    trustedSource
};
