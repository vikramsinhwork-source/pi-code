const { describe, test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const { getPlaybackIp, isPrivateIpv4 } = require('../src/network');

describe('network.getPlaybackIp', () => {
  test('isPrivateIpv4 recognizes RFC1918 ranges', () => {
    assert.strictEqual(isPrivateIpv4('192.168.1.8'), true);
    assert.strictEqual(isPrivateIpv4('10.71.35.100'), true);
    assert.strictEqual(isPrivateIpv4('8.8.8.8'), false);
  });

  test('prefers PI_PLAYBACK_IP override', () => {
    assert.strictEqual(getPlaybackIp({ PI_PLAYBACK_IP: '192.168.1.8' }), '192.168.1.8');
  });

  test('prefers 192.168.x over 10.x when both present', () => {
    const original = os.networkInterfaces;
    os.networkInterfaces = () => ({
      eth0: [{ family: 'IPv4', internal: false, address: '10.71.35.100' }],
      wlan0: [{ family: 'IPv4', internal: false, address: '192.168.1.8' }],
    });
    try {
      assert.strictEqual(getPlaybackIp({}), '192.168.1.8');
    } finally {
      os.networkInterfaces = original;
    }
  });
});
