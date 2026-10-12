# Multiplayer architecture

## Compatibility contract

Every multi-byte wire integer is big-endian and explicitly sized. Native
structs, pointers, `long`, `size_t`, host floating-point layouts and implicit
alignment are never serialized. This is mandatory because Xbox 360 and PS3 are
big-endian while the other initial targets are little-endian, and the targets
span 32-bit and 64-bit ABIs.

UDP datagrams are capped at 1200 bytes. The v1 header reserves peer IDs 0–15,
sequence acknowledgements and a 32-packet acknowledgement bitmap.

`BtgaNetEndpoint` is the portable ingress/egress boundary. It constructs full
datagrams, owns one replay window per peer, rejects wrong-session and reflected
self packets, emits destination-specific ACK vectors, and exposes payloads
only after structural validation. It does
not open sockets or allocate memory. Platform ports keep ownership of packet
buffers and supply their own UDP, clock, HTTPS and secure-random adapters.

## Topology

The first production topology is host-authoritative:

1. A host registers a lobby with the Azure master over HTTPS.
2. The master stores bounded metadata and the observed public endpoint.
3. Compatible clients discover or join the lobby over HTTPS.
4. Peers attempt direct UDP connectivity.
5. A relay may be introduced later for failed NAT traversal.

The master is not a simulation server. It does not receive world snapshots or
inputs. This makes scale-to-zero control-plane hosting practical and keeps the
gameplay latency path independent of Azure.

The production master runs on Node.js 22 in Azure Functions Flex Consumption.
It scales to zero, keeps no lobby state in process memory, and stores only
bounded discovery metadata in Azure Table Storage. Gameplay packets never
traverse the master service.

## Platform adapters

The common client will use application-provided callbacks for HTTPS, UDP,
monotonic time and secure randomness. Ports must implement those callbacks with
their licensed SDK or maintained homebrew libraries. Old consoles do not fall
back to an unauthenticated plaintext master endpoint.

| Platform | Relevant networking boundary |
|---|---|
| PC | Winsock/POSIX plus system TLS |
| PS Vita | ARMv7 ILP32; Vita socket/TLS adapter |
| Nintendo 3DS | 32-bit ARM; socket and SSLC adapter |
| Original Xbox | 32-bit x86; constrained homebrew adapter |
| Xbox 360 | big-endian PowerPC; platform socket/TLS adapter |
| PS3 | big-endian PowerPC; platform socket/TLS adapter |
| PS4 / PS5 | licensed platform socket/TLS adapter |

## Player limits

The transport reserves sixteen peer IDs now to avoid an incompatible protocol
redesign. Initial network play must retain the verified retail four-player
simulation. Increasing that limit is a separate gameplay-engine project.
