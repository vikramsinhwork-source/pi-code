#!/bin/bash
# RailWatch Pi — restrict MediaMTX WebRTC (8889) to station LAN + localhost.
# Adjust STATION_LAN_CIDR before running (default 192.168.1.0/24).
#
# Usage:
#   chmod +x agent/scripts/ufw-mediamtx-lan.sh
#   sudo ./agent/scripts/ufw-mediamtx-lan.sh

set -euo pipefail

STATION_LAN_CIDR="${STATION_LAN_CIDR:-192.168.1.0/24}"

if ! command -v ufw >/dev/null 2>&1; then
  echo "ufw not installed; install with: sudo apt install ufw"
  exit 1
fi

echo "Applying ufw rules for MediaMTX WebRTC port 8889 (LAN: ${STATION_LAN_CIDR})"

ufw default deny incoming
ufw allow from 127.0.0.1 to any port 8889 proto tcp
ufw allow from 127.0.0.1 to any port 8889 proto udp
ufw allow from "${STATION_LAN_CIDR}" to any port 8889 proto tcp
ufw allow from "${STATION_LAN_CIDR}" to any port 8889 proto udp

# SSH and agent outbound are unchanged; enable only after reviewing:
#   sudo ufw status numbered
echo "Review rules, then run: sudo ufw enable"
