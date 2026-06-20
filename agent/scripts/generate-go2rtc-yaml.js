#!/usr/bin/env node
/**
 * Deploy go2rtc config to Pi and print upgrade steps.
 */
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const exampleYaml = path.join(repoRoot, 'docs', 'go2rtc.example.yaml');

console.log(`
RailWatch go2rtc deploy
=======================

1) Upgrade go2rtc on Pi (preload needs >= 1.9.11, multi-tab fixes >= 1.9.9):
   go2rtc -version
   # If older: https://github.com/AlexxIT/go2rtc/releases
   #   wget -O /tmp/go2rtc.tar.gz '<arm64-linux release URL>'
   #   sudo tar -xzf /tmp/go2rtc.tar.gz -C /usr/local/bin go2rtc
   #   sudo systemctl restart go2rtc

2) Copy config:
   cp ${exampleYaml} ~/go2rtc.yaml
   sudo systemctl restart go2rtc

3) Verify preload (producers before any browser tab):
   curl -s http://127.0.0.1:1984/api/streams | jq '.camera1.producers'

4) Agent: JPEG pipeline off for WebRTC testing (exact var name):
   echo 'JPEG_PIPELINE_ENABLED=false' >> ~/railwatch-agent/agent/.env
   pm2 restart railwatch-agent
   pm2 logs railwatch-agent --lines 20 | grep -i 'JPEG pipeline'

5) Diagnose first-open / concurrent tabs:
   node agent/scripts/webrtc-diagnose.js camera1
   node agent/scripts/webrtc-diagnose.js camera1 --concurrent 3
   node agent/scripts/webrtc-diagnose.js --stacks

6) Browser test:
   http://127.0.0.1:1984/stream.html?src=camera1&mode=webrtc
`);
