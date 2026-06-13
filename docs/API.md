# Monitoring API Reference

Base URL: `https://railwaymonitor.in`

## Authentication

### Device Token (Agent)

```http
POST /api/auth/device-token
Content-Type: application/json

{
  "deviceId": "<device-uuid>",
  "role": "KIOSK",
  "secret": "<DEVICE_TOKEN_SECRET>"
}
```

Response: `{ "success": true, "token": "eyJ..." }`

Use `Authorization: Bearer <token>` on device endpoints.

### Monitor Token (Admin)

```http
POST /api/auth/login
{ "user_id": "...", "password": "..." }
```

Use `accessToken` from response on admin endpoints.

---

## Device Endpoints (KIOSK JWT)

### Register

```http
POST /api/monitoring/devices/register
Authorization: Bearer <device-token>

{
  "deviceId": "<uuid>",
  "hostname": "pi-kiosk-1",
  "ipAddress": "10.71.35.210",
  "agentVersion": "1.0.0",
  "serialNumber": "PI-001"
}
```

### Heartbeat

```http
POST /api/monitoring/devices/heartbeat

{
  "deviceId": "<uuid>",
  "cpu": 0.42,
  "memory": 65,
  "uptime": 86400
}
```

### Stream Status

```http
POST /api/monitoring/devices/stream-status

{
  "deviceId": "<uuid>",
  "streams": [
    { "name": "kiosk1", "online": true, "producers": 1, "consumers": 0 }
  ],
  "go2rtc": { "summary": { "online": 1, "offline": 0, "total": 1 } }
}
```

### Screenshot Upload

```http
POST /api/monitoring/devices/screenshot
Content-Type: multipart/form-data

deviceId=<uuid>
screenType=desktop|kiosk
screenshot=<file>
```

---

## Admin Endpoints (MONITOR JWT)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/monitoring/devices` | List Raspberry Pi devices |
| GET | `/api/monitoring/devices/:id` | Device detail + status |
| GET | `/api/monitoring/devices/:id/status` | Live status + last heartbeat |
| GET | `/api/monitoring/dashboard` | Fleet statistics |
| POST | `/api/monitoring/devices/:id/reboot` | Reboot Pi |
| POST | `/api/monitoring/devices/:id/restart-go2rtc` | Restart go2rtc |
| POST | `/api/monitoring/devices/:id/restart-agent` | Restart agent via PM2 |
| POST | `/api/monitoring/devices/:id/update` | Git pull + npm install + PM2 restart |
| POST | `/api/monitoring/devices/:id/capture-screenshot` | Trigger screenshot capture |

### Dashboard Response

```json
{
  "success": true,
  "data": {
    "total_devices": 12,
    "online_devices": 10,
    "offline_devices": 2,
    "stream_failures": 1,
    "active_streams": 18,
    "last_heartbeat": "2026-06-13T12:00:00.000Z"
  }
}
```

---

## Socket.IO Events

### Device → Backend

| Event | Payload |
|-------|---------|
| `device:online` | `{ deviceId, hostname, agentVersion, ipAddress, serialNumber }` |
| `device:heartbeat` | `{ deviceId, cpu, memory, uptime, ... }` |
| `device:stream-status` | `{ deviceId, streams[], go2rtc{} }` |
| `device:screenshot` | `{ deviceId, screenType, imageBase64 }` |

### Backend → Device

| Event | Description |
|-------|-------------|
| `device:reboot` | Reboot Raspberry Pi |
| `device:restart-go2rtc` | Restart go2rtc service |
| `device:restart-agent` | PM2 restart agent |
| `device:capture-screenshot` | Capture desktop + kiosk |
| `device:update` | Git pull + npm install + restart |

Connect with: `io(url, { auth: { token: deviceJwt } })`

Only **KIOSK** role sockets receive device commands. Only **MONITOR** users can send admin commands via REST.
