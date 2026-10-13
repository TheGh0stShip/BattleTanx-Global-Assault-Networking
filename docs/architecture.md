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

## Relay admission

The default public path requires no UPnP, NAT-PMP, manual port forwarding or
inbound listener on a player's router. Host and clients each create an outbound
UDP mapping to the same public relay and bind it using a short-lived token from
the master. The relay assigns transport slots, never discloses player addresses,
and forwards only within the token's session.

The relay envelope is fixed-width, big-endian and capped at 1224 bytes: a
24-byte relay header around one complete, at-most-1200-byte gameplay datagram.
Relay slot 0 is reserved for the authoritative simulation server. A lobby's
`max_players` counts playable seats, so four-player play binds clients at relay
slots 1 through 4 and maps them to game seats 0 through 3. Clients can address
only authority slot 0. Only slot 0 can address a client or broadcast. The relay
verifies the inner protocol version, session ID, length and
`BTGA_NET_FLAG_RELAYED` flag before forwarding it unchanged. Invalid admission
tokens receive no response, preventing an unauthenticated reflection oracle.

`BtgaRelayClient` is the portable port-side boundary. Initialization leaves it
in `BTGA_RELAY_CLIENT_OFFLINE` and cannot emit a packet. Only an explicit
`btga_relay_client_begin` transition—called after the player enters Online
Multiplayer—copies an admission token and enables a `BIND` datagram. A valid
`BOUND` reply erases that token from the structure. Disconnect resets the whole
state to offline. Consequently there is no persistent “network enabled” setting
and ordinary game startup cannot accidentally perform DNS or network I/O.

After HTTPS join and relay binding, the client and host use four bounded payloads:

1. `HELLO` carries the opaque short-lived join token, platform capabilities,
   and a client nonce. Its header uses `BTGA_NET_UNASSIGNED_PEER_ID`; that value
   is legal only for `HELLO` and `AUTHENTICATE` and is never accepted by the
   established-peer endpoint decoder.
2. `CHALLENGE` echoes that nonce and adds a host nonce, proving that the
   assigned relay slot can receive traffic before the host does costly
   validation or allocates a peer slot.
3. `AUTHENTICATE` echoes both nonces. The host then validates the cached join
   token over authenticated HTTPS; its claims bind lobby, session, protocol,
   build, platform, expiry, and a master-generated token nonce.
4. `WELCOME` echoes the client nonce and assigns the peer ID, player limit,
   simulation rate, and initial tick.

The common library only encodes and validates these messages and relay
envelopes. Ports own
timeouts, pending-handshake storage, HTTPS callbacks and cryptographically
secure nonce generation. The join token is a short-lived bearer sent over the
initial UDP path; v1 protects against off-path spoofing, not an on-path network
attacker. Gameplay encryption is a future protocol revision, not an implied
property of this handshake.

Join-token bytes accepted by the wire codec are restricted to the master's
two non-empty base64url components separated by one `.`. This rejects control
characters and malformed bearer material before a platform JSON/HTTPS adapter
handles it. A host must also remember validated token nonces for the session
and reject reuse; master validation is intentionally stateless within the
30-second token lifetime.

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
payload's player ID. World snapshots remain game-specific. The PC port now
uses a bounded selected-state match-epoch snapshot, while retaining fail-closed
digest handling because pointer-owned world state is not yet complete enough
for general mid-match rollback. Snapshot bytes are deliberately not part of
this cross-platform protocol until the recovered ownership boundary is stable.

`BtgaNetFrameSync` is the portable simulation-boundary marker carried in an
`EVENT` message. Its fixed 12-byte payload contains a version/type prefix, a
big-endian 32-bit frame number, and a big-endian 32-bit state checksum. Ports
may initially set the checksum to a documented sentinel while recovering a
canonical game-state digest. The frame marker supports a strict common start
and a bounded lead window without serializing pointers, host time, or native
state. It is not itself rollback: ports retain input history and complete
snapshots needed to resimulate after a late correction. The current PC
implementation uses bounded lockstep and aborts a persistently divergent
online session rather than claiming rollback from an incomplete snapshot.

## Synchronized lobby and player selection

The portable `BtgaLobbyState` owns the pre-match authority. Its initial v1
limit is deliberately four players even though the packet header reserves 16
peer IDs. The host admits authenticated relay peers, chooses the map and mode,
then advances through these phases:

1. `ASSEMBLING`: roster changes are accepted; gameplay selection is locked.
2. `SELECTING`: each authenticated peer submits its tank and team, then ready.
3. `LOADING`: the host has locked the roster and selections and broadcast the
   random seed plus initial simulation tick. Selection changes are rejected.
4. `RUNNING`: reached only after every still-connected peer reports loaded.

Commands contain no player ID. The host passes the authenticated relay source
slot to `btga_lobby_apply_command`, so a client cannot select or ready another
player by changing payload bytes. Any selection change clears that player's
ready bit. A disconnect during loading returns the match to selection instead
of silently starting with a different roster.

The host broadcasts a fixed 40-byte, big-endian snapshot after authoritative
changes. It contains connected/ready/loaded masks, map, mode, all four
selections, seed and start tick. It contains no pointers, native structs or
floating-point values. The conformance test carries a guest selection through
endpoint framing and relay encapsulation, applies it under the relay identity,
then carries the host's locked loading snapshot back to the guest.

## Topology

The production topology is dedicated-authority and relay-first:

1. The master allocates a headless simulation session and registers its lobby.
2. The authority binds relay slot 0 using a short-lived server credential.
3. Compatible clients discover or join the lobby over HTTPS.
4. Up to four clients bind outbound UDP mappings at relay slots 1 through 4.
5. Clients send timestamped inputs only to the authority. The authority runs
   the canonical simulation and publishes state, digests and corrections.

Readiness and future-input batches use UDP and therefore must be retransmitted.
A client repeats its readiness batch at a bounded interval until the first
canonical authority frame arrives. The authority never enters a translated
simulation tick unless it has selected that tick's canonical input set; when
input is late it waits at the tick boundary rather than allowing an untracked
game update.

Recovery snapshots describe state at entry to their advertised tick, after
the retail outer-loop mode/counter transition and before that tick's gameplay
update. Established clients consume every canonical frame in order. If a frame
is lost, they pause rather than predicting indefinitely and may fast-forward
only from a newer complete authority snapshot. A snapshot for the client's
current tick is confirmed byte-for-byte before it is allowed to replace live
state. Ports must keep host-local handles (audio voices, renderer resources,
native pointers) out of portable state.

An optional direct peer path may be researched later as a latency optimization,
but it can never be required for joining. The supported baseline contains no
UPnP or NAT-PMP implementation.

The master remains control-plane only and does not receive world snapshots or
inputs. A separately deployed headless game server owns each active simulation;
this keeps lobby discovery scale-to-zero while giving gameplay one canonical
oracle independent of any player's process.

The master generates a cryptographically random 64-bit gameplay session ID at
registration. It returns the ID to the host, omits it from lobby listings,
returns it to a joining client with the UDP endpoint, and cryptographically
binds it into the short-lived join token. The 16-character hexadecimal text
form avoids precision loss in JSON; ports parse it into the fixed-width
`uint64_t` packet-header field.

The production master runs on Node.js 22 in Azure Functions Flex Consumption.
It scales to zero, keeps no lobby state in process memory, and stores only
bounded discovery metadata in Azure Table Storage. Gameplay packets never
traverse the master service; they use the separately budgeted UDP relay.

## Explicit opt-in and match flow

Offline play is the default. A port must not open a socket, resolve the master
hostname, issue an HTTPS request, advertise a lobby or send a heartbeat until
the player explicitly enters **Online Multiplayer**. Leaving the online flow
tears down its network session. Campaign and local split-screen remain usable
without network permission or connectivity.

Admission completes before game selection begins. The host then owns this
ordered flow:

1. Broadcast the lobby roster, match mode, map and rules.
2. Enter a synchronized tank/loadout selection phase.
3. Accept one selection and ready state for each assigned player slot.
4. Lock the roster and broadcast the validated selections, random seed,
   initial simulation tick and load command.
5. Start only after every admitted peer reports that loading completed.

Normal online play gives each device one full-screen local camera. Remote
players are ordinary tanks in the shared world, not additional viewports.
Split-screen is used only when a future port explicitly admits multiple local
players from the same device; that device alone renders those local cameras.

The recovered retail simulation remains the initial four-player authority, but
it runs in the dedicated headless process rather than in a player's client.
The server maps authenticated relay slots 1..4 to controller/player slots 0..3
and never trusts a packet-supplied player ID. Clients may predict locally, but
server snapshots and replay corrections are canonical. Cross-architecture
release requires this boundary because PC, ARM and PowerPC floating-point
execution must not be presumed deterministic.

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
