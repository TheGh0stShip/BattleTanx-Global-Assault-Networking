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
            <td>${escapeHtml(session.name)}</td><td><span class="state ${session.state}">${escapeHtml(session.state)}</span></td>
            <td>${session.current_players} / ${session.max_players}</td><td>${escapeHtml(session.platform)}</td>
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
        if (operation === "status") {
            return response(await service.publicSnapshot());
        }
        if (operation === "dashboard") {
            if (bindingData.path) {
                return response({ error: "not_found", message: "route not found" }, 404);
            }
            return htmlResponse(dashboardHtml(await service.publicSnapshot()));
        }
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
            return response(await service.join(
                lobbyId, jsonBody(req), observedIp(req) || "unknown"));
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
    dashboardHtml,
    jsonBody,
    normalizeForwardedAddress,
    observedIp,
    productionService,
    response
};
