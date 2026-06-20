const { io } = require('socket.io-client');
const os = require('os');
const config = require('./config');
const { getPlaybackIp } = require('./network');
const auth = require('./auth');
const heartbeat = require('./heartbeat');
const streams = require('./streams');
const streamFrames = require('./streamFrames');
const cameraStreamer = require('./cameraStreamer');
const commands = require('./commands');
const mediamtxWebrtc = require('./mediamtx-webrtc');

let socket = null;
let heartbeatTimer = null;
let streamTimer = null;
let cameraRefreshTimer = null;
let kioskLoopTimer = null;
let kioskLoopRunning = false;
let reconnectTimer = null;
let intentionalDisconnect = false;
let staleDetectorTimer = null;

function buildSocket() {
  return io(config.socketUrl, {
    transports: ['websocket', 'polling'],
    reconnection: false,
    auth: { token: auth.getToken() },
  });
}

async function registerOnline() {
  const payload = {
    deviceId: config.deviceId,
    hostname: os.hostname(),
    serialNumber: config.deviceId,
    agentVersion: config.agentVersion,
    ipAddress: getPlaybackIp(),
    stationCode: config.stationCode,
    capabilities: { mediamtx: true, screenshot: true, update: true },
    mediamtxPaths: config.mediamtxPaths,
  };

  socket.emit('device:online', payload);

  try {
    await heartbeat.registerViaRest(payload);
  } catch (err) {
    console.warn('[agent] REST register fallback failed:', err.message);
  }
}

const STALE_CAMERA_THRESHOLD_MS = 30000;
const STALE_CHECK_INTERVAL_MS = 60000;

function log(level, msg, data = '') {
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console[level === 'warn' ? 'warn' : 'log'](
    `[agent][socket][${level}] ${ts} — ${msg}${data ? ` | ${JSON.stringify(data)}` : ''}`
  );
}

function startIntervals() {
  clearIntervals();
  heartbeatTimer = setInterval(() => heartbeat.send(socket), config.heartbeatIntervalMs);
  streamTimer = setInterval(() => streams.pollAndReport(socket), config.streamPollIntervalMs);

  if (config.jpegPipelineEnabled) {
    kioskLoopRunning = true;
    refreshCameraStreamers();
    cameraRefreshTimer = setInterval(refreshCameraStreamers, 60000);
    startStaleDetector();
    runKioskLoop();
  } else {
    console.log('[agent][socket] JPEG pipeline disabled (JPEG_PIPELINE_ENABLED=false)');
    console.log('[agent][socket] WebRTC-only mode: no agent ffmpeg RTSP pulls for cameras');
    cameraStreamer.stop();
  }
}

// Cameras (RTSP/HEVC): run one persistent ffmpeg decoder per camera (warm), each
// continuously writing its latest JPEG; the streamer uploads frames at ~3fps for
// near-live video without per-frame ffmpeg startup cost.
async function refreshCameraStreamers() {
  try {
    const raw = await streams.fetchMediaMtxPaths();
    const parsed = streams.parseStreamHealth(raw);
    const cameras = parsed.streams
      .filter((s) => s.source && !/^vnc:\/\//i.test(s.source))
      .map((s) => ({ name: s.name, source: s.source }));
    await cameraStreamer.start(cameras);
  } catch (err) {
    log('warn', 'Camera streamer refresh failed', err.message);
  }
}

function startStaleDetector() {
  if (staleDetectorTimer) clearInterval(staleDetectorTimer);
  staleDetectorTimer = setInterval(async () => {
    try {
      const health = cameraStreamer.getAllCameraHealth();
      if (!health.length) return;

      const summary = health.map(
        (h) => `${h.name}: ffmpeg=${h.ffmpegAlive ? 'alive' : 'DEAD'} upload_stale=${h.uploadStaleMs == null ? 'never' : `${h.uploadStaleMs}ms`} restarts=${h.ffmpegRestarts}`
      );
      log('log', 'camera-health', summary);

      const stale = health.filter((h) => {
        if (!h.uploaderAlive) return true;
        if (h.uploadStaleMs == null) return false;
        return h.uploadStaleMs > STALE_CAMERA_THRESHOLD_MS;
      });

      if (stale.length > 0) {
        log(
          'warn',
          `stale-detector: ${stale.length} stale camera(s) — forcing refresh`,
          stale.map((h) => ({ name: h.name, uploadStaleMs: h.uploadStaleMs }))
        );
        for (const entry of stale) {
          cameraStreamer.stopOne(entry.name);
        }
        await refreshCameraStreamers();
      }
    } catch (err) {
      log('warn', 'stale-detector failed', err.message);
    }
  }, STALE_CHECK_INTERVAL_MS);
}

function stopStaleDetector() {
  if (staleDetectorTimer) {
    clearInterval(staleDetectorTimer);
    staleDetectorTimer = null;
  }
}

// Kiosks (VNC): vncsnapshot is slow, run on a relaxed cadence, one at a time.
async function runKioskLoop() {
  if (!kioskLoopRunning) return;
  try {
    const raw = await streams.fetchMediaMtxPaths();
    const parsed = streams.parseStreamHealth(raw);
    await streamFrames.uploadFramesForStreams(parsed.streams, { vncOnly: true });
  } catch (err) {
    console.warn('[agent] Kiosk frame loop failed:', err.message);
  }
  if (!kioskLoopRunning) return;
  kioskLoopTimer = setTimeout(runKioskLoop, config.streamFrameVncIntervalMs);
}

function clearIntervals() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (streamTimer) clearInterval(streamTimer);
  kioskLoopRunning = false;
  if (cameraRefreshTimer) clearInterval(cameraRefreshTimer);
  if (kioskLoopTimer) clearTimeout(kioskLoopTimer);
  stopStaleDetector();
  cameraStreamer.stop();
  heartbeatTimer = null;
  streamTimer = null;
  cameraRefreshTimer = null;
  kioskLoopTimer = null;
}

function scheduleReconnect(reason) {
  if (intentionalDisconnect || reconnectTimer) return;
  log('warn', 'scheduling reconnect', reason);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    await connect();
  }, config.reconnectDelayMs);
}

async function connect() {
  intentionalDisconnect = false;
  await auth.ensureToken();

  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
  }

  socket = buildSocket();
  commands.attach(socket);
  mediamtxWebrtc.attach(socket);

  socket.on('connect', async () => {
    log('log', 'socket connected');
    await registerOnline();
    startIntervals();
    await heartbeat.send(socket);
    await streams.pollAndReport(socket);
  });

  socket.on('connect_error', (err) => {
    log('warn', 'connect error', err.message);
    auth.clearToken();
    scheduleReconnect('connect_error');
  });

  socket.on('disconnect', (reason) => {
    log('warn', 'disconnected', reason);
    clearIntervals();
    if (!intentionalDisconnect) {
      scheduleReconnect(reason);
    }
  });

  socket.on('device:online-ack', (data) => {
    log('log', 'online ack', { deviceId: data?.deviceId, status: data?.status });
  });

  socket.on('device:heartbeat-ack', () => {
    // silent ack
  });

  socket.connect();
  return socket;
}

function disconnect() {
  intentionalDisconnect = true;
  clearIntervals();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

function getSocket() {
  return socket;
}

module.exports = {
  connect,
  disconnect,
  getSocket,
  scheduleReconnect,
};
