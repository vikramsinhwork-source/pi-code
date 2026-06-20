const config = require('./config');

async function proxyOfferToMediaMtxWhep(streamName, sdp) {
  const path = encodeURIComponent(streamName);
  const url = `${config.mediamtxWebrtcBaseUrl}/${path}/whep`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: sdp,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`MediaMTX WHEP ${response.status}${errorText ? `: ${errorText}` : ''}`);
  }

  const answerSdp = await response.text();
  if (!answerSdp?.trim()) {
    throw new Error('MediaMTX WHEP returned empty SDP answer');
  }

  return { type: 'answer', sdp: answerSdp.trim() };
}

function attach(socket) {
  socket.on('device:webrtc-offer', async (payload, ack) => {
    const streamName = payload?.streamName;
    const sdp = payload?.sdp;
    if (!streamName || typeof sdp !== 'string' || !sdp.trim()) {
      if (typeof ack === 'function') {
        ack({ error: 'streamName and sdp are required' });
      }
      return;
    }

    try {
      console.log('[agent] MediaMTX WHEP offer relay', {
        streamName,
        requestId: payload?.requestId || null,
      });
      const answer = await proxyOfferToMediaMtxWhep(streamName, sdp);
      if (typeof ack === 'function') {
        ack({ type: answer.type, sdp: answer.sdp });
        return;
      }
      socket.emit('device:webrtc-offer-answer', {
        requestId: payload?.requestId,
        type: answer.type,
        sdp: answer.sdp,
      });
    } catch (err) {
      console.error('[agent] MediaMTX WHEP offer relay failed:', err.message);
      if (typeof ack === 'function') {
        ack({ error: err.message });
        return;
      }
      socket.emit('device:webrtc-offer-answer', {
        requestId: payload?.requestId,
        error: err.message,
      });
    }
  });
}

module.exports = { attach, proxyOfferToMediaMtxWhep };
