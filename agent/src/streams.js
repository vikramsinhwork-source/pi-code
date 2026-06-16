const axios = require('axios');
const config = require('./config');
const auth = require('./auth');
const streamFrames = require('./streamFrames');

// #region agent log
function debugLog(hypothesisId, location, message, data = {}, runId = 'run1') {
  fetch('http://127.0.0.1:7515/ingest/ab84a119-a91c-4713-881e-a8c644fb3969', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Debug-Session-Id': '2b0af4',
    },
    body: JSON.stringify({
      sessionId: '2b0af4',
      runId,
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
}
// #endregion

function extractRtspUrl(url) {
  if (!url) return null;
  // Handle go2rtc ffmpeg format: "ffmpeg:rtsp://...#video=h264#hardware"
  if (typeof url === 'string' && url.startsWith('ffmpeg:')) {
    const match = url.match(/ffmpeg:(rtsp:\/\/[^#]+)/);
    return match ? match[1] : null;
  }
  // Handle plain rtsp:// or vnc:// urls - return as-is
  return url;
}

function parseCodecsFromMedias(medias) {
  const codecs = [];
  for (const media of medias || []) {
    const parts = String(media).split(',').map((s) => s.trim());
    const kind = parts[0]?.toLowerCase();
    if (kind !== 'video' && kind !== 'audio') continue;
    for (const part of parts.slice(2)) {
      if (/^(H264|H265|HEVC|VP8|VP9|AV1|AAC|OPUS|PCMU|PCMA|MJPEG)$/i.test(part)) {
        codecs.push(part.toUpperCase());
      }
    }
  }
  return [...new Set(codecs)];
}

function parseFpsFromProducer(producer) {
  if (typeof producer?.fps === 'number' && Number.isFinite(producer.fps)) {
    return producer.fps;
  }
  for (const media of producer?.medias || []) {
    const text = String(media);
    const fpsMatch = text.match(/(\d+(?:\.\d+)?)\s*fps/i)
      || text.match(/fps[:\s]+(\d+(?:\.\d+)?)/i);
    if (fpsMatch) return Number(fpsMatch[1]);
  }
  for (const track of producer?.tracks || []) {
    if (typeof track?.fps === 'number' && Number.isFinite(track.fps)) {
      return track.fps;
    }
  }
  return null;
}

function parseStreamEntry(name, info = {}) {
  const producers = Array.isArray(info.producers) ? info.producers : [];
  const consumers = Array.isArray(info.consumers) ? info.consumers : [];
  const producerCount = producers.length || info.producerCount || 0;
  const consumerCount = consumers.length || info.consumerCount || 0;

  const codecs = [];
  let fps = null;
  for (const producer of producers) {
    codecs.push(...parseCodecsFromMedias(producer.medias));
    if (fps == null) {
      const producerFps = parseFpsFromProducer(producer);
      if (producerFps != null) fps = producerFps;
    }
  }
  if (Array.isArray(info.medias)) {
    codecs.push(...parseCodecsFromMedias(info.medias));
  }

  const isOnline = !!(
    producerCount > 0
    || info.online === true
    || (info.medias && info.medias.length > 0)
  );

  return {
    name,
    online: isOnline,
    status: isOnline ? 'online' : 'offline',
    producerCount,
    consumerCount,
    producers: producerCount,
    consumers: consumerCount,
    codec: [...new Set(codecs)][0] || null,
    codecs: [...new Set(codecs)],
    fps,
    source: extractRtspUrl(producers[0]?.url || info.url || null),
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

async function fetchGo2rtcStreams() {
  const url = `${config.go2rtcUrl}${config.go2rtcStreamsPath}`;
  const response = await axios.get(url, { timeout: 10000 });
  return response.data;
}

async function pollAndReport(socket) {
  try {
    await auth.ensureToken();
    const raw = await fetchGo2rtcStreams();
    const parsed = parseStreamHealth(raw);
    // #region agent log
    debugLog('H5', 'streams.js:pollAndReport', 'Parsed go2rtc stream health snapshot', {
      totalStreams: parsed.summary.total,
      onlineStreams: parsed.summary.online,
      offlineStreams: parsed.summary.offline,
      streamsWithoutSource: parsed.streams.filter((s) => !s.source).map((s) => s.name),
      sample: parsed.streams.slice(0, 6).map((s) => ({
        name: s.name,
        online: s.online,
        producerCount: s.producerCount,
        hasSource: !!s.source,
      })),
    });
    // #endregion

    const payload = {
      deviceId: config.deviceId,
      streams: parsed.streams,
      go2rtc: {
        ...parsed,
        raw,
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

    // Frame uploads are handled by socket.js timers (fast RTSP + slow VNC).
  } catch (err) {
    console.warn('[agent] Stream poll failed:', err.message);

    const failurePayload = {
      deviceId: config.deviceId,
      go2rtc: {
        error: err.message,
        online: false,
        summary: { online: 0, offline: 0, total: 0 },
        fetchedAt: new Date().toISOString(),
      },
      streams: [],
    };

    if (socket?.connected) {
      socket.emit('device:stream-status', failurePayload);
    }
  }
}

module.exports = { pollAndReport, parseStreamHealth, parseStreamEntry, fetchGo2rtcStreams };
