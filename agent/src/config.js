const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const defaultPaths = ['camera1', 'camera2', 'camera3', 'camera4', 'camera5'];

function parsePathList(value) {
  if (!value || typeof value !== 'string') return [...defaultPaths];
  const items = value.split(',').map((s) => s.trim()).filter(Boolean);
  return items.length ? items : [...defaultPaths];
}

function parseKioskVncTargets(env = process.env) {
  const map = {};
  const raw = (env.KIOSK_VNC_TARGETS || '').trim();
  for (const entry of raw.split(';').map((s) => s.trim()).filter(Boolean)) {
    const pipe = entry.indexOf('|');
    if (pipe <= 0) continue;
    const name = entry.slice(0, pipe).trim();
    const url = entry.slice(pipe + 1).trim();
    if (name && url) map[name] = url;
  }
  const single = (env.KIOSK_VNC_TARGET || '').trim();
  if (single && !map.kiosk1) {
    map.kiosk1 = single.startsWith('vnc://') ? single : `vnc://${single}`;
  }
  return map;
}

module.exports = {
  deviceId: process.env.DEVICE_ID,
  stationCode: process.env.STATION_CODE || '',
  apiUrl: (process.env.API_URL || 'https://railwaymonitor.in').replace(/\/$/, ''),
  socketUrl: process.env.SOCKET_URL || process.env.API_URL || 'https://railwaymonitor.in',
  deviceTokenSecret: process.env.DEVICE_TOKEN_SECRET,
  agentVersion: process.env.AGENT_VERSION || '1.0.0',
  heartbeatIntervalMs: Number(process.env.HEARTBEAT_INTERVAL_MS || 30000),
  streamPollIntervalMs: Number(process.env.STREAM_POLL_INTERVAL_MS || 30000),
  streamFrameIntervalMs: Number(process.env.STREAM_FRAME_INTERVAL_MS || 200),
  streamFrameVncIntervalMs: Number(process.env.STREAM_FRAME_VNC_INTERVAL_MS || 15000),
  cameraFps: Number(process.env.CAMERA_FPS || 3),
  cameraUploadIntervalMs: Number(process.env.CAMERA_UPLOAD_INTERVAL_MS || 350),
  mediamtxApiUrl: (process.env.MEDIAMTX_API_URL || 'http://127.0.0.1:9997').replace(/\/$/, ''),
  mediamtxWebrtcBaseUrl: (process.env.MEDIAMTX_WEBRTC_BASE_URL || 'http://127.0.0.1:8889').replace(/\/$/, ''),
  mediamtxHlsBaseUrl: (process.env.MEDIAMTX_HLS_BASE_URL || 'http://127.0.0.1:8888').replace(/\/$/, ''),
  mediamtxPaths: parsePathList(process.env.MEDIAMTX_PATHS),
  /**
   * Persistent ffmpeg JPEG decoders per camera (uploads frames to backend).
   * Set JPEG_PIPELINE_ENABLED=false for WebRTC-only Pi (no extra RTSP pulls).
   */
  jpegPipelineEnabled: process.env.JPEG_PIPELINE_ENABLED !== 'false',
  /** Upload kiosk VNC snapshots even when JPEG_PIPELINE_ENABLED=false. */
  kioskFrameEnabled: process.env.KIOSK_FRAME_ENABLED === 'true',
  kioskVncTargets: parseKioskVncTargets(),
  reconnectDelayMs: Number(process.env.RECONNECT_DELAY_MS || 5000),
  tokenRefreshMarginMs: Number(process.env.TOKEN_REFRESH_MARGIN_MS || 300000),
  screenshotDir: process.env.SCREENSHOT_DIR || '/tmp/railwatch-screenshots',
  kioskDisplay: process.env.KIOSK_DISPLAY || ':0',
  repoPath: process.env.AGENT_REPO_PATH || path.join(__dirname, '..'),
  pm2AppName: process.env.PM2_APP_NAME || 'railwatch-agent',
};

function warnJpegEnvMisconfiguration() {
  if (process.env.JPEG_ENABLED !== undefined && process.env.JPEG_PIPELINE_ENABLED === undefined) {
    // eslint-disable-next-line no-console
    console.warn(
      '[agent][config] JPEG_ENABLED is set but ignored. Use JPEG_PIPELINE_ENABLED=false to disable the JPEG pipeline.'
    );
  }
}

warnJpegEnvMisconfiguration();
