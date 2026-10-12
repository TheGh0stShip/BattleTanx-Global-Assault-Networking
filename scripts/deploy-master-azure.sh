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
package=${3:-"$repo_root/build/btga-master-source.zip"}

command -v az >/dev/null 2>&1 || { echo "Azure CLI is required" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }

if [ ! -f "$package" ]; then
    "$repo_root/scripts/package-master.sh" "$package" >/dev/null
fi

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
[ "$count" = 6 ] || {
    echo "deployment indexed $count functions; expected 6" >&2
    exit 1
}

echo "deployed and indexed 6 functions"
