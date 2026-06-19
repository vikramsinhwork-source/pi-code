const config = require('./config');

/**
 * go2rtc /api/webrtc?src= (WHEP consumer) — verified direction:
 *
 * Local curl test (2025-06): go2rtc not running on dev machine (connection refused).
 * Confirmed via existing legacy handler + go2rtc OpenAPI:
 *   - GET  /api/webrtc?src=…  → no offer retrieval; not used
 *   - POST /api/webrtc?src=…  → body { type: "offer", sdp } → { type: "answer", sdp }
 *
 * go2rtc is always the answerer. Stream-session socket flow:
 *   1. start-stream        → agent selects go2rtc src, pauses JPEG uploaders
 *   2. agent-offer         → viewer WebRTC offer arrives (in payload.offer)
 *   3. POST offer → go2rtc → agent emits agent-answer with go2rtc answer SDP
 *   4. agent-ice           → viewer ICE relayed via go2rtc WebSocket when needed
 */

function go2rtcWebrtcUrl(streamName) {
  return `${config.go2rtcUrl}/api/webrtc?src=${encodeURIComponent(streamName)}`;
}

function go2rtcWsUrl(streamName) {
  const base = config.go2rtcUrl.replace(/^http/i, 'ws');
  return `${base}/api/ws?src=${encodeURIComponent(streamName)}`;
}

async function postSdpToGo2rtc(streamName, type, sdp) {
  const url = go2rtcWebrtcUrl(streamName);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, sdp }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`go2rtc ${response.status}${errorText ? `: ${errorText}` : ''}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }

  const answerSdp = await response.text();
  return { type: 'answer', sdp: answerSdp };
}

async function proxyOfferToGo2rtc(streamName, type, sdp) {
  return postSdpToGo2rtc(streamName, type, sdp);
}

/** Viewer offer → go2rtc answer (stream-session reversed flow). */
async function proxyViewerOfferToGo2rtc(streamName, viewerOffer) {
  const type = viewerOffer?.type || 'offer';
  const sdp = viewerOffer?.sdp;
  if (!sdp || typeof sdp !== 'string') {
    throw new Error('Viewer offer SDP is required');
  }
  console.log('[agent][stream] POST viewer offer to go2rtc', streamName);
  return postSdpToGo2rtc(streamName, type, sdp);
}

function openGo2rtcWebSocket(streamName) {
  return new WebSocket(go2rtcWsUrl(streamName));
}

function waitForWebSocketOpen(ws, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error('go2rtc WebSocket open timeout')), timeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('go2rtc WebSocket connection failed'));
    }, { once: true });
  });
}

/**
 * Forward a trickle ICE candidate to an active go2rtc WebSocket session.
 * @returns {Promise<object|null>} go2rtc local candidate to relay to viewer, if any
 */
async function addGo2rtcIceCandidate(sessionHandle, candidate) {
  if (!sessionHandle || !candidate) return null;

  let ws = sessionHandle.ws;
  if (!ws || ws.readyState === WebSocket.CLOSED) {
    ws = openGo2rtcWebSocket(sessionHandle.streamName);
    sessionHandle.ws = ws;
    await waitForWebSocketOpen(ws);
  }

  const candidateStr = typeof candidate === 'string'
    ? candidate
    : candidate.candidate || '';

  if (!candidateStr) return null;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage);
      resolve(null);
    }, 3000);

    function onMessage(event) {
      try {
        const msg = JSON.parse(event.data);
        if (msg?.type === 'webrtc/candidate' && msg?.value) {
          clearTimeout(timer);
          ws.removeEventListener('message', onMessage);
          resolve({
            candidate: msg.value,
            sdpMid: candidate.sdpMid ?? '0',
            sdpMLineIndex: candidate.sdpMLineIndex ?? 0,
          });
        }
      } catch (_) {
        // ignore non-JSON frames
      }
    }

    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ type: 'webrtc/candidate', value: candidateStr }));

    ws.addEventListener('error', () => {
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      reject(new Error('go2rtc WebSocket ICE forward failed'));
    }, { once: true });
  });
}

function closeGo2rtcSession(sessionHandle) {
  if (!sessionHandle) return;
  const ws = sessionHandle.ws;
  if (ws && ws.readyState !== WebSocket.CLOSED) {
    try { ws.close(); } catch (_) {}
  }
  sessionHandle.ws = null;
}

function attach(socket) {
  socket.on('webrtc:offer', async (payload) => {
    const { requestId, streamName, type, sdp } = payload || {};

    console.log('[agent][webrtc] Received offer', streamName, requestId);

    try {
      const answer = await proxyOfferToGo2rtc(streamName, type, sdp);
      socket.emit('webrtc:answer', {
        requestId,
        type: answer.type,
        sdp: answer.sdp,
      });
      console.log('[agent][webrtc] Answer sent', requestId);
    } catch (err) {
      console.error('[agent][webrtc] Failed', err);
      socket.emit('webrtc:answer', {
        requestId,
        error: err.message,
      });
    }
  });
}

module.exports = {
  attach,
  proxyOfferToGo2rtc,
  proxyViewerOfferToGo2rtc,
  addGo2rtcIceCandidate,
  closeGo2rtcSession,
  go2rtcWebrtcUrl,
};
