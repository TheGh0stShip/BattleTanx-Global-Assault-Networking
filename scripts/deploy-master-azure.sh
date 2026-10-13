#!/usr/bin/env sh
set -eu

usage() {
    echo "usage: $0 RESOURCE_GROUP FUNCTION_APP [PACKAGE]" >&2
    exit 2
}

[ "$#" -ge 2 ] && [ "$#" -le 3 ] || usage
resource_group=$1
function_app=$2
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ "$#" -eq 3 ]; then
    package=$3
    [ -f "$package" ] || {
        echo "explicit deployment package does not exist: $package" >&2
        exit 1
    }
else
    package="$repo_root/build/btga-master-source.zip"
    # A default deployment always packages the checked-out source. Reusing a
    # prior archive can silently deploy code from an older commit while every
    # local test is running against the current tree.
    "$repo_root/scripts/package-master.sh" "$package" >/dev/null
fi

command -v az >/dev/null 2>&1 || { echo "Azure CLI is required" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }

runtime=$(az resource show \
    --resource-group "$resource_group" \
    --name "$function_app" \
    --resource-type Microsoft.Web/sites \
    --api-version 2024-04-01 \
    --query properties.functionAppConfig.runtime -o json)

[ "$(printf '%s' "$runtime" | jq -r .name)" = node ] || {
    echo "refusing deployment: function runtime is not Node.js" >&2
    exit 1
}
[ "$(printf '%s' "$runtime" | jq -r .version)" = 22 ] || {
    echo "refusing deployment: function runtime is not Node.js 22" >&2
    exit 1
}

# Keep the service inside its reviewed cost and concurrency envelope. This is
# part of deployment rather than a portal-only setting so it cannot drift.
az functionapp scale config set \
    --resource-group "$resource_group" \
    --name "$function_app" \
    --maximum-instance-count 2 \
    --trigger-type http \
    --trigger-settings perInstanceConcurrency=8 \
    --output none

scale=$(az functionapp scale config show \
    --resource-group "$resource_group" \
    --name "$function_app" -o json)
[ "$(printf '%s' "$scale" | jq -r .maximumInstanceCount)" = 2 ] || {
    echo "refusing deployment: maximum instance count is not 2" >&2
    exit 1
}
[ "$(printf '%s' "$scale" | jq -r '.triggers.http.perInstanceConcurrency')" = 8 ] || {
    echo "refusing deployment: HTTP per-instance concurrency is not 8" >&2
    exit 1
}

az functionapp deployment source config-zip \
    --resource-group "$resource_group" \
    --name "$function_app" \
    --src "$package" \
    --build-remote true \
    --output none

count=$(az functionapp function list \
    --resource-group "$resource_group" \
    --name "$function_app" \
    --query 'length(@)' -o tsv)
[ "$count" = 8 ] || {
    echo "deployment indexed $count functions; expected 8" >&2
    exit 1
}

echo "deployed and indexed 8 functions"
