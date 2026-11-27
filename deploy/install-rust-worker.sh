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
read -r -p "Worker concurrency [1]: " WORKER_CONCURRENCY
WORKER_CONCURRENCY=${WORKER_CONCURRENCY:-1}
if [[ ! "$WORKER_CONCURRENCY" =~ ^[1-8]$ ]]; then echo "Concurrency must be between 1 and 8." >&2; exit 1; fi
read -r -s -p "One-time worker token: " WORKER_TOKEN
echo

if [[ ! "$WORKER_ID" =~ ^wrk_[A-Za-z0-9_-]{8,100}$ ]]; then
  echo "Invalid worker ID. Use the provisioned wrk_ ID from Kestrel." >&2; exit 1
fi
if [[ ${#WORKER_TOKEN} -lt 32 ]]; then
  echo "The one-time worker token must contain at least 32 characters." >&2; exit 1
fi
if [[ ! "$API_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$ ]]; then
  echo "API URL must be a clean HTTPS origin without credentials, path, query or fragment." >&2; exit 1
fi
if [[ ! "$WORKER_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]]; then
  echo "Worker hostname must use 1-80 letters, numbers, dots, underscores or hyphens." >&2; exit 1
fi
if [[ ! "$WORKER_REGION" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]]; then
  echo "Region label must use 1-80 letters, numbers, dots, underscores or hyphens." >&2; exit 1
fi
API_URL=${API_URL%/}

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git build-essential docker.io iptables

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
  git clone --depth 1 https://github.com/Pstacks-dev/Kestrel.git /opt/kestrel
fi
cd /opt/kestrel
cargo build --release --manifest-path runtime/rust/Cargo.toml

# Install and activate the Docker egress firewall before any customer job can run.
# The worker service requires this unit, so a failed firewall setup is fail-closed.
chmod 0755 /opt/kestrel/deploy/harden-worker-egress.sh
install -m 0644 /opt/kestrel/deploy/kestrel-worker-egress.service /etc/systemd/system/kestrel-worker-egress.service
systemctl daemon-reload
systemctl enable --now kestrel-worker-egress.service

install -d -o kestrel -g kestrel -m 0750 /var/lib/kestrel/work
install -d -o root -g kestrel -m 0750 /etc/kestrel
umask 077
cat > /etc/kestrel/worker.env <<EOF
NODE_ENV=production
KESTREL_API_URL=$API_URL
KESTREL_WORKER_ID=$WORKER_ID
HOSTNAME=$WORKER_HOST
KESTREL_WORKER_TOKEN=$WORKER_TOKEN
KESTREL_REGION=$WORKER_REGION
KESTREL_CONCURRENCY=$WORKER_CONCURRENCY
KESTREL_WORKER_WORKDIR=/var/lib/kestrel/work
KESTREL_JOB_IMAGE=docker.io/library/node:22-bookworm-slim@sha256:be979e5523c76fa4d5ca4ebd3099078f220aa47ec39c48ad5b5df9314debd6eb
KESTREL_JOB_NETWORK=bridge
EOF
chown root:kestrel /etc/kestrel/worker.env
chmod 0640 /etc/kestrel/worker.env
unset WORKER_TOKEN

cat > /etc/systemd/system/kestrel-rust-worker.service <<'UNIT'
[Unit]
Description=Kestrel Rust execution and deployment worker
After=network-online.target docker.service kestrel-worker-egress.service
Wants=network-online.target
Requires=docker.service kestrel-worker-egress.service

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
if ! systemctl is-active --quiet kestrel-rust-worker.service; then
  echo "Kestrel worker failed to start. Recent service logs:" >&2
  journalctl -u kestrel-rust-worker.service -n 80 --no-pager >&2 || true
  exit 1
fi
systemctl --no-pager --full status kestrel-rust-worker.service

echo
echo "Installer finished. Check the Kestrel dashboard for this worker's Online status."
echo "Service logs: journalctl -u kestrel-rust-worker -f"
echo "Docker access via the docker group is root-equivalent. Use a dedicated host."
