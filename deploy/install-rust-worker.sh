#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Run this installer with sudo/root." >&2
  exit 1
fi
if ! command -v apt-get >/dev/null 2>&1; then
  echo "This installer currently supports Ubuntu/Debian (apt)." >&2
  exit 1
fi

echo "Kestrel Rust deployment worker installer"
read -r -p "Worker ID: " WORKER_ID
read -r -p "Kestrel API base URL [https://kestrel-ci-cd.vercel.app]: " API_URL
API_URL=${API_URL:-https://kestrel-ci-cd.vercel.app}
read -r -p "Worker hostname/name [$(hostname)]: " WORKER_HOST
WORKER_HOST=${WORKER_HOST:-$(hostname)}
read -r -p "Region label [unknown]: " WORKER_REGION
WORKER_REGION=${WORKER_REGION:-unknown}
read -r -s -p "One-time worker token: " WORKER_TOKEN
echo

if [[ ! "$WORKER_ID" =~ ^[A-Za-z0-9_-]{3,128}$ ]]; then
  echo "Invalid worker ID format." >&2; exit 1
fi
if [[ -z "$WORKER_TOKEN" || ! "$API_URL" =~ ^https:// ]]; then
  echo "Token is required and API URL must use HTTPS." >&2; exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git build-essential docker.io

systemctl enable --now docker
if ! getent group kestrel >/dev/null; then groupadd --system kestrel; fi
if ! id kestrel >/dev/null 2>&1; then useradd --system --gid kestrel --home-dir /var/lib/kestrel --create-home --shell /usr/sbin/nologin kestrel; fi
usermod -aG docker kestrel

if ! command -v cargo >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
fi
export PATH="/root/.cargo/bin:$PATH"
if ! command -v cargo >/dev/null 2>&1; then
  echo "Rust/Cargo installation failed." >&2; exit 1
fi

install -d -o root -g kestrel -m 0750 /opt/kestrel
if [[ -d /opt/kestrel/.git ]]; then
  git -C /opt/kestrel fetch --depth 1 origin main
  git -C /opt/kestrel reset --hard FETCH_HEAD
else
  git clone --depth 1 https://github.com/peterakinwale326-code/Kestrel.git /opt/kestrel
fi
cd /opt/kestrel
cargo build --release --manifest-path runtime/rust/Cargo.toml

install -d -o kestrel -g kestrel -m 0750 /var/lib/kestrel/work
install -d -o root -g kestrel -m 0750 /etc/kestrel
umask 077
cat > /etc/kestrel/worker.env <<EOF
KESTREL_API_URL=$API_URL
KESTREL_WORKER_ID=$WORKER_ID
KESTREL_WORKER_TOKEN=$WORKER_TOKEN
KESTREL_REGION=$WORKER_REGION
KESTREL_CONCURRENCY=1
KESTREL_WORKER_WORKDIR=/var/lib/kestrel/work
KESTREL_JOB_IMAGE=node:22-bookworm-slim
KESTREL_JOB_NETWORK=bridge
EOF
chown root:kestrel /etc/kestrel/worker.env
chmod 0640 /etc/kestrel/worker.env
unset WORKER_TOKEN

cat > /etc/systemd/system/kestrel-rust-worker.service <<'UNIT'
[Unit]
Description=Kestrel Rust execution and deployment worker
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
User=kestrel
Group=kestrel
SupplementaryGroups=docker
WorkingDirectory=/opt/kestrel
EnvironmentFile=/etc/kestrel/worker.env
ExecStart=/opt/kestrel/runtime/rust/target/release/kestrel-runtime
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=/var/lib/kestrel/work
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now kestrel-rust-worker.service
sleep 3
systemctl --no-pager --full status kestrel-rust-worker.service || true

echo
echo "Installer finished. Check the Kestrel dashboard for this worker's Online status."
echo "Service logs: journalctl -u kestrel-rust-worker -f"
echo "Docker access via the docker group is root-equivalent. Use a dedicated host."
