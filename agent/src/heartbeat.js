const os = require('os');
const axios = require('axios');
const config = require('./config');
const auth = require('./auth');
const { getPlaybackIp } = require('./network');

async function registerViaRest(payload) {
  const token = await auth.ensureToken();
  await axios.post(
    `${config.apiUrl}/api/monitoring/devices/register`,
    {
      deviceId: config.deviceId,
      stationCode: config.stationCode,
      hostname: payload.hostname || os.hostname(),
      ipAddress: payload.ipAddress,
      agentVersion: config.agentVersion,
      serialNumber: payload.serialNumber || config.deviceId,
      mediamtxPaths: payload.mediamtxPaths || config.mediamtxPaths,
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

async function send(socket) {
  try {
    await auth.ensureToken();
    const metrics = collectMetrics();

    if (socket?.connected) {
      socket.emit('device:heartbeat', {
        deviceId: config.deviceId,
        ...metrics,
        agentVersion: config.agentVersion,
        ipAddress: metrics.ipAddress,
      });
    }

    const token = auth.getToken();
    await axios.post(
      `${config.apiUrl}/api/monitoring/devices/heartbeat`,
      { deviceId: config.deviceId, ...metrics, agentVersion: config.agentVersion },
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch (err) {
    console.warn('[agent] Heartbeat failed:', err.message);
    if (err.response?.status === 401) auth.clearToken();
  }
}

function collectMetrics() {
  const load = os.loadavg()[0];
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memory = totalMem ? Math.round(((totalMem - freeMem) / totalMem) * 100) : null;

  return {
    cpu: load,
    memory,
    uptime: os.uptime(),
    hostname: os.hostname(),
    ipAddress: getPlaybackIp(),
  };
}

module.exports = { send, registerViaRest, collectMetrics };
