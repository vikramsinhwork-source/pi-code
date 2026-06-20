const axios = require('axios');
const config = require('./config');
const auth = require('./auth');

function parseStreamEntry(name, info = {}) {
  const ready = info.ready === true || info.sourceReady === true;
  const source = info.source || info.sourceUrl || null;

  return {
    name,
    online: ready,
    status: ready ? 'online' : 'offline',
    producerCount: ready ? 1 : 0,
    consumerCount: info.readers?.length || 0,
    producers: ready ? 1 : 0,
    consumers: info.readers?.length || 0,
    codec: info.tracks?.find((t) => t.type === 'video')?.codec || null,
    codecs: info.tracks?.map((t) => t.codec).filter(Boolean) || [],
    fps: null,
    source,
  };
}

function parseStreamHealth(streamsData) {
  const streams = [];
  let online = 0;
  let offline = 0;

  if (!streamsData || typeof streamsData !== 'object') {
    return { streams, summary: { online, offline, total: 0 } };
  }

  for (const [name, info] of Object.entries(streamsData)) {
    const entry = parseStreamEntry(name, info);
    if (entry.online) online += 1;
    else offline += 1;
    streams.push(entry);
  }

  return {
    streams,
    summary: { online, offline, total: streams.length },
  };
}

function buildFallbackPathMap() {
  const map = {};
  for (const name of config.mediamtxPaths) {
    map[name] = { name, ready: false, source: null };
  }
  return map;
}

function normalizeMediaMtxPathsList(payload) {
  const items = payload?.items || payload?.paths || [];
  if (Array.isArray(items)) {
    const map = buildFallbackPathMap();
    for (const item of items) {
      const name = item?.name;
      if (!name) continue;
      map[name] = {
        name,
        ready: item.ready === true,
        source: item.source || null,
        tracks: item.tracks || [],
        readers: item.readers || [],
      };
    }
    return map;
  }

  if (payload && typeof payload === 'object') {
    return payload;
  }

  return buildFallbackPathMap();
}

async function fetchMediaMtxPaths() {
  const url = `${config.mediamtxApiUrl}/v3/paths/list`;
  try {
    const response = await axios.get(url, { timeout: 10000 });
    return normalizeMediaMtxPathsList(response.data);
  } catch (err) {
    if (err.response?.status === 404) {
      const legacy = await axios.get(`${config.mediamtxApiUrl}/v2/paths/list`, { timeout: 10000 });
      return normalizeMediaMtxPathsList(legacy.data);
    }
    throw err;
  }
}

async function pollAndReport(socket) {
  try {
    await auth.ensureToken();
    const raw = await fetchMediaMtxPaths();
    const parsed = parseStreamHealth(raw);

    const payload = {
      deviceId: config.deviceId,
      streams: parsed.streams,
      mediamtx: {
        ...parsed,
        raw,
        paths: config.mediamtxPaths,
        fetchedAt: new Date().toISOString(),
        rawKeys: Object.keys(raw || {}),
      },
    };

    if (socket?.connected) {
      socket.emit('device:stream-status', payload);
    }

    const token = auth.getToken();
    await axios.post(
      `${config.apiUrl}/api/monitoring/devices/stream-status`,
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch (err) {
    console.warn('[agent] Stream poll failed:', err.message);

    const failurePayload = {
      deviceId: config.deviceId,
      mediamtx: {
        error: err.message,
        online: false,
        summary: { online: 0, offline: 0, total: 0 },
        paths: config.mediamtxPaths,
        fetchedAt: new Date().toISOString(),
      },
      streams: config.mediamtxPaths.map((name) => ({
        name,
        online: false,
        status: 'offline',
      })),
    };

    if (socket?.connected) {
      socket.emit('device:stream-status', failurePayload);
    }
  }
}

module.exports = {
  pollAndReport,
  parseStreamHealth,
  parseStreamEntry,
  fetchMediaMtxPaths,
  buildFallbackPathMap,
};
