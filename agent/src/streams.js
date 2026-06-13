const axios = require('axios');
const config = require('./config');
const auth = require('./auth');
const streamFrames = require('./streamFrames');

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
    source: producers[0]?.url || info.url || null,
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
