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
- Sixteen protocol peer slots reserved
- Host-authoritative topology selected
- Direct UDP is the first gameplay path
- Azure lobby/discovery core and Node 22 Functions adapter
- Paid UDP relay is deliberately deferred until direct gameplay works

The production discovery API is available at
[`https://btga.thegh0stship.com/api/v1`](https://btga.thegh0stship.com/api/v1/health).
It is a scale-to-zero control plane; it does not relay gameplay traffic.

The retail simulation remains four-player until every fixed-size gameplay,
camera, HUD, spawn and scoring structure is audited. A 16-slot packet format is
not a claim that the game already supports 16 active tanks.

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
[deployment.md](docs/deployment.md) for the reproducible Azure workflow.

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

## Repository boundaries

- This repository: wire protocol, conformance vectors, common clients, master
  service, relay service and cloud deployment.
- Platform ports: platform SDK adapters, lobby UI, game-state replication and
  renderer/input integration.
- No proprietary SDK files, ROMs, extracted game assets or secrets belong here.

## License

The common protocol and service code are licensed under the GNU General Public
License version 2. See [COPYING](COPYING).
