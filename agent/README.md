# Raspberry Pi Monitoring Agent

Production agent for the Railway Lobby Monitoring System. Connects to the backend at `https://railwaymonitor.in` using JWT device authentication and Socket.IO.

## Features

- JWT authentication via `POST /api/auth/device-token`
- Socket.IO events: `device:online`, `device:heartbeat`, `device:stream-status`
- REST fallbacks: register, heartbeat, stream-status, screenshot upload
- go2rtc stream health polling every 30 seconds
- Remote commands: reboot, restart go2rtc, restart agent, capture screenshot, git update
- Automatic token refresh and reconnect

## Quick Start

```bash
cd agent
cp .env.example .env
# Edit .env — set DEVICE_ID (UUID), DEVICE_TOKEN_SECRET, API_URL
npm install
npm start
```

## PM2 Deployment

```bash
cd agent
npm install --production
pm2 start ecosystem.config.js
pm2 save
```

## Prerequisites on Raspberry Pi

- Node.js 18+
- go2rtc running on port 1984
- `scrot` for desktop screenshots
- `curl` for kiosk frame capture
- PM2 for process management

## Architecture

See [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) and [docs/API.md](../docs/API.md).
