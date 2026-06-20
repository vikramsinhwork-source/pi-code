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
  test('parseStreamHealth determines online/offline from MediaMTX ready flag', () => {
    const streams = require('../src/streams');
    const parsed = streams.parseStreamHealth({
      camera1: { ready: true, source: 'rtsp://nvr/cam1' },
      camera2: { ready: false },
    });
    assert.strictEqual(parsed.summary.online, 1);
    assert.strictEqual(parsed.summary.offline, 1);
    assert.strictEqual(parsed.streams[0].online, true);
    assert.strictEqual(parsed.streams[1].online, false);
  });

  test('parseStreamHealth extracts codec from tracks', () => {
    const streams = require('../src/streams');
    const parsed = streams.parseStreamHealth({
      camera1: {
        ready: true,
        tracks: [{ type: 'video', codec: 'H264' }],
      },
    });
    assert.strictEqual(parsed.streams[0].codec, 'H264');
    assert.strictEqual(parsed.streams[0].online, true);
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
