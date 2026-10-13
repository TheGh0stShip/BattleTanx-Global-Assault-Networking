"use strict";

const net = require("node:net");

// Client address handling for the public HTTP API.
//
// Azure Functions (App Service front ends) append the connecting peer's
// address to X-Forwarded-For. Anything to the left of that entry was supplied
// by the caller and is untrusted. With `trustedHops` = 1 (no CDN or Front Door
// in front of the Function App) the only trustworthy entry is therefore the
// rightmost one. Each additional trusted proxy layer adds one hop. No other
// header (X-Azure-ClientIP, X-Real-IP, X-Client-IP, Forwarded) is trusted,
// because a caller can set them freely when the corresponding proxy is absent.

const MAX_FORWARDED_LENGTH = 2048;
const MAX_FORWARDED_ENTRIES = 32;
const UNKNOWN_SOURCE = "unknown";

function header(req, name) {
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries((req && req.headers) || {})) {
        if (key.toLowerCase() === lower) {
            return Array.isArray(value) ? value.join(",") : value;
        }
    }
    return undefined;
}

// Strips an optional port and IPv6 brackets. Returns a bare literal or "".
// Zone identifiers ("fe80::1%eth0") are refused: they are host-local and
// cannot describe an Internet caller.
function stripPort(value) {
    let candidate = String(value).trim();
    if (candidate.startsWith("[")) {
        const end = candidate.indexOf("]");
        if (end < 0) return "";
        const rest = candidate.slice(end + 1);
        if (rest !== "" && !/^:\d{1,5}$/u.test(rest)) return "";
        candidate = candidate.slice(1, end);
    } else if (net.isIPv4(candidate.replace(/:\d{1,5}$/u, ""))) {
        candidate = candidate.replace(/:\d{1,5}$/u, "");
    }
    if (candidate.includes("%")) return "";
    return net.isIP(candidate) === 0 ? "" : candidate;
}

// Expands an IPv6 literal to eight 16-bit groups. Input is already validated
// by net.isIPv6.
function ipv6Groups(address) {
    let text = address.toLowerCase();
    const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/u);
    if (tail) {
        const octets = tail[1].split(".").map(Number);
        text = text.slice(0, -tail[1].length) +
            `${((octets[0] << 8) | octets[1]).toString(16)}:` +
            `${((octets[2] << 8) | octets[3]).toString(16)}`;
    }
    const [head, rest] = text.split("::");
    const left = head === "" ? [] : head.split(":");
    const right = rest === undefined || rest === "" ? [] : rest.split(":");
    const fill = rest === undefined ? 0 : 8 - left.length - right.length;
    return [...left, ...Array(fill).fill("0"), ...right].map((group) => parseInt(group, 16));
}

// Canonical rate-limit subject for an address:
//  - IPv4 (including IPv4-mapped IPv6, ::ffff:a.b.c.d) -> dotted quad;
//  - other IPv6 -> its /64 prefix, because one subscriber normally controls a
//    whole /64 and could otherwise rotate through 2^64 distinct addresses.
// Returns "" for anything that is not a valid literal.
function canonicalSource(value) {
    const address = stripPort(value);
    if (address === "") return "";
    if (net.isIPv4(address)) {
        return address.split(".").map((octet) => String(Number(octet))).join(".");
    }
    const groups = ipv6Groups(address);
    if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group))) return "";
    const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
    if (mapped) {
        return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
    }
    return `${groups.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64`;
}

// Returns the canonical caller subject, or UNKNOWN_SOURCE when the trusted
// entry is missing or malformed. Callers sharing UNKNOWN_SOURCE share one
// set of rate-limit buckets, so a missing header can never widen a limit.
function trustedSource(req, trustedHops = 1) {
    const forwarded = header(req, "x-forwarded-for");
    if (typeof forwarded !== "string" || forwarded.length === 0 ||
        forwarded.length > MAX_FORWARDED_LENGTH) {
        return UNKNOWN_SOURCE;
    }
    const entries = forwarded.split(",").map((part) => part.trim());
    if (entries.length > MAX_FORWARDED_ENTRIES || entries.length < trustedHops) {
        return UNKNOWN_SOURCE;
    }
    return canonicalSource(entries[entries.length - trustedHops]) || UNKNOWN_SOURCE;
}

module.exports = { UNKNOWN_SOURCE, canonicalSource, header, stripPort, trustedSource };
