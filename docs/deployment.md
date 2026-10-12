# Azure deployment

The master service targets Azure Functions Flex Consumption with Node.js 22,
512 MiB instances, zero always-ready instances, and Azure Table Storage. This
keeps the control plane at scale-to-zero pricing. The UDP relay is a separate
data-plane deployment because Azure Functions and Container Apps HTTP ingress
cannot accept public UDP.

## Required application settings

- `AzureWebJobsStorage`: private storage connection used by Functions and the
  lobby table.
- `BTGA_MASTER_SECRET`: at least 32 random bytes; rotate through Azure settings
  and never place it in source control or command output.
- `BTGA_LOBBY_TABLE`: optional table name; defaults to `BtgaLobbies`.
- `BTGA_RELAY_HOST`: public DNS name of the separately deployed UDP relay.
- `BTGA_RELAY_PORT`: public relay UDP port; defaults to `30420`.
- `APPLICATIONINSIGHTS_CONNECTION_STRING`: optional bounded diagnostics.

The Function App runtime must be Node.js 22. The deployment script refuses to
publish to any other runtime:

```sh
scripts/package-master.sh
scripts/deploy-master-azure.sh RESOURCE_GROUP FUNCTION_APP
scripts/test-master-api.sh https://HOST/api/v1
```

The package script runs unit tests and creates a source package. Azure performs
the Linux remote build, avoiding host-architecture dependency mistakes.

## DNS and TLS

The stable public endpoint is `btga.thegh0stship.com`. Its Azure DNS zone uses:

- `btga` CNAME to the Function App's default hostname;
- `asuid.btga` TXT containing the App Service domain-verification identifier;
- an App Service managed certificate bound with SNI.

Certificate issuance is asynchronous. Do not create repeated certificate
requests while one is pending. Verify the final endpoint with both the health
route and `scripts/test-master-api.sh`.

## UDP relay deployment boundary

`server/relay/Dockerfile` builds the dependency-free Node.js relay. It requires
the same `BTGA_MASTER_SECRET` as the master so it can validate signed admission
tokens locally, without an HTTPS request for every datagram. Expose UDP 30420,
not TCP 30420. Never place the secret in an image layer or deployment manifest.

Azure Container Instances can expose UDP, but it has a continuously billed
minimum allocation and its public address is not durable after deletion. A
small Linux VM with a static public IP is the predictable production option;
ACI is useful for an explicitly time-bounded test. Neither should be deployed
until its monthly compute, static-IP and egress ceiling are reviewed. The relay
does not scale to zero while preserving a stable UDP endpoint.

`infra/azure/relay-vm.bicep` defines the production relay boundary without
deploying the application or carrying its shared secret. It creates one small
Ubuntu VM, a 32 GiB Standard SSD, a static Standard IPv4 address, and an NSG
with exactly two inbound exceptions:

- UDP `30420` from the Internet for authenticated relay datagrams;
- TCP `22` only from the explicitly supplied operator CIDR.

There are no TCP gameplay listeners, UPnP/NAT-PMP components, or player-facing
inbound rules. Clients and hosts both initiate outbound UDP to the relay. The
example parameters file contains documentation placeholders only and must not
be deployed unchanged.

The same resource-group deployment creates a **$60 USD monthly Cost Management
budget**, with actual-cost notifications at $30, $45 and $54 and a forecast
notification at $48. Azure documents that budgets trigger notifications but do
not stop resource consumption. The budget is therefore an early-warning layer,
not the traffic cap; the relay's global 160 KiB/s egress bucket is the bounded
data-plane control.

Validate and preview the resources before the billing gate:

```sh
az bicep build --file infra/azure/relay-vm.bicep
az deployment group what-if \
  --resource-group btga-multiplayer-prod \
  --template-file infra/azure/relay-vm.bicep \
  --parameters @infra/azure/relay-vm.parameters.local.json
```

Keep the local parameters file and all private keys untracked. Creating the VM,
disk and public address starts recurring billing, so `what-if` is not authority
to deploy. The relay container and `BTGA_MASTER_SECRET` are installed only
after explicit deployment approval; the secret must never appear in a Bicep
file, command log, container layer or GitHub artifact.

After deployment approval and VM creation, clone this repository at the exact
reviewed commit on the VM and run the installer interactively:

```sh
sudo scripts/install-relay-vm.sh
```

The installer prompts for the existing master secret with terminal echo
disabled. It builds the relay image locally, stores the secret only in a
root-readable `/etc/btga-relay.env`, and installs an auto-restarting systemd
unit. The secret is not passed as a process argument or baked into the image.
The production environment also enforces a global 160 KiB/s egress token
bucket. At continuous saturation that is about 425 GB of relay payload per
30-day month, before normal idle periods; it prevents session fan-out from
turning the per-peer rate limits into unbounded Azure egress.
Update the relay by checking out another reviewed commit and rerunning the
installer. Inspect service health with:

```sh
sudo systemctl status btga-relay
sudo journalctl -u btga-relay --since today
sudo ss -lun | grep ':30420'
```

## Cost and safety controls

- Keep `alwaysReady` empty and cap maximum scale-out conservatively.
- Keep the Log Analytics daily ingestion cap and retention limit explicit.
- Keep relay deployment opt-in and cost-gated; local tests never create Azure
  resources.
- Cap session count, datagram rate, Azure egress and logs before public testing.
- Never print or commit Azure connection strings, account keys, host secrets,
  deployment packages, lobby data, or subscription identifiers.
