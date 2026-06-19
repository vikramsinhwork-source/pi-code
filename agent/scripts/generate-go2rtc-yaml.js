#!/usr/bin/env node
/**
 * Quick generator — prefer copying docs/go2rtc.example.yaml and editing by hand.
 *
 *   node scripts/generate-go2rtc-yaml.js > ~/go2rtc.yaml
 *
 * Env: GO2RTC_PI_IP, GO2RTC_RTSP_HOST, GO2RTC_RTSP_USER, GO2RTC_RTSP_PASS, GO2RTC_SUBTYPE (default 1)
 */
const piIp = process.env.GO2RTC_PI_IP || '192.168.1.9';
const rtspHost = process.env.GO2RTC_RTSP_HOST || '192.168.1.3';
const rtspUser = process.env.GO2RTC_RTSP_USER || 'admin';
const rtspPass = process.env.GO2RTC_RTSP_PASS || 'PASSWORD';
const subtype = process.env.GO2RTC_SUBTYPE || '1';

const rtspUrl = (ch) =>
  `rtsp://${rtspUser}:${rtspPass}@${rtspHost}:554/cam/realmonitor?channel=${ch}&subtype=${subtype}`;

console.log('# Generated from agent/scripts/generate-go2rtc-yaml.js — see docs/go2rtc.example.yaml');
console.log('api:');
console.log('  listen: ":1984"');
console.log('');
console.log('webrtc:');
console.log('  listen: ":8555/tcp"');
console.log('  candidates:');
console.log(`    - ${piIp}:8555`);
console.log('');
console.log('ffmpeg:');
console.log('  global: "-hide_banner -loglevel warning"');
console.log('  timeout: 10');
console.log('  h264: >-');
console.log('    -codec:v libx264 -pix_fmt:v yuv420p -preset:v ultrafast -tune:v zerolatency');
console.log('    -profile:v baseline -level:v 3.1 -bf:v 0 -g:v 15 -keyint_min:v 15');
console.log('    -sc_threshold:v 0 -x264-params repeat-headers=1:annexb=1');
console.log('');
console.log('streams:');
for (let ch = 1; ch <= 5; ch += 1) {
  console.log(`  camera${ch}:`);
  console.log(`    - ${rtspUrl(ch)}`);
  console.log(`    - ffmpeg:camera${ch}#video=h264`);
}
