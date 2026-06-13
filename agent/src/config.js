const path = require('path');
const dotenv = require('dotenv');

// Load pi-code/.env first, then agent/.env overrides (if present)
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', '.env') });

module.exports = {
  deviceId: process.env.DEVICE_ID,
  stationCode: process.env.STATION_CODE || '',
  apiUrl: (process.env.API_URL || 'https://railwaymonitor.in').replace(/\/$/, ''),
  socketUrl: process.env.SOCKET_URL || process.env.API_URL || 'https://railwaymonitor.in',
  deviceTokenSecret: process.env.DEVICE_TOKEN_SECRET,
  agentVersion:  process.env.AGENT_VERSION || '1.0.0',
  heartbeatIntervalMs: Number(process.env.HEARTBEAT_INTERVAL_MS || 30000),
  streamPollIntervalMs: Number(process.env.STREAM_POLL_INTERVAL_MS || 30000),
  // Legacy sequential-rotation pause (still used as fallback poll cadence).
  streamFrameIntervalMs: Number(process.env.STREAM_FRAME_INTERVAL_MS || 200),
  streamFrameVncIntervalMs: Number(process.env.STREAM_FRAME_VNC_INTERVAL_MS || 15000),
  // Persistent camera decoders: target fps per camera and how often the newest
  // frame is uploaded to the backend.
  cameraFps: Number(process.env.CAMERA_FPS || 3),
  cameraUploadIntervalMs: Number(process.env.CAMERA_UPLOAD_INTERVAL_MS || 350),
  go2rtcUrl: (process.env.GO2RTC_URL || 'http://127.0.0.1:1984').replace(/\/$/, ''),
  go2rtcStreamsPath: process.env.GO2RTC_STREAMS_PATH || '/api/streams',
  reconnectDelayMs: Number(process.env.RECONNECT_DELAY_MS || 5000),
  tokenRefreshMarginMs: Number(process.env.TOKEN_REFRESH_MARGIN_MS || 300000),
  screenshotDir: process.env.SCREENSHOT_DIR || '/tmp/railwatch-screenshots',
  kioskDisplay: process.env.KIOSK_DISPLAY || ':0',
  repoPath: process.env.AGENT_REPO_PATH || require('path').join(__dirname, '..'),
  pm2AppName: process.env.PM2_APP_NAME || 'railwatch-agent',
};
