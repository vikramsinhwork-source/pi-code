const os = require('os');

function isPrivateIpv4(ip) {
  if (!ip || typeof ip !== 'string') return false;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('10.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  return false;
}

/**
 * IP clients use for direct MediaMTX WebRTC playback.
 * Prefers 192.168.x LAN over other interfaces (e.g. railway VPN 10.x).
 * Override with PI_PLAYBACK_IP or MEDIAMTX_WEBRTC_HOST when needed.
 */
function getPlaybackIp(env = process.env) {
  const override = (env.PI_PLAYBACK_IP || env.MEDIAMTX_WEBRTC_HOST || '').trim();
  if (override) return override;

  const candidates = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        candidates.push(entry.address);
      }
    }
  }

  const lan192 = candidates.find((ip) => ip.startsWith('192.168.'));
  if (lan192) return lan192;

  const lan172 = candidates.find((ip) => /^172\.(1[6-9]|2\d|3[01])\./.test(ip));
  if (lan172) return lan172;

  const lan10 = candidates.find((ip) => ip.startsWith('10.'));
  if (lan10) return lan10;

  return candidates[0] || null;
}

module.exports = { getPlaybackIp, isPrivateIpv4 };
