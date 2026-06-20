#!/usr/bin/env bash
# Install MediaMTX on Raspberry Pi (arm64/armv7) and disable go2rtc.
set -euo pipefail

MEDIAMTX_VERSION="${MEDIAMTX_VERSION:-v1.11.3}"
INSTALL_BIN="${INSTALL_BIN:-/usr/local/bin/mediamtx}"
CONFIG_DIR="${CONFIG_DIR:-/etc/mediamtx}"
CONFIG_PATH="${CONFIG_PATH:-${CONFIG_DIR}/mediamtx.yml}"
SERVICE_NAME="${SERVICE_NAME:-mediamtx}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EXAMPLE_CONFIG="${REPO_ROOT}/docs/mediamtx.example.yml"
SERVICE_UNIT="${REPO_ROOT}/docs/mediamtx.service"

arch="$(uname -m)"
case "${arch}" in
  aarch64|arm64) MTX_ARCH="arm64" ;;
  armv7l|armv6l) MTX_ARCH="arm32v7" ;;
  x86_64|amd64) MTX_ARCH="amd64" ;;
  *)
    echo "Unsupported architecture: ${arch}" >&2
    exit 1
    ;;
esac

url="https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}/mediamtx_${MEDIAMTX_VERSION#v}_linux_${MTX_ARCH}.tar.gz"
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

echo "Downloading MediaMTX ${MEDIAMTX_VERSION} (${MTX_ARCH})..."
curl -fsSL "${url}" -o "${tmp}/mediamtx.tar.gz"
tar -xzf "${tmp}/mediamtx.tar.gz" -C "${tmp}"

sudo install -m 755 "${tmp}/mediamtx" "${INSTALL_BIN}"

sudo mkdir -p "${CONFIG_DIR}"
if [[ ! -f "${CONFIG_PATH}" ]]; then
  sudo cp "${EXAMPLE_CONFIG}" "${CONFIG_PATH}"
  echo "Installed default config at ${CONFIG_PATH} — edit RTSP sources and webrtcAdditionalHosts."
else
  echo "Keeping existing config: ${CONFIG_PATH}"
fi

sudo cp "${SERVICE_UNIT}" "/etc/systemd/system/${SERVICE_NAME}.service"
sudo systemctl daemon-reload
sudo systemctl enable "${SERVICE_NAME}"
sudo systemctl restart "${SERVICE_NAME}"

if systemctl is-active --quiet go2rtc 2>/dev/null; then
  echo "Stopping and disabling go2rtc..."
  sudo systemctl stop go2rtc || true
  sudo systemctl disable go2rtc || true
fi

echo "MediaMTX installed. Status:"
systemctl status "${SERVICE_NAME}" --no-pager || true
echo "Test: curl -s http://127.0.0.1:9997/v3/paths/list | head"
