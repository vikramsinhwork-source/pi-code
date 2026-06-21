const config = require('./config');

const MAX_HLS_BYTES = Number(process.env.HLS_PROXY_MAX_BODY_BYTES || 8388608);

async function fetchLocalHls(path, query) {
  const rel = String(path || '')
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');
  const q = String(query || '').trim().replace(/^\?+/, '');
  const url = q ? `${config.mediamtxHlsBaseUrl}/${rel}?${q}` : `${config.mediamtxHlsBaseUrl}/${rel}`;
  const response = await fetch(url, { method: 'GET' });

  if (!response.ok) {
    const errorText = await response.text();
    const err = new Error(`MediaMTX HLS ${response.status}${errorText ? `: ${errorText.slice(0, 200)}` : ''}`);
    err.statusCode = response.status;
    throw err;
  }

  const arrayBuffer = await response.arrayBuffer();
  const body = Buffer.from(arrayBuffer);
  if (body.length > MAX_HLS_BYTES) {
    throw new Error(`HLS payload too large (${body.length} bytes)`);
  }

  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  return {
    contentType,
    bodyBase64: body.toString('base64'),
    statusCode: response.status,
  };
}

function attach(socket) {
  socket.on('device:hls-fetch', async (payload, ack) => {
    const path = payload?.path;
    const query = payload?.query;
    if (!path || typeof path !== 'string') {
      if (typeof ack === 'function') {
        ack({ error: 'path is required' });
      }
      return;
    }

    try {
      const result = await fetchLocalHls(path, query);
      if (typeof ack === 'function') {
        ack(result);
      }
    } catch (err) {
      console.error('[agent] HLS fetch failed:', err.message);
      if (typeof ack === 'function') {
        ack({
          error: err.message,
          statusCode: err.statusCode || 502,
        });
      }
    }
  });
}

module.exports = { attach, fetchLocalHls };
