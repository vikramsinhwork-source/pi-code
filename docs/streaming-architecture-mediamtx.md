# RailWatch Streaming Architecture (MediaMTX)

This document describes the MediaMTX-based streaming pipeline used after the go2rtc migration.

## Pipeline overview

```mermaid
flowchart LR
  NVR[Dahua_NVR_RTSP] --> MTX[MediaMTX_on_Pi]
  MTX --> RTSP[RTSP_8554]
  MTX --> HLS[HLS_8888]
  MTX --> WebRTC[WebRTC_8889]
  WebRTC --> Client[Flutter_Web_WebView]
  Backend[railway_monitor] -->|GET_webrtc_url| Client
  Agent[Pi_agent] -->|register_paths_health_ip| Backend
```

Production playback uses **direct Pi LAN URLs** (go2rtc-style): each lobby’s Raspberry Pi is reached at `http://{pi_ip}:8889/{path}/`. No public edge proxy is required when monitors are on the same private network/VPN as the Pis.

## Pi (pi-code)

MediaMTX runs as the only media gateway on each Raspberry Pi.

| Port | Protocol | Purpose |
|------|----------|---------|
| 9997 | HTTP API | Path health (`/v3/paths/list`) |
| 8554 | RTSP | Local debugging / agent JPEG snapshots |
| 8888 | HLS | Optional browser fallback |
| 8889 | WebRTC | Low-latency browser playback |

Configuration: [`docs/mediamtx.example.yml`](mediamtx.example.yml)

Install: [`agent/scripts/install-mediamtx.sh`](../agent/scripts/install-mediamtx.sh)

Camera paths: `camera1`–`camera5` (Dahua substream RTSP, TCP, on-demand). Kiosk paths (`kiosk1`, `kiosk2`) are stubs until VNC is migrated.

The Pi agent:

- Registers with backend including `mediamtxPaths` and `ipAddress`
- Polls MediaMTX API for stream health (no SDP/WebRTC proxying)
- Does **not** call go2rtc endpoints

Set `webrtcAdditionalHosts` in `mediamtx.yml` to each Pi’s LAN IP.

Local validation:

```bash
curl -s http://127.0.0.1:9997/v3/paths/list | jq .
# Browser: http://127.0.0.1:8889/camera1/
node agent/scripts/mediamtx-diagnose.js camera1
```

## Backend (railway-monitor)

Control plane only — no media transport.

- Pi registration stores camera mappings in `stream_cameras` (`pi_device_id` + `mediamtx_path`)
- Pi `ip_address` from agent heartbeat/online is used to build play URLs
- Lobby stream discovery: `GET /api/monitoring/lobby-streams` (includes `pi_ip`)
- Play URL issuance: `GET /api/cameras/:id/webrtc-url`

Response example (direct mode, default):

```json
{
  "success": true,
  "data": {
    "url": "http://192.168.1.10:8889/camera1",
    "token": null,
    "expiresAt": null,
    "camera": {
      "id": "...",
      "legacyId": "<pi-uuid>_camera1",
      "mediamtxPath": "camera1",
      "piIp": "192.168.1.10"
    }
  }
}
```

Environment (direct mode, default):

| Variable | Default | Purpose |
|----------|---------|---------|
| `PI_WEBRTC_PLAYBACK_MODE` | `direct` | `direct` = Pi IP; `edge` = public proxy URL |
| `MEDIAMTX_WEBRTC_SCHEME` | `http` | Scheme for Pi WebRTC page |
| `MEDIAMTX_WEBRTC_PORT` | `8889` | MediaMTX WebRTC port on Pi |

Optional edge mode (`PI_WEBRTC_PLAYBACK_MODE=edge`):

- `EDGE_WEBRTC_BASE_URL` — e.g. `https://edge.railwatch.in/webrtc`
- `EDGE_WEBRTC_JWT_SECRET` — optional token for edge validation
- `EDGE_WEBRTC_TOKEN_TTL_SEC` — default 3600

Legacy go2rtc WHEP proxy and socket stream-session SDP relay have been removed.

## Flutter client (remote_monitoring_system)

1. Load cameras from `GET /api/monitoring/lobby-streams`
2. For Pi cameras, fetch `GET /api/cameras/{id}/webrtc-url`
3. Render the returned URL in `MediaMtxStreamView` (WebView)

Camera id format for API: `{piDeviceId}_{mediamtxPath}` (e.g. `b6ee0d2b-..._camera1`).

Android requires `usesCleartextTraffic="true"` for `http://` Pi URLs on private LAN.

## Optional edge proxy

Only needed if monitors cannot reach Pi IPs directly (public internet without VPN).

- `https://edge.railwatch.in/webrtc/camera1` → Pi `http://<pi-host>:8889/camera1/`
- Set `PI_WEBRTC_PLAYBACK_MODE=edge` on backend

## TURN

MediaMTX is configured with:

```yaml
webrtcICEServers2:
  - url: turn:turn.railwaymonitor.in:3478
    username: turnuser
    password: turnpassword
    clientOnly: true
```

Browsers connect through TURN when direct paths to the Pi are blocked.

## Migration notes

- go2rtc (port 1984), custom SDP relay, and socket `request-stream` CCTV signaling are deprecated
- `devices.go2rtc_status` column now stores MediaMTX health snapshots for compatibility
- Playback URL strategy matches go2rtc LAN model: per-Pi IP, not video through backend
