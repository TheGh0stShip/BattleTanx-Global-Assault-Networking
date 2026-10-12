# Master service HTTP API

The production API root is `https://btga.thegh0stship.com/api/v1`. All request
and response bodies are UTF-8 JSON. Request bodies are limited to 4096 bytes.

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
| `max_players` | 1–16; initial gameplay remains limited to four |
| `current_players` | 1–`max_players` |
| `udp_port` | 1–65535 |

The response includes a public `lobby`, a `host_secret`, and a cryptographically
random 64-bit `session_id` encoded as exactly 16 hexadecimal characters. The
secret is returned exactly once and must not be logged or sent to peers. The
host parses `session_id` into the fixed-width gameplay packet-header field.

`GET /lobbies?protocol=1&build=BUILD` lists compatible, unexpired lobbies.
Host addresses and credentials are intentionally omitted.

## Host lifecycle

The following routes require `Authorization: Bearer HOST_SECRET`:

- `PUT /lobbies/{id}/heartbeat` with `{ "current_players": N }` extends the
  90-second lobby lease.
- `DELETE /lobbies/{id}` removes the lobby.
- `POST /lobbies/{id}/validate-join` with `{ "join_token": "..." }` verifies
  a client token before admitting that client to the UDP session.

## Joining

`POST /lobbies/{id}/join` accepts `protocol`, `build`, and `platform`. It
returns the observed host endpoint, the same 16-character hexadecimal
`session_id`, and an HMAC-authenticated join token that expires after 30
seconds. The token is opaque to clients. `session_id` is bound into the token
and converts exactly to the unsigned 64-bit gameplay header field without
depending on JSON number precision.

## Errors

Errors have the shape `{ "error": "machine_code", "message": "..." }`.
Expected status codes are 400, 401, 403, 404, 409, and 413. Unexpected internal
errors return a generic 500 response and never expose secrets or stack traces.
