const config = require('./config');

async function proxyOfferToGo2rtc(streamName, type, sdp) {
  const url = `${config.go2rtcUrl}/api/webrtc?src=${encodeURIComponent(streamName)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, sdp }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`go2rtc ${response.status}${errorText ? `: ${errorText}` : ''}`);
  }

  return response.json();
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

module.exports = { attach, proxyOfferToGo2rtc };
