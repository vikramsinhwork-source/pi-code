#!/usr/bin/env node
/**
 * Pi-side MediaMTX diagnostic utility.
 *
 * Usage:
 *   node scripts/mediamtx-diagnose.js
 *   node scripts/mediamtx-diagnose.js camera1
 */
const axios = require('axios');

const MEDIAMTX_API_URL = (process.env.MEDIAMTX_API_URL || 'http://127.0.0.1:9997').replace(/\/$/, '');
const MEDIAMTX_WEBRTC_BASE_URL = (process.env.MEDIAMTX_WEBRTC_BASE_URL || 'http://127.0.0.1:8889').replace(/\/$/, '');

async function fetchPaths() {
  try {
    const res = await axios.get(`${MEDIAMTX_API_URL}/v3/paths/list`, { timeout: 8000 });
    return res.data;
  } catch (err) {
    if (err.response?.status === 404) {
      const res = await axios.get(`${MEDIAMTX_API_URL}/v2/paths/list`, { timeout: 8000 });
      return res.data;
    }
    throw err;
  }
}

async function main() {
  const pathArg = process.argv[2];
  console.log(`MediaMTX API: ${MEDIAMTX_API_URL}`);
  console.log(`WebRTC base: ${MEDIAMTX_WEBRTC_BASE_URL}`);

  let payload;
  try {
    payload = await fetchPaths();
  } catch (err) {
    console.error(`Cannot reach MediaMTX API: ${err.message}`);
    process.exit(1);
  }

  const items = payload?.items || [];
  console.log(`\nPaths (${items.length}):`);
  for (const item of items) {
    console.log(`  ${item.name}: ready=${item.ready === true} source=${item.source || '(none)'}`);
  }

  if (pathArg) {
    const url = `${MEDIAMTX_WEBRTC_BASE_URL}/${encodeURIComponent(pathArg)}/`;
    console.log(`\nOpen in browser for WebRTC test:\n  ${url}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
