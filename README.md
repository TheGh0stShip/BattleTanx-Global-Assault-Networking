# BattleTanx: Global Assault Networking

[![CI](https://github.com/TheGh0stShip/BattleTanx-Global-Assault-Networking/actions/workflows/ci.yml/badge.svg)](https://github.com/TheGh0stShip/BattleTanx-Global-Assault-Networking/actions/workflows/ci.yml)

The canonical cross-platform multiplayer protocol and online-service project
for community ports of *BattleTanx: Global Assault*.

The project targets PC, PS Vita, original Xbox, Xbox 360, PS3, PS4, PS5 and
Nintendo 3DS. It is independent of any renderer, operating system, console SDK
or individual game port.

## Current status

- Portable C99 packet-header codec
- Fixed big-endian wire format with golden compatibility vectors
- Wrap-safe sequence/acknowledgement window with duplicate suppression
- Socket-free endpoint codec with per-peer replay filtering and session checks
- Allocation-free UDP admission and relay-envelope codecs
- Allocation-free relay client state machine that starts explicitly offline
- Host-authoritative roster, tank/team selection, ready, load and start state
- End-to-end relay/transport/lobby selection conformance test
- Allocation-free client/host admission state machines
- Fixed-capacity reliable-send tracking with ACK release and retry expiry
- Endian-stable batches of original N64 controller input by simulation tick
- Endian-stable simulation-frame markers with a portable state-checksum field
- Sixteen protocol peer slots reserved
- Host-authoritative topology selected
- Authenticated public UDP relay is the default gameplay path
- Azure lobby/discovery core and Node 22 Functions adapter
- No UPnP, NAT-PMP or manual port forwarding is required
- Networking is dormant until a player explicitly enters Online Multiplayer
- The PC port has a pre-boot deterministic rendezvous, delayed frame inputs,
  tick-entry recovery snapshots, per-frame state digests, readiness
  retransmission, and fail-closed waits that never advance an untracked tick

The live multiplayer dashboard is available at
[`https://btga.thegh0stship.com/`](https://btga.thegh0stship.com/), with the
production discovery API at
[`https://btga.thegh0stship.com/api/v1`](https://btga.thegh0stship.com/api/v1/health).
It is a scale-to-zero control plane; the separately deployed UDP data plane
relays gameplay traffic without exposing player addresses to one another.

The retail simulation remains four-player until every fixed-size gameplay,
camera, HUD, spawn and scoring structure is audited. A 16-slot packet format is
not a claim that the game already supports 16 active tanks.

The definitive PC port now expands the local player's camera to full screen
and suppresses the remote camera without changing shared simulation state.
Duplicate remote-player HUD elements remain a known presentation issue. This
is a port feature rather than a portable-protocol responsibility. Its
automated native gate has completed five consecutive three-minute public relay
sessions through a match transition and a second gameplay epoch, plus a
peer-loss watchdog fault test. Platform-specific implementation details live
in the [PC-port repository](https://github.com/TheGh0stShip/BattleTanx-Global-Assault-PC-Port).

## Build and test

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
ctest --test-dir build --output-on-failure
```

The protocol library does not allocate memory and does not depend on SDL,
POSIX sockets, Winsock or C++. Ports supply HTTPS, UDP, monotonic-time and
cryptographic-randomness adapters at the integration boundary.

It is also an installable CMake package:

```sh
cmake --install build --prefix /your/prefix
```

Consumers use `find_package(BattleTanxGANetworking CONFIG REQUIRED)` and link
`BattleTanxGA::NetProtocol`. CI builds a separate consumer project against the
installed package on Linux and Windows.

See [architecture.md](docs/architecture.md) for the topology and platform
contract, [api.md](docs/api.md) for the master-service contract, and
[deployment.md](docs/deployment.md) for the reproducible Azure workflow. The
fail-closed security, privacy, cost, and operational controls are listed in
[SECURITY_CONTROLS.md](docs/SECURITY_CONTROLS.md).

The master service core is tested independently from Azure. Node.js 22 is the
deployment runtime:

```sh
cd server/master
npm ci
npm test
```

The service is deliberately implemented with static Azure Functions metadata.
This keeps route discovery deterministic and avoids making any platform port
depend on Azure-specific libraries; only the service's Table Storage adapter
has an Azure dependency.

Native port recovery tests can run the same master-service core entirely on
loopback, without Azure or production credentials:

```sh
cd server/master
BTGA_LOCAL_MASTER_PORT=30419 \
BTGA_RELAY_HOST=127.0.0.1 BTGA_RELAY_PORT=30420 \
node src/local_server.js
```

The first output line is JSON containing the loopback API URL and the ephemeral
relay public key. `BTGA_LOCAL_MASTER_READY_FILE=/path/to/file.json` writes that
record atomically for unattended test orchestration. The adapter refuses a
non-loopback HTTP bind, stores all lobby state in memory, and is test tooling;
it is not an alternate production deployment.

The relay has no npm dependencies and can be exercised locally without Azure:

```sh
cd server/relay
npm test
BTGA_RELAY_PUBLIC_KEY='base64-spki-ed25519-public-key' npm start
```

Its end-to-end test opens a relay plus two independent UDP sockets, binds them
with master-issued credentials, and verifies an encapsulated gameplay datagram
travels from client to host. Invalid credentials are dropped silently, clients
cannot address other clients, and only the authenticated host can broadcast.

## Repository boundaries

- This repository: wire protocol, conformance vectors, common clients, master
  service, relay service and cloud deployment.
- Platform ports: platform SDK adapters, lobby UI, game-state replication and
  renderer/input integration.
- No proprietary SDK files, ROMs, extracted game assets or secrets belong here.

## License

The common protocol and service code are licensed under the GNU General Public
License version 3 only (`GPL-3.0-only`), matching the definitive PC port. See
[LICENSE-NOTICE.md](LICENSE-NOTICE.md) and [COPYING](COPYING).
