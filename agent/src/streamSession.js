const config = require('./config');
const streams = require('./streams');
const streamFrames = require('./streamFrames');
const cameraStreamer = require('./cameraStreamer');
const webrtc = require('./webrtc');

/** @type {Map<string, object>} */
const sessions = new Map();

function log(level, msg, extra = '') {
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console[level === 'warn' ? 'warn' : 'log'](
    `[agent][stream] ${ts} — ${msg}${extra ? ` | ${extra}` : ''}`
  );
}

function emitStreamError(socket, sessionId, error) {
  log('warn', `stream-error sessionId=${sessionId}`, error);
  if (!socket?.connected) return;
  socket.emit('stream-error', {
    sessionId,
    error: String(error),
    timestamp: new Date().toISOString(),
  });
}

function extractExplicitStreamName(payload = {}) {
  const name = payload.streamName || payload.cameraName;
  if (!name) return null;
  const trimmed = String(name).trim();
  return trimmed.length ? trimmed : null;
}

async function resolveGo2rtcStreamName(streamType, payload = {}) {
  const explicit = extractExplicitStreamName(payload);
  if (explicit) {
    log('log', `using explicit stream name from backend: ${explicit}`);
    return explicit;
  }

  const raw = await streams.fetchGo2rtcStreams();
  const parsed = streams.parseStreamHealth(raw);
  const online = parsed.streams.filter((s) => s.online);

  if (streamType === 'KIOSK') {
    const vncStream = online.find((s) => streamFrames.isVncSource(s.source));
    if (vncStream) return vncStream.name;
    const fallback = process.env.STREAM_NAME || 'kiosk1';
    log('warn', `no online VNC stream found, using fallback ${fallback}`);
    return fallback;
  }

  if (streamType === 'CCTV') {
    const camera = online.find((s) => s.source && !streamFrames.isVncSource(s.source));
    if (camera) return camera.name;
    log('warn', 'no online RTSP camera found, using fallback camera1');
    return 'camera1';
  }

  throw new Error(`Unsupported streamType: ${streamType}`);
}

function camerasToPauseForStream(streamType, go2rtcSrc) {
  if (streamType === 'CCTV' && go2rtcSrc) {
    return [go2rtcSrc];
  }
  return [];
}

async function resumePausedCameras(streamNames) {
  if (!streamNames.length) return;
  cameraStreamer.resumeAfterStream(streamNames);
  try {
    const raw = await streams.fetchGo2rtcStreams();
    const parsed = streams.parseStreamHealth(raw);
    const cameras = parsed.streams
      .filter((s) => s.source && !/^vnc:\/\//i.test(s.source))
      .map((s) => ({ name: s.name, source: s.source }));
    await cameraStreamer.start(cameras);
  } catch (err) {
    log('warn', 'camera resume refresh failed', err.message);
  }
}

async function teardownSession(socket, sessionId, reason = 'stop') {
  const session = sessions.get(sessionId);
  if (!session) return;

  webrtc.closeGo2rtcSession(session.go2rtcHandle);
  if (session.pausedCameras?.length) {
    await resumePausedCameras(session.pausedCameras);
  }
  sessions.delete(sessionId);
  log('log', `session torn down sessionId=${sessionId}`, reason);
}

async function ensureSessionReady(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (session.status === 'initializing' && session.prepPromise) {
    await session.prepPromise;
  }
  return sessions.get(sessionId);
}

async function forwardAgentIce(socket, session, candidate) {
  if (!session?.go2rtcHandle) return;

  const relayCandidate = await webrtc.addGo2rtcIceCandidate(session.go2rtcHandle, candidate);
  if (relayCandidate && socket.connected) {
    socket.emit('agent-ice', {
      sessionId: session.sessionId,
      candidate: relayCandidate,
      timestamp: new Date().toISOString(),
    });
    log('log', `agent-ice relayed sessionId=${session.sessionId}`);
  }
}

async function flushPendingIce(socket, session) {
  const pending = session.pendingIce || [];
  session.pendingIce = [];
  for (const candidate of pending) {
    try {
      await forwardAgentIce(socket, session, candidate);
    } catch (err) {
      log('warn', `pending agent-ice forward failed sessionId=${session.sessionId}`, err.message);
    }
  }
}

async function handleStartStream(socket, payload = {}) {
  const { sessionId, streamType, deviceId } = payload;

  if (!sessionId || !streamType) {
    log('warn', 'start-stream missing sessionId or streamType');
    return;
  }

  if (sessions.has(sessionId)) {
    log('warn', `start-stream duplicate sessionId=${sessionId}, replacing prior session`);
    await teardownSession(socket, sessionId, 'replaced');
  }

  const prepPromise = (async () => {
    const go2rtcSrc = await resolveGo2rtcStreamName(streamType, payload);
    const pausedCameras = camerasToPauseForStream(streamType, go2rtcSrc);
    if (pausedCameras.length) {
      cameraStreamer.pauseForStream(pausedCameras);
    }
    return { go2rtcSrc, pausedCameras };
  })();

  sessions.set(sessionId, {
    sessionId,
    streamType,
    deviceId: deviceId || config.deviceId,
    status: 'initializing',
    prepPromise,
    pendingIce: [],
    go2rtcSrc: null,
    pausedCameras: [],
    go2rtcHandle: null,
  });

  prepPromise
    .then(({ go2rtcSrc, pausedCameras }) => {
      const session = sessions.get(sessionId);
      if (!session || session.status !== 'initializing') return;

      session.go2rtcSrc = go2rtcSrc;
      session.pausedCameras = pausedCameras;
      session.go2rtcHandle = { streamName: go2rtcSrc, ws: null };
      session.status = 'awaiting_viewer_offer';

      log('log', `start-stream ready sessionId=${sessionId} streamType=${streamType} go2rtcSrc=${go2rtcSrc}`, JSON.stringify({
        explicitName: extractExplicitStreamName(payload),
      }));
    })
    .catch(async (err) => {
      emitStreamError(socket, sessionId, err.message);
      await teardownSession(socket, sessionId, 'start-failed');
    });
}

async function handleAgentOffer(socket, payload = {}) {
  const { sessionId, offer } = payload;
  const session = await ensureSessionReady(sessionId);

  if (!session) {
    log('warn', `agent-offer for unknown sessionId=${sessionId}`);
    emitStreamError(socket, sessionId, 'Stream session not ready');
    return;
  }

  if (session.status !== 'awaiting_viewer_offer' && session.status !== 'active') {
    log('warn', `agent-offer ignored sessionId=${sessionId} status=${session.status}`);
    emitStreamError(socket, sessionId, `Stream session not ready (status=${session.status})`);
    return;
  }

  if (!offer?.sdp || typeof offer.sdp !== 'string') {
    emitStreamError(socket, sessionId, 'agent-offer must include offer.sdp (viewer WebRTC offer)');
    await teardownSession(socket, sessionId, 'invalid-offer');
    return;
  }

  try {
    log('log', `agent-offer received sessionId=${sessionId}, POSTing viewer offer to go2rtc`);
    const go2rtcAnswer = await webrtc.proxyViewerOfferToGo2rtc(session.go2rtcSrc, offer);

    session.status = 'active';

    socket.emit('agent-answer', {
      sessionId,
      answer: {
        type: go2rtcAnswer.type || 'answer',
        sdp: go2rtcAnswer.sdp,
      },
    });

    log('log', `agent-answer emitted sessionId=${sessionId} (go2rtc answer)`);
    await flushPendingIce(socket, session);
  } catch (err) {
    emitStreamError(socket, sessionId, err.message);
    await teardownSession(socket, sessionId, 'go2rtc-failed');
  }
}

async function handleAgentIce(socket, payload = {}) {
  const { sessionId, candidate } = payload;
  let session = sessions.get(sessionId);

  if (!session) return;

  if (!candidate || (typeof candidate === 'object' && !candidate.candidate)) {
    return;
  }

  if (session.status === 'initializing') {
    await session.prepPromise;
    session = sessions.get(sessionId);
    if (!session) return;
  }

  if (session.status === 'awaiting_viewer_offer') {
    session.pendingIce.push(candidate);
    return;
  }

  if (session.status !== 'active' || !session.go2rtcHandle) {
    return;
  }

  try {
    await forwardAgentIce(socket, session, candidate);
  } catch (err) {
    log('warn', `agent-ice forward failed sessionId=${sessionId}`, err.message);
  }
}

async function handleStopStream(socket, payload = {}) {
  const { sessionId, reason } = payload;
  if (!sessionId) return;
  log('log', `stop-stream sessionId=${sessionId}`, reason || '');
  await teardownSession(socket, sessionId, reason || 'stop-stream');
}

async function teardownAllSessions(socket, reason = 'disconnect') {
  for (const sessionId of [...sessions.keys()]) {
    await teardownSession(socket, sessionId, reason);
  }
}

function attach(socket) {
  socket.on('start-stream', (payload) => {
    handleStartStream(socket, payload).catch((err) => {
      log('warn', 'start-stream handler failed', err.message);
      if (payload?.sessionId) {
        emitStreamError(socket, payload.sessionId, err.message);
      }
    });
  });

  socket.on('agent-offer', (payload) => {
    handleAgentOffer(socket, payload).catch((err) => {
      log('warn', 'agent-offer handler failed', err.message);
      if (payload?.sessionId) {
        emitStreamError(socket, payload.sessionId, err.message);
      }
    });
  });

  socket.on('agent-ice', (payload) => {
    handleAgentIce(socket, payload).catch((err) => {
      log('warn', 'agent-ice handler failed', err.message);
    });
  });

  socket.on('stop-stream', (payload) => {
    handleStopStream(socket, payload).catch((err) => {
      log('warn', 'stop-stream handler failed', err.message);
    });
  });

  socket.on('disconnect', () => {
    teardownAllSessions(socket, 'socket-disconnect').catch((err) => {
      log('warn', 'session disconnect cleanup failed', err.message);
    });
  });
}

module.exports = {
  attach,
  teardownAllSessions,
};
