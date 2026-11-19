#!/usr/bin/env bash
set -euo pipefail

# Run as root on a dedicated Linux Docker worker after dockerd has started.
# Container traffic can reach the public internet, but cannot reach the host,
# private networks, link-local cloud metadata services, or local-only services.

command -v iptables >/dev/null 2>&1 || { echo "iptables is required" >&2; exit 1; }
iptables -nL DOCKER-USER >/dev/null 2>&1 || { echo "Docker DOCKER-USER chain is unavailable; start Docker first" >&2; exit 1; }

iptables -N KESTREL-EGRESS 2>/dev/null || true
iptables -F KESTREL-EGRESS
iptables -C DOCKER-USER -j KESTREL-EGRESS 2>/dev/null || iptables -I DOCKER-USER 1 -j KESTREL-EGRESS

# Keep replies for connections initiated to public destinations.
iptables -A KESTREL-EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
# Prevent containers from reaching any address assigned to the worker host.
iptables -A KESTREL-EGRESS -m addrtype --dst-type LOCAL -j DROP
# Block private, loopback, link-local, metadata, shared-address and multicast ranges.
for cidr in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4; do
  iptables -A KESTREL-EGRESS -d "$cidr" -j DROP
done
iptables -A KESTREL-EGRESS -j RETURN

# Apply equivalent protection when Docker IPv6 forwarding is enabled.
if command -v ip6tables >/dev/null 2>&1 && ip6tables -nL DOCKER-USER >/dev/null 2>&1; then
  ip6tables -N KESTREL-EGRESS 2>/dev/null || true
  ip6tables -F KESTREL-EGRESS
  ip6tables -C DOCKER-USER -j KESTREL-EGRESS 2>/dev/null || ip6tables -I DOCKER-USER 1 -j KESTREL-EGRESS
  ip6tables -A KESTREL-EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  ip6tables -A KESTREL-EGRESS -m addrtype --dst-type LOCAL -j DROP
  for cidr in ::/128 ::1/128 fc00::/7 fe80::/10 ff00::/8; do
    ip6tables -A KESTREL-EGRESS -d "$cidr" -j DROP
  done
  ip6tables -A KESTREL-EGRESS -j RETURN
fi

echo "Kestrel Docker egress protections installed."
