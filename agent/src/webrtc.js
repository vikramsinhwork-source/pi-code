const config = require('./config');

async function proxyOfferToGo2rtc(streamName, sdp) {
  const url = `${config.go2rtcUrl}/api/webrtc?src=${encodeURIComponent(streamName)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'offer', sdp }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`go2rtc ${response.status}${errorText ? `: ${errorText}` : ''}`);
  }

  return response.json();
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
      console.log('[agent] WebRTC offer relay', { streamName, requestId: payload?.requestId || null });
      const answer = await proxyOfferToGo2rtc(streamName, sdp);
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
      console.error('[agent] WebRTC offer relay failed:', err.message);
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

module.exports = { attach, proxyOfferToGo2rtc };
