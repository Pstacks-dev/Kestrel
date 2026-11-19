#!/usr/bin/env bash
set -euo pipefail

BRIDGE="${KESTREL_COMPUTE_BRIDGE:-br-kestrel}"
FORWARD_CHAIN="KESTREL-COMPUTE-FWD"
INPUT_CHAIN="KESTREL-COMPUTE-IN"
IP6_FORWARD_CHAIN="KESTREL-COMPUTE6-FWD"
IP6_INPUT_CHAIN="KESTREL-COMPUTE6-IN"

for command in ip iptables ip6tables sysctl; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing required command: $command" >&2; exit 1; }
done
ip link show "$BRIDGE" >/dev/null 2>&1 || { echo "Compute bridge $BRIDGE does not exist" >&2; exit 1; }

modprobe br_netfilter 2>/dev/null || true
sysctl -w net.bridge.bridge-nf-call-iptables=1 >/dev/null
sysctl -w net.bridge.bridge-nf-call-ip6tables=1 >/dev/null

iptables -w -N "$FORWARD_CHAIN" 2>/dev/null || true
iptables -w -F "$FORWARD_CHAIN"
for network in \
  0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 \
  169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 \
  192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4; do
  iptables -w -A "$FORWARD_CHAIN" -i "$BRIDGE" -d "$network" -j DROP
done
iptables -w -A "$FORWARD_CHAIN" -o "$BRIDGE" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -w -A "$FORWARD_CHAIN" -o "$BRIDGE" -j DROP
iptables -w -A "$FORWARD_CHAIN" -i "$BRIDGE" -m conntrack --ctstate NEW,ESTABLISHED,RELATED -j ACCEPT
iptables -w -A "$FORWARD_CHAIN" -j RETURN
iptables -w -C FORWARD -i "$BRIDGE" -j "$FORWARD_CHAIN" 2>/dev/null || iptables -w -I FORWARD 1 -i "$BRIDGE" -j "$FORWARD_CHAIN"
iptables -w -C FORWARD -o "$BRIDGE" -j "$FORWARD_CHAIN" 2>/dev/null || iptables -w -I FORWARD 1 -o "$BRIDGE" -j "$FORWARD_CHAIN"

# Permit optional host DHCP/DNS services, but deny other guest-to-host traffic.
iptables -w -N "$INPUT_CHAIN" 2>/dev/null || true
iptables -w -F "$INPUT_CHAIN"
iptables -w -A "$INPUT_CHAIN" -p udp --dport 67 -j ACCEPT
iptables -w -A "$INPUT_CHAIN" -p udp --dport 53 -j ACCEPT
iptables -w -A "$INPUT_CHAIN" -p tcp --dport 53 -j ACCEPT
iptables -w -A "$INPUT_CHAIN" -j DROP
iptables -w -C INPUT -i "$BRIDGE" -j "$INPUT_CHAIN" 2>/dev/null || iptables -w -I INPUT 1 -i "$BRIDGE" -j "$INPUT_CHAIN"

ip6tables -w -N "$IP6_FORWARD_CHAIN" 2>/dev/null || true
ip6tables -w -F "$IP6_FORWARD_CHAIN"
for network in ::/128 ::1/128 fc00::/7 fe80::/10 ff00::/8; do
  ip6tables -w -A "$IP6_FORWARD_CHAIN" -i "$BRIDGE" -d "$network" -j DROP
done
ip6tables -w -A "$IP6_FORWARD_CHAIN" -o "$BRIDGE" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables -w -A "$IP6_FORWARD_CHAIN" -o "$BRIDGE" -j DROP
ip6tables -w -A "$IP6_FORWARD_CHAIN" -i "$BRIDGE" -m conntrack --ctstate NEW,ESTABLISHED,RELATED -j ACCEPT
ip6tables -w -A "$IP6_FORWARD_CHAIN" -j RETURN
ip6tables -w -C FORWARD -i "$BRIDGE" -j "$IP6_FORWARD_CHAIN" 2>/dev/null || ip6tables -w -I FORWARD 1 -i "$BRIDGE" -j "$IP6_FORWARD_CHAIN"
ip6tables -w -C FORWARD -o "$BRIDGE" -j "$IP6_FORWARD_CHAIN" 2>/dev/null || ip6tables -w -I FORWARD 1 -o "$BRIDGE" -j "$IP6_FORWARD_CHAIN"

ip6tables -w -N "$IP6_INPUT_CHAIN" 2>/dev/null || true
ip6tables -w -F "$IP6_INPUT_CHAIN"
ip6tables -w -A "$IP6_INPUT_CHAIN" -j DROP
ip6tables -w -C INPUT -i "$BRIDGE" -j "$IP6_INPUT_CHAIN" 2>/dev/null || ip6tables -w -I INPUT 1 -i "$BRIDGE" -j "$IP6_INPUT_CHAIN"

echo "Kestrel compute bridge egress and host-input policy installed for $BRIDGE"
