const { describe, test } = require('node:test');
const assert = require('node:assert');
const auth = require('../src/auth');

describe('Agent auth', () => {
  test('clearToken resets cached state', () => {
    auth.clearToken();
    assert.strictEqual(auth.getToken(), null);
    assert.strictEqual(auth.isTokenExpiringSoon(), true);
  });
});

describe('Agent streams', () => {
  test('parseStreamHealth determines online/offline and counts', () => {
    const streams = require('../src/streams');
    const parsed = streams.parseStreamHealth({
      kiosk1: { producers: [{ url: 'vnc://10.0.0.1:5900' }], consumers: [] },
      kiosk2: { producers: [], consumers: [] },
    });
    assert.strictEqual(parsed.summary.online, 1);
    assert.strictEqual(parsed.summary.offline, 1);
    assert.strictEqual(parsed.streams[0].producers, 1);
    assert.strictEqual(parsed.streams[0].consumers, 0);
    assert.strictEqual(parsed.streams[0].online, true);
    assert.strictEqual(parsed.streams[1].online, false);
  });

  test('parseStreamHealth extracts codec and fps', () => {
    const streams = require('../src/streams');
    const parsed = streams.parseStreamHealth({
      kiosk1: {
        producers: [{
          url: 'vnc://10.0.0.1:5900',
          medias: ['video, recvonly, H264, 1280x720, 30 fps'],
        }],
        consumers: [{}],
      },
    });
    assert.strictEqual(parsed.streams[0].codec, 'H264');
    assert.strictEqual(parsed.streams[0].fps, 30);
    assert.strictEqual(parsed.streams[0].producerCount, 1);
    assert.strictEqual(parsed.streams[0].consumerCount, 1);
  });
});

describe('Agent reconnect', () => {
  test('socket module exports connect and scheduleReconnect', () => {
    const socketModule = require('../src/socket');
    assert.ok(typeof socketModule.scheduleReconnect === 'function');
    assert.ok(typeof socketModule.connect === 'function');
    assert.ok(typeof socketModule.disconnect === 'function');
  });
});

describe('Agent commands', () => {
  test('module exports attach and emitCommandResult', () => {
    const commands = require('../src/commands');
    assert.ok(typeof commands.attach === 'function');
    assert.ok(typeof commands.emitCommandResult === 'function');
  });
});

describe('Agent screenshot', () => {
  test('module exports captureAndUpload', () => {
    const screenshot = require('../src/screenshot');
    assert.ok(typeof screenshot.captureAndUpload === 'function');
    assert.ok(typeof screenshot.uploadScreenshot === 'function');
  });
});
