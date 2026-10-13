# Public API abuse protection: operations guide

The master service rate-limits every public route that can allocate, extend,
or probe server-side state. Mutation and allocation limits are token buckets
kept in Azure Table Storage, so every Function instance enforces the same
budget. Read-only list, status, and dashboard limits are deliberately kept
per Function instance: making each read contend on a shared CAS row turns a
read flood into extra storage load and can delay the lobby query itself. The
code is in `server/master/src/{address,ratelimit,guard,security_log}.js`. The threat
analysis is in [THREAT_MODEL.md](THREAT_MODEL.md).

Public projections also use a two-second, 64-entry per-instance single-flight
cache. Concurrent requests for the same status or lobby listing share one
Table Storage query. Failures are not cached, and the short TTL bounds visible
staleness after a lobby change.

## Caller identity

Azure Functions front ends append the connecting address to
`X-Forwarded-For`. Only that rightmost entry is trusted.
`BTGA_TRUSTED_FORWARD_HOPS` (default `1`, allowed `1`–`4`) must equal the
number of trusted proxy layers. Leave it at `1` unless a reviewed CDN or Front
Door is placed in front and configured to append exactly one entry.
`X-Azure-ClientIP`, `X-Real-IP`, `X-Client-IP`, `Forwarded` and similar headers
are ignored, because a caller can set them freely.

Addresses are normalized before use:

- IPv4 and IPv4-mapped IPv6 become a dotted quad.
- Other IPv6 addresses become their `/64` prefix, since one subscriber can
  rotate freely within it.
- Missing, malformed, zone-scoped or oversized values map to one shared
  `unknown` subject, so they never widen a limit.

## Default limits

| Scope | Key | Burst | Sustained | Charged | Purpose |
|---|---|---|---|---|---|
| `seat_source` | address | 32 | 16/hour | successful new seat joins | Seat-allocation budget per address; authenticated resume is exempt |
| `create_source` | address | 8 | 24/hour | lobby creation attempt | Keeps one address from consuming the global creation budget |
| `lobby_source` | lobby + address | 20 | 120/hour | every join/resume attempt | Throttles polling of one lobby |
| `lobby` | lobby | 20 | 720/hour | successful new seat joins | Bounds seat churn and writes to one lobby row |
| `auth_failure` | address | 10 | 20/hour | each rejected host secret, resume or join token | Credential guessing; once empty, all credential routes from that address get 429 |
| `lobby_create` | global | 60 | 240/hour | lobby creation attempt | Bounds lobby-table growth |
| `heartbeat` | lobby | 8 | 720/hour | successful (authenticated) heartbeat | Bounds authority writes; unauthenticated callers cannot drain it |
| `read` | address, per instance | 60 | 3600/hour | list, status, dashboard | Fast shedding before table scans, without a shared CAS hot row |

"Success only" scopes are checked before the request runs but spent only when
it succeeds. A household polling a full lobby therefore spends only its
`lobby_source` throttle, never its allocation budget.

**Four players behind one NAT.** One address can create a lobby, place four
players, and let each resume without consuming another allocation token.
Lobby creation, new seat allocation, and authenticated resume use distinct
budgets, so repeatedly hosting cannot disable reconnect for a household. The
seat-level rule from b7fb200 (four unconfirmed seats per address) is unchanged.

**Monopolization threshold.** Holding all four seats of a lobby with
unconfirmed reservations needs about 240 allocations per hour, because each
lasts 60 s and can be taken over after 30 s. At 16 per hour per address, an
attacker needs at least ~15 distinct IPv4 addresses or IPv6 `/64`s per
targeted lobby. Below that, the stress test shows a household seated within
30 minutes. Above it, the attacker can keep taking freed provisional seats
until its per-address bursts run out. Confirmed seats are never reassigned at
any attacker size.

`Retry-After` is the time until one token refills, capped at 900 s. The 429
body is always
`{"error":"rate_limited","message":"too many requests; retry later"}`. The
response is the same whether or not the lobby, seat, session or token exists,
because bucket keys use only the caller address and the lobby ID from the URL.

### Tuning

Override any scope with `BTGA_RATE_LIMITS`, a JSON object such as
`{"seat_source":{"capacity":48,"perHour":24}}`. Values outside capacity 1–10000 or
perHour (0, 360000] are rejected at startup; a limit cannot be disabled.

- **Players see 429 when joining a busy lobby.** Raise `lobby_source` first.
  Raise `seat_source` only with care: the monopolization threshold falls in
  proportion to `seat_source.perHour`.
- **Attackers churn provisional seats.** Lower `seat_source.perHour`, or ask the
  host to keep `seat_mask` heartbeats flowing; confirmed seats are already
  protected.
- **Event spikes.** Raise `create_source` and `lobby_create` temporarily.

## Storage and cost

- **Table rows.** Durable mutation/allocation buckets live in table
  `BTGA_RATE_LIMIT_TABLE` (default
  `BtgaRateLimits`) in the existing `AzureWebJobsStorage` account. Each subject
  is HMAC-keyed into one of 4096 shards per scope, so the table can never
  exceed 7 × 4096 = 28,672 rows of under 100 bytes each (under 3 MB). Read
  buckets are local and do not create table rows. Rows
  hold no address, lobby ID or credential. Rows idle long enough to refill
  completely are purged opportunistically, at most 200 per scope per instance
  per hour. Because of the shard bound, cardinality does not depend on purging.
- **Table transactions.** A successful join costs about 8 table transactions
  (3 buckets: read and CAS write, plus 2 pre-checks); a refused request costs
  1–4. At the Standard LRS rate of about $0.00036 per 10,000 transactions,
  1 million joins cost about $0.30. Confirm against the current Azure pricing
  page before relying on it.
- **Function executions are the real cost exposure.** A 429 still runs a
  Function. Flex Consumption bills per execution and per GB-second. The bound
  on that spend is the Function App's **maximum instance count** together
  with `host.json` `maxConcurrentRequests` (8), not the rate limiter. Under
  the $60/month budget, keep maximum instances at 1–2 for public testing. At
  that scale, sustained flooding is capped at a few hundred requests per
  second, and budget alerts at $30, $45 and $54 give warning well before the
  cap. The limiter's job is to keep that flood from turning into lobby state,
  seat churn, table growth or credential guessing.

## Store outage behavior (availability vs. security)

Read-only routes always use the in-memory per-instance limiter and therefore
do not depend on the rate-limit table. Their effective aggregate limit is
multiplied by the number of active instances and resets when an instance
recycles; the configured 1–2 instance cap bounds that tradeoff.

If the table cannot be reached, or answers slower than 1.5 s, each instance
falls back to an in-memory limiter with the same limits. It emits one
`rate_limit_store_degraded` event per minute and reconnects at most once per
minute. Tradeoff: during an outage, effective limits are multiplied by the
number of running instances, which is small because it is capped, and they
reset when an instance recycles. The alternative, refusing all requests,
would let any storage blip take the lobby service offline. A limiter created
with no fallback refuses instead (fail closed).

Persistent CAS contention on one bucket (4 consecutive lost writes) is
treated as abuse. The request is refused with `Retry-After: 1` and
`rate_limit_contention` is emitted.

## Monitoring signals

The service writes security events to the Functions log stream (Application
Insights `traces`) as one-line JSON with `type = "btga_security"`. Fields
come only from fixed allow-lists. `source` and `lobby` are 12-hex-digit keyed
pseudonyms (HMAC of `BTGA_MASTER_SECRET`): stable for correlation, but never
the address or lobby ID. Rotating the secret rotates every pseudonym.

| Event | Meaning | Alert when |
|---|---|---|
| `rate_limited` (by `scope`) | A request was refused | `seat_source`/`lobby` refusals for one `lobby` pseudonym persist for more than 15 min (seat siege); total exceeds 10× baseline |
| `auth_failure` (by `reason`) | A credential was rejected | More than 50 per hour from distinct sources (credential spraying) |
| `rate_limit_store_degraded` | The table is unreachable; limits are per instance | Any occurrence lasting more than 5 min |
| `rate_limit_contention` | Hot-bucket CAS exhaustion | Repeated bursts |

Example Log Analytics query:

```kusto
traces
| where message has '"type":"btga_security"'
| extend e = parse_json(message)
| summarize count() by tostring(e.event), tostring(e.scope), bin(timestamp, 15m)
```

Keep the existing Log Analytics daily ingestion cap. Events are bounded by
request volume, are one short line each, and the degraded event is throttled.

## Deployment checklist

1. No new secret is required. The limiter keys are derived from
   `BTGA_MASTER_SECRET`.
2. Optionally set `BTGA_RATE_LIMIT_TABLE`, `BTGA_RATE_LIMITS` and
   `BTGA_TRUSTED_FORWARD_HOPS`. Leave hops at `1` without a reviewed proxy
   layer.
3. Confirm the Function App's maximum instance count is set (1–2 for public
   testing).
4. After deployment, send a burst of joins against a test lobby and confirm
   `429` with `Retry-After`. Burst `/status` concurrently and confirm fast
   `200`/`429` responses without storage timeouts. Sending a spoofed left-hand
   `X-Forwarded-For` entry must not change either outcome.
