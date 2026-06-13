const { io } = require('socket.io-client');
const os = require('os');
const config = require('./config');
const auth = require('./auth');
const heartbeat = require('./heartbeat');
const streams = require('./streams');
const streamFrames = require('./streamFrames');
const cameraStreamer = require('./cameraStreamer');
const commands = require('./commands');

let socket = null;
let heartbeatTimer = null;
let streamTimer = null;
let cameraRefreshTimer = null;
let kioskLoopTimer = null;
let kioskLoopRunning = false;
let reconnectTimer = null;
let intentionalDisconnect = false;

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
    ipAddress: getLocalIp(),
    stationCode: config.stationCode,
    capabilities: { go2rtc: true, screenshot: true, update: true },
  };

  socket.emit('device:online', payload);

  try {
    await heartbeat.registerViaRest(payload);
  } catch (err) {
    console.warn('[agent] REST register fallback failed:', err.message);
  }
}

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }
  return null;
}

function startIntervals() {
  clearIntervals();
  heartbeatTimer = setInterval(() => heartbeat.send(socket), config.heartbeatIntervalMs);
  streamTimer = setInterval(() => streams.pollAndReport(socket), config.streamPollIntervalMs);
  kioskLoopRunning = true;
  refreshCameraStreamers();
  // Re-sync the set of camera decoders periodically in case go2rtc config changes.
  cameraRefreshTimer = setInterval(refreshCameraStreamers, 60000);
  runKioskLoop();
}

// Cameras (RTSP/HEVC): run one persistent ffmpeg decoder per camera (warm), each
// continuously writing its latest JPEG; the streamer uploads frames at ~3fps for
// near-live video without per-frame ffmpeg startup cost.
async function refreshCameraStreamers() {
  try {
    const raw = await streams.fetchGo2rtcStreams();
    const parsed = streams.parseStreamHealth(raw);
    const cameras = parsed.streams
      .filter((s) => s.source && !/^vnc:\/\//i.test(s.source))
      .map((s) => ({ name: s.name, source: s.source }));
    await cameraStreamer.start(cameras);
  } catch (err) {
    console.warn('[agent] Camera streamer refresh failed:', err.message);
  }
}

// Kiosks (VNC): vncsnapshot is slow, run on a relaxed cadence, one at a time.
async function runKioskLoop() {
  if (!kioskLoopRunning) return;
  try {
    const raw = await streams.fetchGo2rtcStreams();
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
  cameraStreamer.stop();
  heartbeatTimer = null;
  streamTimer = null;
  cameraRefreshTimer = null;
  kioskLoopTimer = null;
}

function scheduleReconnect(reason) {
  if (intentionalDisconnect || reconnectTimer) return;
  console.warn('[agent] Scheduling reconnect:', reason);
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

  socket.on('connect', async () => {
    console.log('[agent] Socket connected');
    await registerOnline();
    startIntervals();
    await heartbeat.send(socket);
    await streams.pollAndReport(socket);
  });

  socket.on('connect_error', (err) => {
    console.error('[agent] Connect error:', err.message);
    auth.clearToken();
    scheduleReconnect('connect_error');
  });

  socket.on('disconnect', (reason) => {
    console.warn('[agent] Disconnected:', reason);
    clearIntervals();
    if (!intentionalDisconnect) {
      scheduleReconnect(reason);
    }
  });

  socket.on('device:online-ack', (data) => {
    console.log('[agent] Online ack:', data?.deviceId, data?.status);
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
