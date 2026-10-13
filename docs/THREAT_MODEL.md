# Threat model: lobby control plane

Scope: the HTTPS master service (`server/master`) and its interaction with the
UDP relay's admission checks. The relay's data-plane bounds are covered in
[SECURITY_CONTROLS.md](SECURITY_CONTROLS.md). Operational limits and tuning
are in [ABUSE_PROTECTION.md](ABUSE_PROTECTION.md).

## Assets

- Seat reservations (leases) and the right to occupy a seat in a match.
- Host credentials, resume credentials, and relay admission tokens.
- The Ed25519 relay signing key and `BTGA_MASTER_SECRET`.
- Service availability, and the project's $60/month cost ceiling.
- Player privacy: addresses and lobby membership.

## Actors

| Actor | Capabilities |
|---|---|
| Anonymous caller | Any HTTP request, any headers, one or many addresses (botnet, IPv6 `/64` rotation) |
| Lobby host / dedicated authority | Holds the host secret; heartbeats with `seat_mask` |
| Joined player | Holds a join token (30 s) and a rotating resume token (24 h) |
| Relay operator compromise | Holds only the public verification key |
| Storage outage | Table Storage slow or unavailable |

## Threats and controls

| # | Threat | Controls | Residual risk |
|---|---|---|---|
| T1 | Anonymous seat squatting | Provisional 60 s seats, 30 s stale takeover, confirmed seats never reassigned (fe22a98); per-address allocation budget and per-lobby churn budget | An attacker with roughly 30 or more addresses can keep re-taking provisional seats until its per-address bursts run out. It can never displace confirmed seats. A per-lobby invite secret would be needed to close this fully. |
| T2 | Evicting an active player | `seat_mask` confirmation; `lease_seq` STALE rejection at the relay | Holds only for authorities that send `seat_mask` (legacy lobbies keep 10-minute leases) |
| T3 | Credential guessing (host secret, resume, join token) | 256-bit secrets; Ed25519 signatures; `auth_failure` budget of 10 burst and 20/hour per address | A distributed guesser gets 20/hour per address, which is negligible against 256-bit secrets |
| T4 | Starving a host by naming its lobby | The heartbeat budget is spent only by authenticated heartbeats; failures spend the caller's own `auth_failure` budget | None identified |
| T5 | Limit evasion by header spoofing | Only the rightmost `X-Forwarded-For` entry (front-end appended) is trusted; other client-IP headers are ignored; IPv6 grouped by `/64` | Correctness depends on `BTGA_TRUSTED_FORWARD_HOPS` matching the real proxy chain |
| T6 | Rate-limit storage exhaustion | Durable mutation keys are HMAC-sharded: at most 6 × 4096 rows; idle purge. Read-only throttles are per-instance, avoiding a shared CAS hot row. | Hash collisions can make two callers share a durable bucket (stricter, never looser); read limits multiply by active instance count and reset on recycle |
| T7 | Lobby table growth | Per-address and global `lobby_create` buckets; 90 s lobby TTL without heartbeat | A host heartbeating many lobbies holds them, bounded by the creation rate |
| T8 | Existence oracle through 429s | Bucket keys use only the caller address and the URL lobby ID; identical 429 body and headers | Ordinary 404/409 responses still reveal whether a lobby exists, by design for the public list |
| T9 | Log injection or credential leakage | Security events built only from allow-listed fields and keyed pseudonyms; no names, bodies, tokens or addresses; dashboard HTML-escapes every interpolated field | Platform request logs (Functions host) record URLs, which include lobby IDs; keep request sampling and retention as configured |
| T10 | Cost exhaustion by flooding | The limiter stops floods from creating state; Function maximum instance count and `maxConcurrentRequests` bound spend; $60 budget alerts | 429s still execute Functions, so flood spend is bounded by the scale cap, not eliminated. A WAF or Front Door would cost more than the budget. |
| T11 | Storage outage | Durable limits fall back to per-instance memory with the same limits; 1.5 s timeout; throttled degraded events. Read routes already use memory and remain independent of this table. | During an outage, mutation limits are multiplied by the instance count and reset on recycle |
| T12 | Concurrency races | ETag CAS on buckets and lobbies; contention exhaustion is refused | Success-only budgets can overshoot by one caller's concurrency |

## Assumptions

- The Function App is reached only through Azure's front end. If a CDN or Front
  Door is added, `BTGA_TRUSTED_FORWARD_HOPS` must be updated before
  deployment.
- `BTGA_MASTER_SECRET` is at least 32 random bytes and is never logged.
- Clocks across instances agree to within a few seconds. Bucket arithmetic
  tolerates small skew; a backwards step only delays refill.
