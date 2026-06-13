# Deployment Guide — Raspberry Pi Monitoring Agent

## 1. Provision Device in Backend

1. Login as admin to `https://railwaymonitor.in`
2. Create a device: `POST /api/devices`
   - `device_type`: `RASPBERRY`
   - `division_id`, `lobby_id`, `device_name`, `serial_number`
3. Copy the returned **UUID** — this is `DEVICE_ID`

## 2. Configure Backend Environment

In `railway-monitor/.env`:

```env
DEVICE_TOKEN_SECRET=<strong-random-secret>
JWT_SECRET=<existing-secret>
MONITORING_SCREENSHOT_DIR=/var/lib/railway-monitor/screenshots
MONITORING_SCREENSHOT_TTL_HOURS=72
```

Run migration:

```bash
cd railway-monitor
npx sequelize-cli db:migrate
# Or rely on sequelize.sync({ alter: true }) on startup
npm start
```

## 3. Install Agent on Raspberry Pi

```bash
git clone <pi-code-repo> /home/pi/pi-code
cd /home/pi/pi-code/agent
cp .env.example .env
nano .env
npm install --production
```

Required `.env` values:

```env
DEVICE_ID=<uuid-from-step-1>
DEVICE_TOKEN_SECRET=<same-as-backend>
API_URL=https://railwaymonitor.in
SOCKET_URL=https://railwaymonitor.in
STREAM_NAME=kiosk1
AGENT_REPO_PATH=/home/pi/pi-code
```

## 4. Install System Dependencies

```bash
sudo apt update
sudo apt install -y scrot curl
npm install -g pm2
```

Ensure go2rtc is running:

```bash
curl http://127.0.0.1:1984/api/streams
```

## 5. Start with PM2

```bash
cd /home/pi/pi-code/agent
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

## 6. Verify

```bash
pm2 logs railwatch-agent
```

Expected logs:
- `[agent] Socket connected`
- `[agent] Online ack: <uuid> ONLINE`

From monitor dashboard or API:

```bash
curl -H "Authorization: Bearer $MONITOR_TOKEN" \
  https://railwaymonitor.in/api/monitoring/dashboard
```

## 7. Remote Update

Trigger from admin:

```bash
curl -X POST -H "Authorization: Bearer $MONITOR_TOKEN" \
  https://railwaymonitor.in/api/monitoring/devices/<uuid>/update
```

Agent executes: `git pull` → `npm install` → `pm2 restart railwatch-agent`

## Troubleshooting

| Issue | Fix |
|-------|-----|
| 401 on device-token | Check `DEVICE_TOKEN_SECRET` matches backend |
| Socket connect_error | Verify `SOCKET_URL`, firewall, nginx WebSocket proxy |
| Stream poll failed | Ensure go2rtc on `127.0.0.1:1984` |
| Screenshot failed | Install `scrot`, set `KIOSK_DISPLAY=:0` |
| Device not found on register | Pre-provision device UUID via admin |

## Nginx WebSocket (if self-hosting)

```nginx
location /socket.io/ {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
}
```
