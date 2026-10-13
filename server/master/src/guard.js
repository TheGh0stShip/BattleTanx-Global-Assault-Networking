"use strict";

const { UNKNOWN_SOURCE, trustedSource } = require("./address");
const { MAX_RETRY_AFTER_SECONDS } = require("./ratelimit");

// Abuse policy for the public HTTP API, applied before any lobby lookup.
//
// Every bucket key is derived only from the caller's trusted address and the
// lobby ID in the URL, never from stored state. A 429 is therefore produced
// identically whether or not the lobby, seat, session or token exists.

const AUTH_FAILURE_CODES = new Set([
    "unauthorized", "forbidden", "invalid_resume", "invalid_token"
]);

function isResume(req) {
    const body = req && req.body;
    return body !== null && typeof body === "object" && !Array.isArray(body) &&
        body.resume_token !== undefined;
}

// Returns [route, [[scope, subject, mode], ...]] for one request.
//   "pre":   spend one token before the request runs (request pressure).
//   "post":  require one token before, spend it only if the request succeeds
//            (allocation budgets: failed polls of a full lobby earn nothing,
//            so they must not drain a legitimate household's budget).
//   "check": require one token, never spend here (credential-failure budget;
//            recordFailure spends it when a credential is rejected).
function policy(operation, req, source, lobbyId) {
    const lobby = `lobby:${String(lobbyId || "")}`;
    const lobbySource = `${lobby}|${source}`;
    switch (operation) {
    case "lobbies":
        return req.method === "POST"
            ? ["lobbies", [["create_source", source, "pre"],
                            ["lobby_create", "global", "pre"]]]
            : ["lobbies", [["read", source, "pre"]]];
    case "join":
        return isResume(req)
            ? ["resume", [["auth_failure", source, "check"],
                          ["lobby_source", lobbySource, "pre"]]]
            : ["join", [["lobby_source", lobbySource, "pre"],
                        ["seat_source", source, "post"], ["lobby", lobby, "post"]]];
    case "heartbeat":
        // The per-lobby heartbeat budget is spent only by authenticated
        // heartbeats: anyone can name a lobby, and unauthenticated attempts
        // must never be able to starve its host into expiry.
        return ["heartbeat", [["auth_failure", source, "check"], ["heartbeat", lobby, "post"]]];
    case "remove":
    case "validateJoin":
        return [operation, [["auth_failure", source, "check"]]];
    case "status":
    case "dashboard":
        return [operation, [["read", source, "pre"]]];
    default:
        return [operation, []];
    }
}

function rateLimitedResponse(retryAfter) {
    const seconds = Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil(retryAfter)));
    return {
        status: 429,
        headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "retry-after": String(seconds)
        },
        body: JSON.stringify({ error: "rate_limited", message: "too many requests; retry later" })
    };
}

class RequestGuard {
    // options: limiter (durable RateLimiter), readLimiter (fast per-instance
    // limiter for public reads), log (SecurityLog), trustedHops. Public read
    // requests already query the lobby table; routing their throttle through
    // another shared CAS row amplifies a read flood into storage contention.
    constructor({ limiter, readLimiter = limiter, log = null, trustedHops = 1 }) {
        if (!Number.isInteger(trustedHops) || trustedHops < 1 || trustedHops > 4) {
            throw new Error("trustedHops must be an integer from 1 to 4");
        }
        this.limiter = limiter;
        this.readLimiter = readLimiter;
        this.log = log;
        this.trustedHops = trustedHops;
    }

    source(req) {
        return trustedSource(req, this.trustedHops);
    }

    // Returns { context, response }. `response` is a 429 to return as-is, or
    // null when the request may proceed.
    async admit(operation, req, bindingData = {}) {
        const source = this.source(req);
        const lobbyId = typeof bindingData.lobbyId === "string" ? bindingData.lobbyId : "";
        const [route, charges] = policy(operation, req, source, lobbyId);
        const context = { route, source, lobby: lobbyId, deferred: [] };
        for (const [scope, subject, mode] of charges) {
            const cost = mode === "pre" ? 1 : 0;
            if (mode === "post") context.deferred.push([scope, subject]);
            const activeLimiter = scope === "read" ? this.readLimiter : this.limiter;
            const result = await activeLimiter.consume(scope, subject, cost, context);
            if (!result.allowed) {
                if (this.log) {
                    this.log.emit("rate_limited", {
                        scope, route, source, lobby: lobbyId, retry_after: result.retryAfter
                    });
                }
                return { context, response: rateLimitedResponse(result.retryAfter) };
            }
        }
        return { context, response: null };
    }

    // Spends the allocation budgets of a request that succeeded. Concurrent
    // requests from one caller can overshoot a budget by at most their
    // concurrency, after which the "post" check refuses them.
    async recordSuccess(context) {
        for (const [scope, subject] of context.deferred) {
            await this.limiter.consume(scope, subject, 1, context);
        }
    }

    // Charges the caller's credential-failure budget after a rejected
    // credential. Other errors (not found, full, invalid fields) are free.
    async recordFailure(context, error) {
        if (!error || !AUTH_FAILURE_CODES.has(error.code)) return;
        if (this.log) {
            this.log.emit("auth_failure", {
                route: context.route, source: context.source, lobby: context.lobby,
                reason: error.code
            });
        }
        await this.limiter.consume("auth_failure", context.source, 1, context);
    }
}

module.exports = { RequestGuard, UNKNOWN_SOURCE, policy, rateLimitedResponse };
