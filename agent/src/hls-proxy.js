const config = require('./config');

const MAX_HLS_BYTES = Number(process.env.HLS_PROXY_MAX_BODY_BYTES || 8388608);
const HLS_FETCH_RETRIES = Number(process.env.HLS_FETCH_RETRIES || 3);
const HLS_FETCH_RETRY_MS = Number(process.env.HLS_FETCH_RETRY_MS || 800);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchLocalHls(path, query) {
  const rel = String(path || '')
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');
  const q = String(query || '').trim().replace(/^\?+/, '');
  const url = q ? `${config.mediamtxHlsBaseUrl}/${rel}?${q}` : `${config.mediamtxHlsBaseUrl}/${rel}`;

  let lastErr;
  for (let attempt = 0; attempt < HLS_FETCH_RETRIES; attempt += 1) {
    if (attempt > 0) {
      await sleep(HLS_FETCH_RETRY_MS * attempt);
    }
    try {
      const response = await fetch(url, { method: 'GET' });
      if (!response.ok) {
        const errorText = await response.text();
        const err = new Error(
          `MediaMTX HLS ${response.status}${errorText ? `: ${errorText.slice(0, 200)}` : ''}`
        );
        err.statusCode = response.status;
        if (response.status >= 500 && attempt < HLS_FETCH_RETRIES - 1) {
          lastErr = err;
          continue;
        }
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
    } catch (err) {
      lastErr = err;
      const retryable = err.statusCode >= 500 || err.code === 'ECONNRESET';
      if (retryable && attempt < HLS_FETCH_RETRIES - 1) {
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('MediaMTX HLS fetch failed');
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
