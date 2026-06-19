/**
 * Lightweight SDP inspection for WebRTC debugging (no external deps).
 */

function splitLines(sdp) {
  if (typeof sdp !== 'string') return [];
  return sdp.replace(/\r\n/g, '\n').split('\n').filter(Boolean);
}

function parseVideoPayloads(lines) {
  const mLine = lines.find((l) => l.startsWith('m=video'));
  if (!mLine) return [];
  return mLine.split(' ').slice(3);
}

function parseRtpMaps(lines) {
  const maps = {};
  for (const line of lines) {
    const match = line.match(/^a=rtpmap:(\d+)\s+(\S+)/);
    if (match) maps[match[1]] = match[2];
  }
  return maps;
}

function parseFmtp(lines) {
  const fmtp = {};
  for (const line of lines) {
    const match = line.match(/^a=fmtp:(\d+)\s+(.+)/);
    if (match) fmtp[match[1]] = match[2];
  }
  return fmtp;
}

function parseMediaDirections(lines) {
  const directions = {};
  let currentMid = null;
  for (const line of lines) {
    const mid = line.match(/^a=mid:(\S+)/);
    if (mid) currentMid = mid[1];
    if (currentMid && /^(a=sendonly|a=recvonly|a=sendrecv|a=inactive)$/.test(line)) {
      directions[currentMid] = line.slice(2);
    }
  }
  return directions;
}

function codecSummary(lines) {
  const payloads = parseVideoPayloads(lines);
  const rtpmap = parseRtpMaps(lines);
  const fmtp = parseFmtp(lines);
  const codecs = [];

  for (const pt of payloads) {
    const codec = rtpmap[pt];
    if (!codec) continue;
    const name = codec.split('/')[0].toUpperCase();
    const entry = { pt, codec: rtpmap[pt] };
    if (fmtp[pt]) {
      entry.fmtp = fmtp[pt];
      const pli = fmtp[pt].match(/profile-level-id=([0-9a-fA-F]+)/);
      if (pli) entry.profileLevelId = pli[1];
    }
    codecs.push(entry);
    if (!['H264', 'VP8', 'VP9', 'AV1', 'H265', 'HEVC'].includes(name)) {
      entry.note = 'uncommon for browser video';
    }
  }
  return codecs;
}

function analyzeSdp(sdp) {
  const lines = splitLines(sdp);
  return {
    lineCount: lines.length,
    hasVideo: lines.some((l) => l.startsWith('m=video')),
    hasAudio: lines.some((l) => l.startsWith('m=audio')),
    directions: parseMediaDirections(lines),
    videoCodecs: codecSummary(lines),
    fingerprint: (lines.find((l) => l.startsWith('a=fingerprint:')) || '').slice(2),
    iceUfrag: (lines.find((l) => l.startsWith('a=ice-ufrag:')) || '').slice(12),
    bundle: (lines.find((l) => l.startsWith('a=group:BUNDLE')) || '').slice(2),
  };
}

function findSuspicious(analysis) {
  const flags = [];
  const names = analysis.videoCodecs.map((c) => c.codec.split('/')[0].toUpperCase());

  if (!analysis.hasVideo) flags.push('no video m-line');
  if (names.includes('H265') || names.includes('HEVC')) {
    flags.push('answer/offer includes H265/HEVC — Chrome may not decode; ensure go2rtc transcodes to H264');
  }
  if (analysis.hasVideo && !names.some((n) => ['H264', 'VP8', 'VP9', 'AV1'].includes(n))) {
    flags.push('no browser-common video codec (H264/VP8/VP9/AV1) in video m-line');
  }
  for (const c of analysis.videoCodecs) {
    if (c.codec.toUpperCase().startsWith('H264') && !c.profileLevelId) {
      flags.push(`H264 pt=${c.pt} missing profile-level-id in fmtp`);
    }
  }
  const dirs = Object.values(analysis.directions);
  if (dirs.length && !dirs.some((d) => d === 'sendonly' || d === 'sendrecv')) {
    flags.push(`video direction may not send media: ${JSON.stringify(analysis.directions)}`);
  }
  return flags;
}

function logSdpSummary(label, sdp) {
  if (!sdp || typeof sdp !== 'string') {
    console.log(`[agent][sdp] ${label}: (empty)`);
    return null;
  }
  const analysis = analyzeSdp(sdp);
  const suspicious = findSuspicious(analysis);
  console.log(`[agent][sdp] ${label}: bytes=${sdp.length} preview=${JSON.stringify(sdp.slice(0, 200))}`);
  console.log(`[agent][sdp] ${label}: codecs=${JSON.stringify(analysis.videoCodecs.map((c) => ({
    pt: c.pt,
    codec: c.codec,
    profileLevelId: c.profileLevelId || null,
  })))} directions=${JSON.stringify(analysis.directions)}`);
  if (suspicious.length) {
    console.warn(`[agent][sdp] ${label}: suspicious=${suspicious.join('; ')}`);
  }
  return { analysis, suspicious };
}

function compareOfferAnswer(offerSdp, answerSdp) {
  const offer = analyzeSdp(offerSdp);
  const answer = analyzeSdp(answerSdp);
  const notes = [];

  const offerDirs = Object.values(offer.directions);
  const answerDirs = Object.values(answer.directions);
  if (offerDirs.includes('recvonly') && !answerDirs.some((d) => d === 'sendonly' || d === 'sendrecv')) {
    notes.push('offer recvonly but answer does not sendonly/sendrecv — media direction mismatch');
  }

  const answerH264 = answer.videoCodecs.filter((c) => c.codec.toUpperCase().startsWith('H264'));
  if (answerH264.length === 1 && answerH264[0].profileLevelId) {
    notes.push(`negotiated H264 profile-level-id=${answerH264[0].profileLevelId}`);
  }

  return { offer, answer, notes };
}

module.exports = {
  analyzeSdp,
  findSuspicious,
  logSdpSummary,
  compareOfferAnswer,
};
