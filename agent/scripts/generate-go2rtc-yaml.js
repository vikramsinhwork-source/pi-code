#!/usr/bin/env node
/**
 * Generate go2rtc.yaml from env for quick A/B testing.
 *
 *   GO2RTC_ENCODE_MODE=software node scripts/generate-go2rtc-yaml.js > ~/go2rtc.yaml
 *   GO2RTC_ENCODE_MODE=hardware node scripts/generate-go2rtc-yaml.js > ~/go2rtc.yaml
 *
 * Optional:
 *   GO2RTC_PI_IP=192.168.1.9
 *   GO2RTC_RTSP_HOST=192.168.1.3
 *   GO2RTC_RTSP_USER=admin
 *   GO2RTC_RTSP_PASS=secret
 *   GO2RTC_SUBTYPE=1   # 1=substream, 0=main
 */
const mode = (process.env.GO2RTC_ENCODE_MODE || 'software').toLowerCase();
const piIp = process.env.GO2RTC_PI_IP || '192.168.1.9';
const rtspHost = process.env.GO2RTC_RTSP_HOST || '192.168.1.3';
const rtspUser = process.env.GO2RTC_RTSP_USER || 'admin';
const rtspPass = process.env.GO2RTC_RTSP_PASS || 'PASSWORD';
const subtype = process.env.GO2RTC_SUBTYPE || '1';
const suffix = mode === 'hardware' ? '#video=h264#hardware' : '#video=h264';

function cameraLine(channel) {
  const url = `rtsp://${rtspUser}:${rtspPass}@${rtspHost}:554/cam/realmonitor?channel=${channel}&subtype=${subtype}`;
  return `    - ffmpeg:${url}${suffix}`;
}

console.log(`# Generated — encode mode: ${mode}, subtype=${subtype}`);
console.log('api:');
console.log('  listen: ":1984"');
console.log('');
console.log('webrtc:');
console.log('  listen: ":8555/tcp"');
console.log('  candidates:');
console.log(`    - ${piIp}:8555`);
console.log('');
console.log('streams:');
for (let ch = 1; ch <= 5; ch += 1) {
  console.log(`  camera${ch}:`);
  console.log(cameraLine(ch));
}
