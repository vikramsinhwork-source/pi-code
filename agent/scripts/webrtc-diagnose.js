#!/usr/bin/env node
/**
 * Pi-side go2rtc WebRTC diagnostic utility.
 *
 * Usage:
 *   node scripts/webrtc-diagnose.js                    # list streams only
 *   node scripts/webrtc-diagnose.js camera2            # POST sample offer to go2rtc
 *   node scripts/webrtc-diagnose.js camera2 --offer ./offer.json
 *
 * offer.json: { "type": "offer", "sdp": "v=0\\r\\n..." }
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { analyzeSdp, findSuspicious, compareOfferAnswer } = require('../src/sdpDiagnostics');

const GO2RTC_URL = (process.env.GO2RTC_URL || 'http://127.0.0.1:1984').replace(/\/$/, '');
const streamArg = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
const offerFlagIdx = process.argv.indexOf('--offer');
const offerPath = offerFlagIdx >= 0 ? process.argv[offerFlagIdx + 1] : null;

/** Minimal recvonly video offer (Chrome-like codecs). go2rtc uses this for SDP negotiation probe. */
const SAMPLE_OFFER_SDP = [
  'v=0',
  'o=- 4611731400000000000 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99 100 101 35 36 37 38 103 104 107 108 109 114 115 116 117 118 39 40 41 42 43 44 45 46 47 48 112 113 119 120 121 122 123 124 125',
  'c=IN IP4 0.0.0.0',
  'a=rtcp:9 IN IP4 0.0.0.0',
  'a=ice-ufrag:diag',
  'a=ice-pwd:diagnosticpassword000000000000',
  'a=ice-options:trickle',
  'a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF',
  'a=setup:actpass',
  'a=mid:0',
  'a=extmap:1 urn:ietf:params:rtp-hdrext:toffset',
  'a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
  'a=extmap:3 urn:3gpp:video-orientation',
  'a=extmap:4 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
  'a=extmap:5 http://www.webrtc.org/experiments/rtp-hdrext/playout-delay',
  'a=extmap:6 http://www.webrtc.org/experiments/rtp-hdrext/video-content-type',
  'a=extmap:7 http://www.webrtc.org/experiments/rtp-hdrext/video-timing',
  'a=extmap:8 http://www.webrtc.org/experiments/rtp-hdrext/color-space',
  'a=extmap:9 urn:ietf:params:rtp-hdrext:sdes:mid',
  'a=extmap:10 urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id',
  'a=extmap:11 urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id',
  'a=recvonly',
  'a=rtcp-mux',
  'a=rtcp-rsize',
  'a=rtpmap:96 VP8/90000',
  'a=rtpmap:97 rtx/90000',
  'a=fmtp:97 apt=96',
  'a=rtpmap:98 VP9/90000',
  'a=rtpmap:99 rtx/90000',
  'a=fmtp:99 apt=98',
  'a=rtpmap:100 H264/90000',
  'a=rtcp-fb:100 goog-remb',
  'a=rtcp-fb:100 transport-cc',
  'a=rtcp-fb:100 ccm fir',
  'a=rtcp-fb:100 nack',
  'a=rtcp-fb:100 nack pli',
  'a=fmtp:100 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f',
  'a=rtpmap:101 rtx/90000',
  'a=fmtp:101 apt=100',
  'a=rtpmap:35 AV1/90000',
  'a=rtpmap:36 rtx/90000',
  'a=fmtp:36 apt=35',
].join('\r\n') + '\r\n';

async function fetchStreams() {
  const url = `${GO2RTC_URL}/api/streams`;
  console.log(`\n=== GET ${url} ===`);
  const res = await fetch(url);
  const text = await res.text();
  console.log(`status=${res.status} content-type=${res.headers.get('content-type')}`);
  try {
    const json = JSON.parse(text);
    console.log(JSON.stringify(json, null, 2));
    return json;
  } catch {
    console.log(text.slice(0, 500));
    return null;
  }
}

async function loadOffer() {
  if (offerPath) {
    const fs = require('fs');
    const raw = JSON.parse(fs.readFileSync(offerPath, 'utf8'));
    return { type: raw.type || 'offer', sdp: raw.sdp };
  }
  return { type: 'offer', sdp: SAMPLE_OFFER_SDP };
}

async function normalizeResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();
  if (contentType.includes('application/json')) {
    try {
      const json = JSON.parse(text);
      if (typeof json.sdp === 'string') return { type: json.type || 'answer', sdp: json.sdp, raw: json };
      if (typeof json === 'string') return { type: 'answer', sdp: json, raw: json };
    } catch (_) {}
  }
  if (text.trim().startsWith('v=')) return { type: 'answer', sdp: text.trim(), raw: text };
  throw new Error(`Unexpected response (${contentType}): ${text.slice(0, 300)}`);
}

async function postWebrtcOffer(streamName, offer) {
  const url = `${GO2RTC_URL}/api/webrtc?src=${encodeURIComponent(streamName)}`;
  console.log(`\n=== POST ${url} ===`);
  console.log(`offer bytes=${offer.sdp.length}`);

  const started = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(offer),
  });
  const elapsedMs = Date.now() - started;

  console.log(`status=${response.status} elapsed=${elapsedMs}ms content-type=${response.headers.get('content-type')}`);

  if (!response.ok) {
    const errText = await response.text();
    console.error(`ERROR: ${errText.slice(0, 500)}`);
    process.exitCode = 1;
    return null;
  }

  const answer = await normalizeResponse(response);
  console.log(`answer type=${answer.type} sdp bytes=${answer.sdp.length}`);
  console.log(`answer preview: ${JSON.stringify(answer.sdp.slice(0, 200))}`);

  const offerAnalysis = analyzeSdp(offer.sdp);
  const answerAnalysis = analyzeSdp(answer.sdp);
  console.log('\n--- Offer codecs ---');
  console.log(JSON.stringify(offerAnalysis.videoCodecs, null, 2));
  console.log('\n--- Answer codecs ---');
  console.log(JSON.stringify(answerAnalysis.videoCodecs, null, 2));
  console.log('\n--- Answer directions ---');
  console.log(JSON.stringify(answerAnalysis.directions, null, 2));

  const suspicious = findSuspicious(answerAnalysis);
  if (suspicious.length) {
    console.warn('\n⚠ Suspicious:', suspicious.join('\n  '));
  } else {
    console.log('\n✓ No obvious SDP issues detected');
  }

  const cmp = compareOfferAnswer(offer.sdp, answer.sdp);
  if (cmp.notes.length) {
    console.log('\n--- Offer/Answer notes ---');
    cmp.notes.forEach((n) => console.log(`  • ${n}`));
  }

  return answer;
}

async function main() {
  console.log(`go2rtc base: ${GO2RTC_URL}`);
  await fetchStreams();

  if (!streamArg) {
    console.log('\nTip: node scripts/webrtc-diagnose.js camera2');
    console.log('     node scripts/webrtc-diagnose.js camera2 --offer ./offer-from-browser.json');
    return;
  }

  const offer = await loadOffer();
  await postWebrtcOffer(streamArg, offer);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
