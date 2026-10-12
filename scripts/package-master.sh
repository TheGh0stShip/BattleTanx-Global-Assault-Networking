#!/usr/bin/env sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
output=${1:-"$repo_root/build/btga-master-source.zip"}
output_dir=$(dirname -- "$output")

mkdir -p "$output_dir"
output=$(CDPATH= cd -- "$output_dir" && pwd)/$(basename -- "$output")

cd "$repo_root/server/master"
npm test
zip -q -r "$output" \
    host.json package.json package-lock.json src \
    dashboard health status lobbies heartbeat remove_lobby join validate_join
unzip -t "$output" >/dev/null
printf '%s\n' "$output"
