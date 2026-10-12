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

## Direct UDP admission

After HTTPS join, the client and host use four bounded payloads:

1. `HELLO` carries the opaque short-lived join token, platform capabilities,
   and a client nonce. Its header uses `BTGA_NET_UNASSIGNED_PEER_ID`; that value
   is legal only for `HELLO` and `AUTHENTICATE` and is never accepted by the
   established-peer endpoint decoder.
2. `CHALLENGE` echoes that nonce and adds a host nonce, proving that the
   claimed source endpoint can receive traffic before the host does costly
   validation or allocates a peer slot.
3. `AUTHENTICATE` echoes both nonces. The host then validates the cached join
   token over authenticated HTTPS; its claims bind lobby, session, protocol,
   build, platform, expiry, and a master-generated token nonce.
4. `WELCOME` echoes the client nonce and assigns the peer ID, player limit,
   simulation rate, and initial tick.

The common library only encodes and validates these messages. Ports own
timeouts, pending-handshake storage, HTTPS callbacks and cryptographically
secure nonce generation. The join token is a short-lived bearer sent over the
initial UDP path; v1 protects against off-path spoofing, not an on-path network
attacker. Gameplay encryption is a future protocol revision, not an implied
property of this handshake.

## Reliable delivery boundary

`BtgaNetSendQueue` tracks at most 32 outstanding reliable sequences, matching
the header's ACK bitmap. It stores timestamps, attempt counts and an opaque
application tag—not packet bytes. Ports retain packet buffers in their own
fixed pools, release them when ACK processing returns the tag, resend the same
bytes when polling returns `BTGA_NET_RETRY_READY`, and terminate or degrade the
peer when it returns `BTGA_NET_RETRY_EXPIRED`. Time inputs are unsigned
monotonic milliseconds supplied by the platform adapter.

## Gameplay input boundary

`BtgaNetInputBatch` carries one to 32 consecutive simulation ticks of the
original N64 input model: a 16-bit button mask and signed 8-bit stick axes.
Ticks and buttons are explicitly big-endian on the wire; signed axes are raw
two's-complement bytes. Repeating recent frames in later batches provides
loss tolerance without increasing the original simulation rate. The host must
authenticate the packet's peer-to-player assignment rather than trusting the
payload's player ID. World snapshots remain game-specific and are not defined
until the recovered game-state ownership boundary is audited.

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

The master generates a cryptographically random 64-bit gameplay session ID at
registration. It returns the ID to the host, omits it from lobby listings,
returns it to a joining client with the UDP endpoint, and cryptographically
binds it into the short-lived join token. The 16-character hexadecimal text
form avoids precision loss in JSON; ports parse it into the fixed-width
`uint64_t` packet-header field.

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
