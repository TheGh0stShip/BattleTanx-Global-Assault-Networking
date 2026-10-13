# Security, privacy, and cost controls

This is the central control inventory for the BattleTanx: Global Assault
multiplayer service. It describes implemented controls and remaining risk; it
does not claim that an Internet service can be risk-free.

## Player and network behavior

- Multiplayer is opt-in. Starting the game does not open a socket, resolve a
  multiplayer hostname, or contact the service.
- Leaving the online flow closes the platform UDP socket and returns the client
  to the offline state.
- Clients and hosts use outbound UDP to the relay. There is no UPnP, NAT-PMP,
  inbound home-router port forwarding, or peer IP disclosure through the lobby
  API.
- Each remote player renders one full-screen local camera. Online play does not
  emulate split-screen or transmit rendered frames.

## Trust boundaries and authentication

- The HTTPS master is the only component holding the Ed25519 private signing
  key. It issues short-lived, single-use relay admission tokens.
- The Internet-facing relay receives only the Ed25519 public verification key.
  Compromising the relay cannot mint new admission tokens.
- Host administration credentials are separately HMAC-hashed with
  `BTGA_MASTER_SECRET`; neither raw host credentials nor that secret are stored
  by the relay.
- Admission nonces are bound to one source endpoint and rejected if replayed
  from another endpoint.
- Unauthenticated and malformed UDP input is dropped silently to avoid a
  reflection oracle.
- Client traffic can target only the authenticated host. Only the host can
  address clients or broadcast within its authenticated session.
- Inner packets must carry the authenticated session and source slot. Payloads
  are capped at 1,200 bytes; relay envelopes are capped at 1,224 bytes.

## Resource and abuse bounds

- Public HTTP routes that allocate, extend or probe state are rate limited by
  durable token buckets shared across Function instances: per address, per
  lobby and address, per lobby, per address for credential failures, and
  globally for lobby creation. Defaults, the storage and cost impact, and
  tuning are in [ABUSE_PROTECTION.md](ABUSE_PROTECTION.md); threats and
  residual risk are in [THREAT_MODEL.md](THREAT_MODEL.md).
- Only the `X-Forwarded-For` entry appended by Azure's front end identifies a
  caller. Client-settable address headers are ignored, and IPv6 callers are
  grouped by `/64`.

- Maximum advertised lobby size: 16 players.
- Maximum relay sessions per process: 256 by default.
- Idle peer mappings expire after 90 seconds.
- Per-peer ingress forwarding budget: 128 KiB/s by default.
- Process-wide relay egress budget: 160 KiB/s by default, independent of
  session count and broadcast fan-out.
- The relay container has a read-only root filesystem, no Linux capabilities,
  `no-new-privileges`, 128-process, 192 MiB memory and 0.75 CPU limits, a small
  no-exec temporary filesystem, and bounded local logs.

## Azure exposure and maintenance

- The relay NSG exposes one public surface: UDP 30420.
- There is no public TCP or SSH ingress. Routine maintenance uses authenticated
  Azure Run Command; emergency recovery uses the Azure serial console.
- The installer disables the SSH daemon and enables unattended security
  updates.
- The relay VM contains no master secret or private signing key.
- Deployment files contain no ROM, player credential, Azure secret, or private
  key. Local parameter files and generated deployment output remain ignored.

## Cost controls

- The resource group has a $60 USD monthly Cost Management budget with actual
  alerts at 50%, 75%, and 90%, and a forecast alert at 80%.
- Azure budgets alert but do not stop resources. The global 160 KiB/s relay
  egress bucket is the primary data-plane bound against runaway bandwidth.
- VM size, disk size, public IP count, session count, process resources, log
  size, and relay egress are explicitly bounded. Scaling requires a reviewed
  configuration change rather than an automatic fan-out policy.
- The default B1s relay has one vCPU and 1 GiB RAM. One core is sufficient for
  the single-process forwarding workload; B1s was selected over B1ls to avoid
  an unsafe 0.5 GiB operating-system/container memory margin.

## Logging and privacy

- Do not log admission tokens, host credentials, signing keys, storage
  connection strings, complete packet payloads, or user-provided ROM data.
- Operational metrics are aggregate counters: accepted bindings, forwarded
  datagrams, drops, and expirations.
- Master security events (`type: "btga_security"`) contain only allow-listed
  fields and keyed 12-digit pseudonyms. They never contain addresses, lobby
  names or IDs, request bodies, tokens or secrets.
- Container logs rotate locally at 10 MiB with three files. Longer retention or
  centralized collection requires an explicit privacy and cost review.

## Incident response

1. Stop new joins by disabling or restricting the master service.
2. Deallocate the relay VM or remove its UDP NSG rule to stop forwarding.
3. Rotate the Ed25519 key pair if admission signing may be compromised. Deploy
   the new public key to the relay and private key to the master separately.
4. Rotate `BTGA_MASTER_SECRET` if host-control credentials may be compromised;
   this invalidates stored host credential hashes.
5. Preserve bounded platform and service logs without publishing tokens, IP
   addresses, subscription identifiers, or secrets.
6. Redeploy only from a reviewed commit and rerun the full native, master,
   relay, infrastructure, and license gates.

## Residual risk

The global egress bucket bounds cost but may allow one abusive authenticated
session to reduce service quality for others. UDP source addresses can be
spoofed before a valid token is bound, although silent unauthenticated drops
prevent useful reflection. A single small VM is intentionally inexpensive but
is not highly available. Public testing should begin with a small invited group
and monitored cost/traffic alerts before increasing any limit.
