# Master service HTTP API

The production API root is `https://btga.thegh0stship.com/api/v1`. All request
and response bodies are UTF-8 JSON. Request bodies are limited to 4096 bytes.

The public, server-rendered dashboard is at
[`https://btga.thegh0stship.com/`](https://btga.thegh0stship.com/). It reports
aggregate player, lobby, and in-progress game counts plus public session
metadata. It never returns player addresses, session identifiers, host
credentials, or relay admission tokens. `GET /api/v1/status` returns the same
read-only snapshot as JSON for monitoring and community integrations.

## Health

`GET /health` returns the service state and protocol version. It does not open
Table Storage and is suitable for deployment checks.

## Register and discover

`POST /lobbies` registers a host. The request fields are:

| Field | Contract |
|---|---|
| `name` | 1–48 printable characters |
| `protocol` | `1` |
| `build` | 1–64 letters, digits, `.`, `_`, `+`, or `-` |
| `platform` | `pc`, `vita`, `xbox`, `xbox360`, `ps3`, `ps4`, `ps5`, or `3ds` |
| `capabilities` | unsigned 32-bit bit mask |
| `region` | 1–24 printable characters |
| `max_players` | 1–4; the current authoritative simulation is four-player |
| `current_players` | 1–`max_players` |
| `state` | optional `lobby` (default) or `playing` |
| `udp_port` | optional legacy direct-UDP port; omit for relay-only play |

The response includes a public `lobby`, a `host_secret`, a short-lived
`relay_token`, the configured public `relay` endpoint, and a cryptographically
random 64-bit `session_id` encoded as exactly 16 hexadecimal characters. The
secret is returned exactly once and must not be logged or sent to peers. The
host parses `session_id` into the fixed-width gameplay packet-header field.
The portable C package provides strict `btga_net_parse_session_id` and
`btga_net_format_session_id` helpers so ports never route this value through a
JSON number or an ABI-dependent native integer conversion.

`GET /lobbies?protocol=1&build=BUILD` lists compatible, unexpired lobbies.
Host addresses and credentials are intentionally omitted.

## Host lifecycle

The following routes require `Authorization: Bearer HOST_SECRET`:

- `PUT /lobbies/{id}/heartbeat` with `{ "current_players": N, "state":
  "lobby" | "playing" }` extends the 90-second lobby lease and returns a
  refreshed host `relay_token`. `state` may be omitted for older clients.
- `DELETE /lobbies/{id}` removes the lobby.
- `POST /lobbies/{id}/validate-join` with `{ "join_token": "..." }` verifies
  a client token before admitting that client to the UDP session.

## Joining

`POST /lobbies/{id}/join` accepts `protocol`, `build`, and `platform`, plus an
optional opaque `resume_token`. A new join atomically leases the lowest free
seat. A valid resume credential rotates that lease and reclaims the same seat,
including when all four seats are reserved. Concurrent joins use Azure Table
ETag compare-and-swap; they cannot receive the same seat.

The response returns `seat`, `resume_token`, the configured public `relay`
endpoint, the same 16-character hexadecimal `session_id`, and a fresh
Ed25519-signed join token that expires after 30 seconds. Seat leases last ten
minutes. The resume credential has a longer signature expiry but is usable only
while its exact current lease still exists; successful resume rotates the lease
ID and immediately invalidates the old credential. Clients must replace their
stored credential atomically and treat it as a bearer secret.

A legacy direct `host` endpoint is returned only when the host explicitly
advertised one; it is not required for relay play. Admission and resume tokens
are opaque to clients. `session_id` is bound into both and converts exactly to
the unsigned 64-bit gameplay header field without depending on JSON number
precision. Invalid, expired, replayed, wrong-lobby, and wrong-session resume
credentials fail closed.

## Relay data plane

The HTTP master never receives gameplay packets. A port sends `BIND` to the
returned relay using the host relay token or client join token, receives a
bounded relay slot, then wraps each complete gameplay datagram in `DATA`.
Clients address slot 0 only. The host may address a bound client slot or the
broadcast slot. This path requires no UPnP, NAT-PMP, port forwarding, or public
player address.

## Errors

Errors have the shape `{ "error": "machine_code", "message": "..." }`.
Expected status codes are 400, 401, 403, 404, 409, and 413. Unexpected internal
errors return a generic 500 response and never expose secrets or stack traces.
