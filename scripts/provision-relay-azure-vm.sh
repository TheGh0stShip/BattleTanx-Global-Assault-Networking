#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "Run this provisioner as root through Azure Run Command." >&2
    exit 1
fi
if [ "$#" -eq 2 ]; then
    relay_public_key=$1
    reviewed_commit=$2
elif [ "$#" -eq 0 ] && [ -n "${RELAY_PUBLIC_KEY:-}" ] && [ -n "${REVIEWED_COMMIT:-}" ]; then
    relay_public_key=$RELAY_PUBLIC_KEY
    reviewed_commit=$REVIEWED_COMMIT
else
    echo "usage: $0 RELAY_PUBLIC_KEY REVIEWED_COMMIT" >&2
    echo "or set RELAY_PUBLIC_KEY and REVIEWED_COMMIT for Azure Run Command" >&2
    exit 2
fi
case "$reviewed_commit" in
    ''|*[!0-9a-f]*) echo "REVIEWED_COMMIT must be a hexadecimal Git commit." >&2; exit 1 ;;
esac
if [ "${#reviewed_commit}" -lt 7 ] || [ "${#reviewed_commit}" -gt 40 ]; then
    echo "REVIEWED_COMMIT must contain 7 to 40 hexadecimal characters." >&2
    exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates git

repo=/opt/btga-networking
if [ ! -d "$repo/.git" ]; then
    git clone --filter=blob:none \
        https://github.com/TheGh0stShip/BattleTanx-Global-Assault-Networking.git \
        "$repo"
fi
git -C "$repo" fetch --depth 1 origin "$reviewed_commit"
git -C "$repo" checkout --detach FETCH_HEAD

actual_commit=$(git -C "$repo" rev-parse HEAD)
case "$actual_commit" in
    "$reviewed_commit"*) ;;
    *) echo "Fetched commit does not match the reviewed commit." >&2; exit 1 ;;
esac

BTGA_RELAY_PUBLIC_KEY=$relay_public_key "$repo/scripts/install-relay-vm.sh"
relay_public_key=''

systemctl is-active --quiet btga-relay.service
systemctl is-enabled --quiet btga-relay.service
ss -lun | grep -q ':30420'
echo "Relay provisioned from $actual_commit and listening on UDP 30420."
