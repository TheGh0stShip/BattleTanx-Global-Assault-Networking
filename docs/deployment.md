# Azure deployment

The master service targets Azure Functions Flex Consumption with Node.js 22,
512 MiB instances, zero always-ready instances, and Azure Table Storage. This
keeps the control plane at scale-to-zero pricing. No paid gameplay relay is
part of this deployment.

## Required application settings

- `AzureWebJobsStorage`: private storage connection used by Functions and the
  lobby table.
- `BTGA_MASTER_SECRET`: at least 32 random bytes; rotate through Azure settings
  and never place it in source control or command output.
- `BTGA_LOBBY_TABLE`: optional table name; defaults to `BtgaLobbies`.
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

## Cost and safety controls

- Keep `alwaysReady` empty and cap maximum scale-out conservatively.
- Keep the Log Analytics daily ingestion cap and retention limit explicit.
- Do not deploy a UDP relay until direct gameplay transport is implemented and
  measured.
- Never print or commit Azure connection strings, account keys, host secrets,
  deployment packages, lobby data, or subscription identifiers.
