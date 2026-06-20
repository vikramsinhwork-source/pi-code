#!/usr/bin/env node
/**
 * Pi-side go2rtc WebRTC diagnostic utility.
 *
 * Usage:
 *   node scripts/webrtc-diagnose.js                         # list streams only
 *   node scripts/webrtc-diagnose.js camera1                 # POST sample offer
 *   node scripts/webrtc-diagnose.js camera1 --concurrent 3  # parallel race test
 *   node scripts/webrtc-diagnose.js camera1 --offer ./offer.json
 *   node scripts/webrtc-diagnose.js --stacks                # hung goroutine check
 *
 * offer.json: { "type": "offer", "sdp": "v=0\\r\\n..." }
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { analyzeSdp, findSuspicious, compareOfferAnswer } = require('../src/sdpDiagnostics');

const GO2RTC_URL = (process.env.GO2RTC_URL || 'http://127.0.0.1:1984').replace(/\/$/, '');

function parseArgs(argv) {
  const positional = [];
  let offerPath = null;
  let concurrent = 1;
  let stacksOnly = false;

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--offer') {
      offerPath = argv[i + 1];
      i += 1;
    } else if (arg === '--concurrent') {
      concurrent = Math.max(1, Number(argv[i + 1]) || 1);
      i += 1;
    } else if (arg === '--stacks') {
      stacksOnly = true;
    } else if (!arg.startsWith('--')) {
      positional.push(arg);
    }
  }

  return {
    streamName: positional[0] || null,
    offerPath,
    concurrent,
    stacksOnly,
  };
}

const args = parseArgs(process.argv);

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

function summarizeStreamEntry(name, info = {}) {
  const producers = Array.isArray(info.producers) ? info.producers : [];
  const consumers = Array.isArray(info.consumers) ? info.consumers : [];
  return {
    name,
    producerCount: producers.length || info.producerCount || 0,
    consumerCount: consumers.length || info.consumerCount || 0,
    online: producers.length > 0 || info.online === true,
  };
}

function summarizeStreamsPayload(data) {
  if (!data || typeof data !== 'object') return [];
  return Object.entries(data).map(([name, info]) => summarizeStreamEntry(name, info));
}

function printStreamSnapshot(label, data, focusStream = null) {
  const rows = summarizeStreamsPayload(data);
  console.log(`\n=== ${label} (${rows.length} streams) ===`);
  if (!rows.length) {
    console.log('(no streams)');
    return;
  }

  const filtered = focusStream ? rows.filter((r) => r.name === focusStream) : rows;
  for (const row of filtered) {
    console.log(
      `  ${row.name}: producers=${row.producerCount} consumers=${row.consumerCount} online=${row.online}`
    );
  }

  if (focusStream) {
    const target = filtered[0];
    if (target) {
      console.log(
        focusStream,
        target.producerCount > 0 ? 'producer WARM (preload or prior viewer)' : 'producer COLD (on-demand start)'
      );
    }
  }
}

async function fetchJson(path, label) {
  const url = `${GO2RTC_URL}${path}`;
  console.log(`\n=== GET ${url} (${label}) ===`);
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    const msg = err?.cause?.code === 'ECONNREFUSED'
      ? `Cannot connect to go2rtc at ${GO2RTC_URL} — is go2rtc running on this host?`
      : err.message;
    console.error(`ERROR: ${msg}`);
    process.exitCode = 1;
    return { ok: false, json: null, text: '' };
  }
  const text = await res.text();
  console.log(`status=${res.status} content-type=${res.headers.get('content-type')}`);
  try {
    const json = JSON.parse(text);
    return { ok: res.ok, json, text };
  } catch {
    console.log(text.slice(0, 500));
    return { ok: res.ok, json: null, text };
  }
}

async function fetchStreams(verbose = true) {
  const { ok, json, text } = await fetchJson('/api/streams', 'streams');
  if (verbose && json) {
    console.log(JSON.stringify(json, null, 2));
  } else if (verbose && !json) {
    console.log(text.slice(0, 500));
  }
  return ok ? json : null;
}

async function fetchStacks() {
  const { ok, json, text } = await fetchJson('/api/stacks', 'stacks');
  if (json) {
    const stackLines = typeof json === 'string' ? json : JSON.stringify(json, null, 2);
    console.log(stackLines.slice(0, 4000));
    if (stackLines.length > 4000) {
      console.log(`... truncated (${stackLines.length} chars total)`);
    }
  } else {
    console.log(text.slice(0, 2000));
  }
  return ok ? json : null;
}

async function loadOffer() {
  if (args.offerPath) {
    const fs = require('fs');
    const raw = JSON.parse(fs.readFileSync(args.offerPath, 'utf8'));
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
    } catch (_) {
      // fall through
    }
  }
  if (text.trim().startsWith('v=')) return { type: 'answer', sdp: text.trim(), raw: text };
  throw new Error(`Unexpected response (${contentType}): ${text.slice(0, 300)}`);
}

async function postWebrtcOffer(streamName, offer, { index = 0, quiet = false } = {}) {
  const url = `${GO2RTC_URL}/api/webrtc?src=${encodeURIComponent(streamName)}`;
  if (!quiet) {
    console.log(`\n=== POST ${url} [${index}] ===`);
    console.log(`offer bytes=${offer.sdp.length}`);
  }

  const started = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(offer),
  });
  const elapsedMs = Date.now() - started;

  if (!response.ok) {
    const errText = await response.text();
    return {
      index,
      ok: false,
      status: response.status,
      elapsedMs,
      error: errText.slice(0, 300),
    };
  }

  const answer = await normalizeResponse(response);
  return {
    index,
    ok: true,
    status: response.status,
    elapsedMs,
    answerBytes: answer.sdp.length,
    answer,
  };
}

function printOfferResult(result) {
  if (!result.ok) {
    console.log(`  [${result.index}] FAIL status=${result.status} elapsed=${result.elapsedMs}ms error=${result.error}`);
    return;
  }
  console.log(`  [${result.index}] OK status=${result.status} elapsed=${result.elapsedMs}ms answer_bytes=${result.answerBytes}`);
}

async function runSingleOffer(streamName, offer) {
  const before = await fetchStreams(false);
  printStreamSnapshot('Before offer', before, streamName);

  const result = await postWebrtcOffer(streamName, offer, { index: 0 });
  printOfferResult(result);

  if (result.ok && result.answer) {
    const offerAnalysis = analyzeSdp(offer.sdp);
    const answerAnalysis = analyzeSdp(result.answer.sdp);
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

    const cmp = compareOfferAnswer(offer.sdp, result.answer.sdp);
    if (cmp.notes.length) {
      console.log('\n--- Offer/Answer notes ---');
      cmp.notes.forEach((n) => console.log(`  • ${n}`));
    }
  } else {
    process.exitCode = 1;
  }

  const after = await fetchStreams(false);
  printStreamSnapshot('After offer', after, streamName);
}

async function runConcurrentOffers(streamName, offer, count) {
  console.log(`\n=== Concurrent race test: ${count} parallel offers → ${streamName} ===`);

  const before = await fetchStreams(false);
  printStreamSnapshot('Before concurrent offers', before, streamName);

  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: count }, (_, i) => postWebrtcOffer(streamName, offer, { index: i, quiet: true }))
  );
  const totalMs = Date.now() - started;

  console.log(`\n--- Results (wall ${totalMs}ms) ---`);
  results.sort((a, b) => a.index - b.index).forEach(printOfferResult);

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  const elapsed = results.map((r) => r.elapsedMs);
  console.log(`\nSummary: ${okCount}/${results.length} succeeded, ${failCount} failed`);
  if (elapsed.length) {
    console.log(`Per-offer elapsed: min=${Math.min(...elapsed)}ms max=${Math.max(...elapsed)}ms avg=${Math.round(elapsed.reduce((a, b) => a + b, 0) / elapsed.length)}ms`);
  }

  if (failCount > 0) {
    process.exitCode = 1;
    console.warn('\n⚠ Some concurrent offers failed — check preload and go2rtc version (>= 1.9.11)');
  }

  const after = await fetchStreams(false);
  printStreamSnapshot('After concurrent offers', after, streamName);

  if (after?.[streamName]?.consumers?.length > count) {
    console.warn(`⚠ consumer count (${after[streamName].consumers.length}) > offers sent (${count}) — possible hung consumers`);
    console.log('Tip: curl http://127.0.0.1:1984/api/stacks or restart go2rtc');
  }
}

async function main() {
  console.log(`go2rtc base: ${GO2RTC_URL}`);

  if (args.stacksOnly) {
    await fetchStacks();
    return;
  }

  await fetchStreams(!args.streamName);

  if (!args.streamName) {
    if (process.exitCode) return;
    console.log('\nTips:');
    console.log('  node scripts/webrtc-diagnose.js camera1');
    console.log('  node scripts/webrtc-diagnose.js camera1 --concurrent 3');
    console.log('  node scripts/webrtc-diagnose.js camera1 --offer ./offer-from-browser.json');
    console.log('  node scripts/webrtc-diagnose.js --stacks');
    return;
  }

  const offer = await loadOffer();

  if (args.concurrent > 1) {
    await runConcurrentOffers(args.streamName, offer, args.concurrent);
  } else {
    await runSingleOffer(args.streamName, offer);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
