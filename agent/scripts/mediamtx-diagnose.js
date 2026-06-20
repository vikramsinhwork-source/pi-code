#!/usr/bin/env node
/**
 * Pi-side MediaMTX diagnostic utility.
 *
 * Usage:
 *   node scripts/mediamtx-diagnose.js
 *   node scripts/mediamtx-diagnose.js camera1
 *   node scripts/mediamtx-diagnose.js camera1 --whep
 */
const axios = require('axios');

const MEDIAMTX_API_URL = (process.env.MEDIAMTX_API_URL || 'http://127.0.0.1:9997').replace(/\/$/, '');
const MEDIAMTX_WEBRTC_BASE_URL = (process.env.MEDIAMTX_WEBRTC_BASE_URL || 'http://127.0.0.1:8889').replace(/\/$/, '');

const MINIMAL_OFFER_SDP = [
  'v=0',
  'o=- 0 0 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'c=IN IP4 0.0.0.0',
  'a=recvonly',
].join('\r\n');

function videoCodecFromPath(item) {
  const tracks = item?.tracks || [];
  const video = tracks.find((t) => t?.type === 'video');
  return video?.codec || null;
}

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

async function whepSmokeTest(pathName) {
  const url = `${MEDIAMTX_WEBRTC_BASE_URL}/${encodeURIComponent(pathName)}/whep`;
  console.log(`\nWHEP smoke test: POST ${url}`);
  try {
    const res = await axios.post(url, MINIMAL_OFFER_SDP, {
      headers: { 'Content-Type': 'application/sdp' },
      timeout: 30000,
      validateStatus: () => true,
    });
    console.log(`  HTTP ${res.status}`);
    if (res.status >= 200 && res.status < 300) {
      const sdp = String(res.data || '');
      const hasH264 = /H264/i.test(sdp);
      const hasH265 = /H265|HEVC/i.test(sdp);
      console.log(`  Answer length: ${sdp.length} bytes`);
      console.log(`  Contains H264: ${hasH264}`);
      console.log(`  Contains H265/HEVC: ${hasH265}`);
      if (!hasH264) {
        console.warn('  WARN: answer has no H264 — browser WebRTC may fail. Check runOnDemand transcode.');
      }
      if (hasH265) {
        console.warn('  WARN: answer includes H265 — enable ffmpeg H264 transcode in mediamtx.yml.');
      }
    } else {
      console.warn(`  WHEP failed: ${String(res.data).slice(0, 200)}`);
    }
  } catch (err) {
    console.warn(`  WHEP error: ${err.message}`);
  }
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--whep');
  const runWhep = process.argv.includes('--whep');
  const pathArg = args[0];

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
    const codec = videoCodecFromPath(item);
    const codecLabel = codec || '(unknown)';
    const warn = codec && !/^H264$/i.test(codec) ? '  <-- not H264 for WebRTC' : '';
    console.log(
      `  ${item.name}: ready=${item.ready === true} codec=${codecLabel} source=${item.source || '(runOnDemand)'}${warn}`
    );
  }

  if (pathArg) {
    const url = `${MEDIAMTX_WEBRTC_BASE_URL}/${encodeURIComponent(pathArg)}/`;
    console.log(`\nOpen in browser for WebRTC test:\n  ${url}`);
    if (runWhep) {
      await whepSmokeTest(pathArg);
    } else {
      console.log('\nAdd --whep to run localhost WHEP smoke test (starts ffmpeg transcode).');
    }
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
