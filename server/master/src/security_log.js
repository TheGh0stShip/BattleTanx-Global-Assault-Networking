"use strict";

const crypto = require("node:crypto");

// Structured, privacy-conscious security events.
//
// Events are built only from a fixed vocabulary. Free-form caller input
// (lobby names, request bodies, tokens, raw addresses) has no field to enter
// through: every value is either drawn from an allow-list, a bounded integer,
// or a keyed pseudonym produced here. A pseudonym is the first 12 hex digits
// of HMAC-SHA256(key, label), so the same caller correlates across events
// within one deployment without the log revealing the address or lobby ID.
// Rotating BTGA_MASTER_SECRET rotates every pseudonym.

const EVENTS = new Set([
    "rate_limited",
    "auth_failure",
    "rate_limit_store_degraded",
    "rate_limit_contention"
]);
const SCOPES = new Set([
    "source", "lobby_source", "lobby", "auth_failure", "lobby_create", "heartbeat", "none"
]);
const ROUTES = new Set([
    "lobbies", "join", "resume", "heartbeat", "remove", "validateJoin", "status", "dashboard",
    "health", "none"
]);
const SOURCE_KINDS = new Set(["ipv4", "ipv6_64", "unknown"]);
const REASONS = new Set([
    "unauthorized", "forbidden", "invalid_resume", "invalid_token", "store_error", "cas_exhausted",
    "none"
]);

class SecurityLog {
    constructor(secretKey, sink = defaultSink) {
        this.key = crypto.createHmac("sha256", Buffer.from(secretKey))
            .update("btga-security-log-v1").digest();
        this.sink = sink;
    }

    pseudonym(kind, value) {
        if (typeof value !== "string" || value === "") return "none";
        return crypto.createHmac("sha256", this.key).update(`${kind}\0${value}`)
            .digest("hex").slice(0, 12);
    }

    // `fields` may carry: scope, route, reason, source (canonical subject),
    // lobby (lobby ID), retry_after (seconds). Anything else is ignored.
    emit(event, fields = {}) {
        if (!EVENTS.has(event)) return;
        const record = {
            type: "btga_security",
            event,
            scope: SCOPES.has(fields.scope) ? fields.scope : "none",
            route: ROUTES.has(fields.route) ? fields.route : "none",
            reason: REASONS.has(fields.reason) ? fields.reason : "none",
            source_kind: sourceKind(fields.source),
            source: this.pseudonym("source", fields.source),
            lobby: this.pseudonym("lobby", fields.lobby)
        };
        if (Number.isInteger(fields.retry_after) && fields.retry_after >= 0 &&
            fields.retry_after <= 86400) {
            record.retry_after = fields.retry_after;
        }
        try {
            this.sink(JSON.stringify(record));
        } catch {
            // Logging must never change a security decision.
        }
    }
}

function sourceKind(source) {
    if (typeof source !== "string" || source === "" || source === "unknown") return "unknown";
    return source.endsWith("::/64") ? "ipv6_64" : "ipv4";
}

function defaultSink(line) {
    console.warn(line);
}

module.exports = { SecurityLog, SOURCE_KINDS };
