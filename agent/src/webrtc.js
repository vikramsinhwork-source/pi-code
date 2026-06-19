/**
 * go2rtc HTTP WHEP proxy — Pi agent does NOT create RTCPeerConnection.
 * Browser offer → Socket.IO → this module → POST go2rtc → answer back.
 */
const config = require('./config');

function go2rtcWebrtcUrl(streamName) {
  return `${config.go2rtcUrl}/api/webrtc?src=${encodeURIComponent(streamName)}`;
}

function go2rtcWsUrl(streamName) {
  const base = config.go2rtcUrl.replace(/^http/i, 'ws');
  return `${base}/api/ws?src=${encodeURIComponent(streamName)}`;
}

function normalizeAnswerPayload(data, fallbackType = 'answer') {
  if (typeof data === 'string' && data.trim().startsWith('v=')) {
    return { type: fallbackType, sdp: data.trim() };
  }
  if (data && typeof data === 'object' && typeof data.sdp === 'string') {
    return { type: data.type || fallbackType, sdp: data.sdp };
  }
  throw new Error('go2rtc returned an invalid SDP answer');
}

async function postSdpToGo2rtc(streamName, type, sdp) {
  const url = go2rtcWebrtcUrl(streamName);
  console.log(`[agent][webrtc] POST offer to go2rtc url=${url} sdp_bytes=${sdp?.length || 0}`);

  const attempts = [
    {
      label: 'application/json',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: type || 'offer', sdp }),
    },
    {
      label: 'application/sdp',
      headers: { 'Content-Type': 'application/sdp' },
      body: sdp,
    },
  ];

  let lastError = null;

  for (const attempt of attempts) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: attempt.headers,
        body: attempt.body,
      });

      if (!response.ok) {
        const errorText = await response.text();
        lastError = new Error(
          `go2rtc ${response.status} (${attempt.label})${errorText ? `: ${errorText.slice(0, 200)}` : ''}`
        );
        if (response.status === 415 || response.status === 400) {
          continue;
        }
        throw lastError;
      }

      const contentType = response.headers.get('content-type') || '';
      let answer;
      if (contentType.includes('application/json')) {
        answer = normalizeAnswerPayload(await response.json());
      } else {
        answer = normalizeAnswerPayload(await response.text());
      }

      console.log(
        `[agent][webrtc] go2rtc answer received stream=${streamName} via=${attempt.label} answer_bytes=${answer.sdp.length}`
      );
      return answer;
    } catch (err) {
      lastError = err;
      if (attempt.label === 'application/sdp') {
        throw err;
      }
    }
  }

  throw lastError || new Error(`go2rtc proxy failed for ${streamName}`);
}

async function proxyOfferToGo2rtc(streamName, type, sdp) {
  if (!streamName) {
    throw new Error('streamName is required for go2rtc proxy');
  }
  if (!sdp || typeof sdp !== 'string') {
    throw new Error('offer SDP is required for go2rtc proxy');
  }
  return postSdpToGo2rtc(streamName, type, sdp);
}

/** Viewer offer → go2rtc answer (stream-session socket flow). */
async function proxyViewerOfferToGo2rtc(streamName, viewerOffer) {
  const type = viewerOffer?.type || 'offer';
  const sdp = viewerOffer?.sdp;
  return proxyOfferToGo2rtc(streamName, type, sdp);
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
 * Forward trickle ICE to go2rtc WebSocket; relay any local candidate back to viewer.
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
      console.log(`[agent][webrtc] go2rtc answer forwarded stream=${streamName} requestId=${requestId}`);
    } catch (err) {
      console.error(`[agent][webrtc] go2rtc proxy failed stream=${streamName}:`, err.message);
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
