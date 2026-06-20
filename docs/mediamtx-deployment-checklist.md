# MediaMTX Deployment & Testing Checklist

Use this after pulling the latest code on **backend** and **Pi**. Work top-down: backend first, then Pi, then test layer by layer.

**Related docs:** [`streaming-architecture-mediamtx.md`](streaming-architecture-mediamtx.md) · [`go2rtc-to-mediamtx-migration-audit.md`](go2rtc-to-mediamtx-migration-audit.md)

---

## Prerequisites (one-time)

- [ ] PostgreSQL running and reachable from backend
- [ ] Pi has Node.js 18+, `curl`, `ffmpeg` (optional JPEG pipeline), `pm2`
- [ ] Pi device already created in admin UI as type **RASPBERRY** with a known UUID (`DEVICE_ID`)
- [ ] Pi is assigned to the correct **lobby** and **division**
- [ ] Dahua/NVR RTSP URLs and credentials for `camera1`–`camera5`
- [ ] TURN server reachable (`turn.railwaymonitor.in:3478` or your own)

---

## Part A — Backend (after `git pull`)

Repo: `railway-monitor`

### A1. Environment

- [ ] Copy/update `.env` from `.env.example`
- [ ] Confirm DB vars: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`
- [ ] Confirm auth secrets: `JWT_SECRET`, `DEVICE_TOKEN_SECRET` (must match Pi agent)
- [ ] Add MediaMTX playback vars (direct Pi IP — default, go2rtc-style):

```bash
# Default: build play URL from each Pi devices.ip_address
PI_WEBRTC_PLAYBACK_MODE=direct
MEDIAMTX_WEBRTC_SCHEME=http
MEDIAMTX_WEBRTC_PORT=8889

# Optional edge mode only if monitors cannot reach Pi IPs (PI_WEBRTC_PLAYBACK_MODE=edge)
# EDGE_WEBRTC_BASE_URL=https://edge.railwatch.in/webrtc
# EDGE_WEBRTC_JWT_SECRET=
# EDGE_WEBRTC_TOKEN_TTL_SEC=3600
```

- [ ] Remove unused go2rtc vars if present: `GO2RTC_PORT`, `GO2RTC_HOST`, etc.

### A2. Install & database

```bash
cd railway-monitor
npm install
```

- [ ] Run migrations (creates `stream_cameras` table):

```bash
npx sequelize-cli db:migrate
```

> Note: Server also runs `sequelize.sync({ alter: true })` on startup, but running migrations explicitly is safer for production.

### A3. Start backend

```bash
npm start
# or: pm2 restart kiosk-monitor-backend  (your process name)
```

- [ ] Confirm startup log: `Server started successfully`
- [ ] Health check:

```bash
curl -s http://localhost:3000/health
```

Expected: HTTP 200

### A4. Verify new routes exist

- [ ] MediaMTX test page (browser):

```
http://<backend-host>:3000/mediamtx-test
```

- [ ] Cameras API requires auth (should return 401 without token):

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/cameras
```

Expected: `401`

---

## Part B — Pi (after `git pull`)

Repo: `pi-code`

### B1. Install MediaMTX

```bash
cd pi-code
chmod +x agent/scripts/install-mediamtx.sh
./agent/scripts/install-mediamtx.sh
```

- [ ] Script completes without error
- [ ] `systemctl status mediamtx` → **active (running)**
- [ ] go2rtc stopped (if it existed): `systemctl is-active go2rtc` → **inactive** or not found

### B2. Configure MediaMTX

Edit `/etc/mediamtx/mediamtx.yml`:

- [ ] Set correct **RTSP source URLs** for `camera1`–`camera5` (NVR IP, credentials, channel)
- [ ] Set `webrtcAdditionalHosts` to Pi's **LAN IP** and any DNS name browsers use
- [ ] Set TURN credentials under `webrtcICEServers2` (match backend `.env` TURN vars)
- [ ] Restart after edits:

```bash
sudo systemctl restart mediamtx
```

### B3. Configure Pi agent

```bash
cd pi-code/agent
cp .env.example .env   # skip if .env already exists
```

Edit `agent/.env` (and root `pi-code/.env` if you use it):

- [ ] `DEVICE_ID=<uuid-from-admin>` — must match the RASPBERRY device in backend
- [ ] `DEVICE_TOKEN_SECRET=<same as backend>`
- [ ] `API_URL` / `SOCKET_URL` → your backend URL
- [ ] `STATION_CODE` → your station
- [ ] **Remove** old `GO2RTC_URL` if still present
- [ ] Add MediaMTX vars:

```bash
MEDIAMTX_API_URL=http://127.0.0.1:9997
MEDIAMTX_WEBRTC_BASE_URL=http://127.0.0.1:8889
MEDIAMTX_PATHS=camera1,camera2,camera3,camera4,camera5
JPEG_PIPELINE_ENABLED=false
```

- [ ] Install deps and start agent:

```bash
npm install
pm2 restart railwatch-agent
# or first time: pm2 start ecosystem.config.js && pm2 save
```

- [ ] Check agent logs:

```bash
pm2 logs railwatch-agent --lines 50
```

Look for: socket connected, no go2rtc errors, stream-status posts succeeding.

### B4. Sudo for remote restart (optional)

Agent `restart-mediamtx` runs `sudo systemctl restart mediamtx`. Ensure the `pi` user can run it without password, or run mediamtx restarts manually.

---

## Part C — Test streaming (layer by layer)

Test in this order. Do not skip to Flutter until Pi-local and backend API tests pass.

---

### C1. Pi-local tests (no backend, no Flutter)

**Goal:** Confirm MediaMTX pulls RTSP and serves WebRTC on the Pi itself.

#### C1.1 API health

```bash
curl -s http://127.0.0.1:9997/v3/paths/list | jq .
```

- [ ] Returns JSON with `items` array
- [ ] `camera1` (etc.) listed; `ready: true` after first viewer or on-demand pull

If `404`, try v2:

```bash
curl -s http://127.0.0.1:9997/v2/paths/list | jq .
```

#### C1.2 Diagnostic script

```bash
cd pi-code/agent
node scripts/mediamtx-diagnose.js camera1
```

- [ ] Prints path list and browser URL: `http://127.0.0.1:8889/camera1/`

#### C1.3 Browser on Pi (or same LAN)

Open on a machine that can reach the Pi:

```
http://<pi-ip>:8889/camera1/
```

- [ ] MediaMTX built-in player loads
- [ ] Live video appears (may take 5–15s on first connect — `sourceOnDemand`)

#### C1.4 RTSP snapshot (optional)

Confirms local RTSP relay works (used by agent JPEG pipeline):

```bash
ffmpeg -hide_banner -loglevel error -rtsp_transport tcp \
  -i rtsp://127.0.0.1:8554/camera1 -frames:v 1 -y /tmp/test.jpg && ls -la /tmp/test.jpg
```

- [ ] JPEG file created (> 500 bytes)

#### C1.5 HLS fallback (optional)

```
http://<pi-ip>:8888/camera1/index.m3u8
```

Test in VLC or browser with HLS support.

---

### C2. Pi agent → backend registration

**Goal:** Confirm backend knows about the Pi and its camera paths.

#### C2.1 Agent is online

From a machine with monitor/admin access, login and check device status:

```bash
# 1. Get monitor token
curl -s -X POST http://<backend>/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"user_id":"<monitor_user>","password":"<password>"}' | jq -r '.accessToken'
```

```bash
# 2. Check Pi device (replace TOKEN and DEVICE_ID)
curl -s http://<backend>/api/monitoring/devices/<DEVICE_ID>/status \
  -H "Authorization: Bearer <TOKEN>" | jq .
```

- [ ] `status` is `ONLINE` (or recently seen)
- [ ] `go2rtc_status` or `stream_status` contains mediamtx paths (column name is legacy; data is MediaMTX)

#### C2.2 Lobby streams discovery

```bash
curl -s http://<backend>/api/monitoring/lobby-streams \
  -H "Authorization: Bearer <TOKEN>" | jq .
```

- [ ] Your lobby appears with `streams` array
- [ ] Each stream has `name: "camera1"`, `online: true/false`, `agentDeviceId` or `pi_device_id`
- [ ] Note the camera id format: `{piDeviceId}_{streamName}` e.g. `b6ee0d2b-..._camera1`

#### C2.3 Camera registry (new table)

```bash
curl -s http://<backend>/api/cameras \
  -H "Authorization: Bearer <TOKEN>" | jq .
```

- [ ] Returns `cameras` array with entries for `camera1`, etc.
- [ ] Each has `mediamtxPath`, `piDeviceId`, `legacyId`

> If empty: Pi may not have sent `mediamtxPaths` yet — restart agent and wait ~30s for stream-status cycle.

---

### C3. Backend play URL (no Flutter yet)

**Goal:** Confirm backend issues the correct WebRTC page URL.

#### C3.1 Get webrtc-url

```bash
CAMERA_ID="<piDeviceId>_camera1"

curl -s "http://<backend>/api/cameras/${CAMERA_ID}/webrtc-url" \
  -H "Authorization: Bearer <TOKEN>" | jq .
```

Expected response shape:

```json
{
  "success": true,
  "data": {
    "url": "http://192.168.1.10:8889/camera1",
    "token": null,
    "camera": { "mediamtxPath": "camera1", "piIp": "192.168.1.10" }
    "token": null,
    "expiresAt": null,
    "camera": {
      "legacyId": "<piDeviceId>_camera1",
      "mediamtxPath": "camera1"
    }
  }
}
```

- [ ] HTTP 200
- [ ] `url` uses the Pi’s registered `ip_address` (e.g. `http://192.168.x.x:8889/camera1`)
- [ ] 404 with “Pi IP address not registered” → agent not reporting IP; check device status
- [ ] 403 → monitor lacks division access

#### C3.2 Backend test page

Open in browser:

```
http://<backend>/mediamtx-test
```

- [ ] Enter Pi IP + path, click Load — or use URL from C3.1

> **Direct mode (default):** Backend builds URL from `devices.ip_address`. No edge proxy required on private LAN.

#### C3.3 Open returned URL directly

Copy `url` from C3.1 into a browser (append `/` if missing):

```
http://<pi-ip>:8889/camera1/
```

- [ ] Video plays in browser

---

### C4. Flutter / full end-to-end

**Goal:** Confirm the monitoring app loads streams via WebView.

- [ ] Build/run Flutter app pointed at same backend (`lib/res/app_constants.dart` → `backendBaseUrl`)
- [ ] Login as **MONITOR** user with access to the Pi's lobby/division
- [ ] Open CCTV / monitoring overview screen
- [ ] Pi cameras show in grid (label like `Lobby · camera1`)
- [ ] Tap/expand camera — WebView loads, video appears
- [ ] Fullscreen works

**If tile shows error:**

| Symptom | Check |
|---------|-------|
| No cameras in grid | C2.2 lobby-streams |
| "Auth token required" | User logged in? |
| "Empty stream URL" / 404 | C3.1 webrtc-url, C2.3 camera registry |
| WebView blank, URL works in browser | CORS/edge; WebView permissions on mobile |
| Offline label | C1.1 path not ready; RTSP source wrong |

---

## Part D — Optional edge proxy (skip if monitors reach Pi IPs on LAN/VPN)

Only if remote monitors cannot reach Pi `:8889` directly:

- [ ] TLS cert for public hostname
- [ ] Reverse proxy to Pi `:8889`
- [ ] Set `PI_WEBRTC_PLAYBACK_MODE=edge` and `EDGE_WEBRTC_BASE_URL`
- [ ] Re-run C3.1 and C4

---

## Part E — Rollout order (recommended)

1. [ ] **camera1 only** — configure one path in `mediamtx.yml`, set `MEDIAMTX_PATHS=camera1`, test C1→C4
2. [ ] Add camera2–5 once camera1 is stable
3. [ ] Disable go2rtc on all Pis
4. [ ] (Optional) Deploy edge proxy only if needed for internet monitors
5. [ ] Deploy Flutter build to monitors

---

## Quick reference — ports

| Port | Service | Test |
|------|---------|------|
| 9997 | MediaMTX API | `curl .../v3/paths/list` |
| 8554 | MediaMTX RTSP | ffmpeg snapshot |
| 8888 | MediaMTX HLS | VLC / browser |
| 8889 | MediaMTX WebRTC | Browser `/camera1/` |
| 1984 | go2rtc (retired) | Should be **off** |
| 3000 | Backend API | `/health`, `/api/cameras` |

---

## Quick reference — key API calls

| Step | Method | Path | Auth |
|------|--------|------|------|
| Login | POST | `/api/auth/login` | Public |
| Lobby cameras | GET | `/api/monitoring/lobby-streams` | Monitor JWT |
| Camera list | GET | `/api/cameras` | Monitor JWT |
| Play URL | GET | `/api/cameras/{piUuid}_camera1/webrtc-url` | Monitor JWT |
| Pi register | POST | `/api/monitoring/devices/register` | Device JWT |
| Pi health | POST | `/api/monitoring/devices/stream-status` | Device JWT |
| Restart MediaMTX | POST | `/api/monitoring/devices/{id}/restart-mediamtx` | Monitor JWT |

---

## Troubleshooting

### MediaMTX won't start

```bash
sudo journalctl -u mediamtx -n 50 --no-pager
```

Common fixes: YAML syntax error, port already in use (`ss -tlnp | grep 8889`).

### Path shows `ready: false`

- RTSP URL wrong or NVR unreachable from Pi
- Test direct RTSP: `ffprobe -rtsp_transport tcp rtsp://user:pass@nvr-ip:554/...`
- Firewall between Pi and NVR

### Agent connected but no cameras in backend

- Wrong `DEVICE_ID` (doesn't match admin UUID)
- Device not type `RASPBERRY` or not in a lobby
- `DEVICE_TOKEN_SECRET` mismatch → 401 on register

### WebRTC page loads but no video

- TURN not configured or wrong credentials
- `webrtcAdditionalHosts` missing Pi IP
- Browser needs HTTPS for some WebRTC features when not on localhost

### webrtc-url returns wrong host or 404 “Pi IP not registered”

- Pi agent offline or `devices.ip_address` null → restart agent, verify `ipAddress` in logs
- Wrong Pi for multi-lobby → each camera uses its Pi’s own IP from DB

---

*Last updated: 2026-06-20*
