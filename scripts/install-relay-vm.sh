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

if [ -n "${BTGA_RELAY_PUBLIC_KEY:-}" ]; then
    relay_public_key=$BTGA_RELAY_PUBLIC_KEY
else
    printf 'Enter the Base64 Ed25519 relay public key: ' >&2
    IFS= read -r relay_public_key
fi

key_bytes=$(printf %s "$relay_public_key" | wc -c | tr -d ' ')
if [ "$key_bytes" -lt 40 ]; then
    relay_public_key=''
    echo "The public key is too short." >&2
    exit 1
fi
if ! printf %s "$relay_public_key" | LC_ALL=C grep -Eq '^[A-Za-z0-9+/=]+$'; then
    relay_public_key=''
    echo "The public key must be one Base64 token." >&2
    exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates docker.io unattended-upgrades
systemctl enable --now docker

# The production NSG has no SSH ingress. Disable the daemon as a second layer;
# maintenance is performed through Azure Run Command or the serial console.
systemctl disable --now ssh.service 2>/dev/null || true
systemctl disable --now ssh.socket 2>/dev/null || true
# Enable the next scheduled security-update pass without making first
# deployment wait for every image update synchronously on the smallest VM.
systemctl enable unattended-upgrades.service

docker build --pull --tag btga-udp-relay:local "$repo_root/server/relay"

umask 077
environment_file=$(mktemp)
printf 'BTGA_RELAY_PUBLIC_KEY=%s\nBTGA_RELAY_PORT=%s\n' \
    "$relay_public_key" "$relay_port" > "$environment_file"
printf '%s\n' \
    'BTGA_RELAY_MAX_SESSIONS=256' \
    'BTGA_RELAY_PEER_BYTES_PER_SECOND=131072' \
    'BTGA_RELAY_EGRESS_BYTES_PER_SECOND=163840' >> "$environment_file"
relay_public_key=''
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
ExecStart=/usr/bin/docker run --rm --name btga-udp-relay --env-file /etc/btga-relay.env --read-only --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 128 --memory 192m --cpus 0.75 --tmpfs /tmp:rw,noexec,nosuid,size=16m --log-driver local --log-opt max-size=10m --log-opt max-file=3 -p ${relay_port}:${relay_port}/udp btga-udp-relay:local
ExecStop=/usr/bin/docker stop -t 10 btga-udp-relay
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
EOF
install -o root -g root -m 644 "$unit_file" /etc/systemd/system/btga-relay.service
rm -f "$unit_file"

systemctl daemon-reload
systemctl enable btga-relay.service
# `enable --now` does not restart an already active unit after rebuilding its
# Docker image. Always restart so a successful provision actually runs the
# reviewed commit rather than silently retaining the previous container.
systemctl restart btga-relay.service
systemctl --no-pager --full status btga-relay.service

echo "Relay installed. Verify UDP ${relay_port} is listening with: ss -lun"
