# Monitoring Agent — Architecture

## System Overview

```mermaid
flowchart TB
  subgraph Pi["Raspberry Pi"]
    Agent["railwatch-agent"]
    Go2RTC["go2rtc :1984"]
    Kiosk["Kiosk App"]
    Agent --> Go2RTC
    Agent --> Kiosk
  end

  subgraph Backend["railway-monitor backend"]
    API["Express REST /api/monitoring"]
    Socket["Socket.IO"]
    DB[(PostgreSQL)]
    API --> DB
    Socket --> DB
  end

  subgraph Admin["Monitor Dashboard"]
    Monitor["MONITOR users"]
  end

  Agent -->|"JWT + REST"| API
  Agent <-->|"device:* events"| Socket
  Monitor -->|"Admin commands"| API
  API -->|"device:reboot etc."| Socket
  Socket --> Agent
```

## Components

| Component | Location | Role |
|-----------|----------|------|
| Device model | `railway-monitor/src/modules/divisions/device.model.js` | Reuses existing `devices` table |
| Monitoring module | `railway-monitor/src/modules/monitoring/` | REST APIs + business logic |
| Socket handlers | `railway-monitor/src/socket/monitoring.handlers.js` | Bidirectional `device:*` events |
| Agent | `pi-code/agent/` | Edge monitoring on Raspberry Pi |

## Data Flow — Registration

```mermaid
sequenceDiagram
  participant A as Agent
  participant Auth as /api/auth/device-token
  participant API as /api/monitoring/devices/register
  participant S as Socket.IO
  participant DB as PostgreSQL

  A->>Auth: POST deviceId, role KIOSK, secret
  Auth-->>A: JWT token
  A->>S: connect(auth.token)
  A->>S: emit device:online
  S->>DB: update device status ONLINE
  S-->>A: device:online-ack
  A->>API: POST register (REST fallback)
  API->>DB: upsert device metadata
```

## Data Flow — Heartbeat & Streams

```mermaid
sequenceDiagram
  participant A as Agent
  participant Go2 as go2rtc
  participant S as Socket.IO
  participant API as REST API
  participant DB as PostgreSQL

  loop Every 30s
    A->>Go2: GET /api/streams
    Go2-->>A: stream producers/consumers
    A->>S: emit device:stream-status
    A->>API: POST stream-status
    S->>DB: update stream_status, go2rtc_status
    A->>S: emit device:heartbeat
    A->>API: POST heartbeat
    S->>DB: insert device_heartbeats row
  end
```

## Data Flow — Remote Screenshot

```mermaid
sequenceDiagram
  participant M as Monitor
  participant API as /api/monitoring/devices/:id/capture-screenshot
  participant S as Socket.IO
  participant A as Agent
  participant Store as Screenshot storage

  M->>API: POST capture-screenshot
  API->>S: emit device:capture-screenshot to device room
  S->>A: device:capture-screenshot
  A->>A: scrot desktop + curl kiosk frame
  A->>API: POST /devices/screenshot (multipart)
  API->>Store: save file + metadata
  API-->>M: command queued response
```

## Security

- Device REST endpoints require KIOSK JWT from `device-token`
- Admin endpoints require MONITOR+ app JWT via `requireAuth` + `requireMonitor`
- Rate limiting on all device events and REST endpoints
- Reconnect storm suppression (5s debounce on `device:online`)
- Audit logs on all admin commands

## Reused vs New

**Reused:** Device model, `authenticateSocket`, `registerAgent` logic, `DeviceCommand` queue, `DeviceLog`, audit service, RBAC middleware.

**New:** `device_heartbeats`, `device_screenshots` tables, `stream_status`/`go2rtc_status`/`agent_version` columns, monitoring module, `device:*` socket protocol, Pi agent.
