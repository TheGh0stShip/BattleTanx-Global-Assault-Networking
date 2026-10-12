#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "Run this installer as root (for example: sudo scripts/install-relay-vm.sh)." >&2
    exit 1
fi

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
relay_port=${BTGA_RELAY_PORT:-30420}

case "$relay_port" in
    ''|*[!0-9]*) echo "BTGA_RELAY_PORT must be numeric." >&2; exit 1 ;;
esac
if [ "$relay_port" -lt 1024 ] || [ "$relay_port" -gt 65535 ]; then
    echo "BTGA_RELAY_PORT must be between 1024 and 65535." >&2
    exit 1
fi

if [ ! -t 0 ]; then
    echo "Run from an interactive terminal so the secret cannot enter a command line or pipe." >&2
    exit 1
fi

printf 'Enter the BTGA master/relay secret (input hidden): ' >&2
stty -echo
IFS= read -r master_secret
stty echo
printf '\n' >&2
trap 'stty echo 2>/dev/null || true' EXIT HUP INT TERM

secret_bytes=$(printf %s "$master_secret" | wc -c | tr -d ' ')
if [ "$secret_bytes" -lt 32 ]; then
    master_secret=''
    echo "The secret must contain at least 32 bytes." >&2
    exit 1
fi
if ! printf %s "$master_secret" | LC_ALL=C grep -Eq '^[A-Za-z0-9._~+/=-]+$'; then
    master_secret=''
    echo "The secret must use a single environment-safe Base64/hex token." >&2
    exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates docker.io
systemctl enable --now docker

docker build --pull --tag btga-udp-relay:local "$repo_root/server/relay"

umask 077
environment_file=$(mktemp)
printf 'BTGA_MASTER_SECRET=%s\nBTGA_RELAY_PORT=%s\n' \
    "$master_secret" "$relay_port" > "$environment_file"
master_secret=''
install -o root -g root -m 600 "$environment_file" /etc/btga-relay.env
rm -f "$environment_file"

unit_file=$(mktemp)
cat > "$unit_file" <<EOF
[Unit]
Description=BattleTanx Global Assault authenticated UDP relay
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
Restart=always
RestartSec=3
EnvironmentFile=/etc/btga-relay.env
ExecStartPre=-/usr/bin/docker rm -f btga-udp-relay
ExecStart=/usr/bin/docker run --rm --name btga-udp-relay --env-file /etc/btga-relay.env -p ${BTGA_RELAY_PORT}:${BTGA_RELAY_PORT}/udp btga-udp-relay:local
ExecStop=/usr/bin/docker stop -t 10 btga-udp-relay
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
EOF
install -o root -g root -m 644 "$unit_file" /etc/systemd/system/btga-relay.service
rm -f "$unit_file"

systemctl daemon-reload
systemctl enable --now btga-relay.service
systemctl --no-pager --full status btga-relay.service

echo "Relay installed. Verify UDP ${relay_port} is listening with: ss -lun"
