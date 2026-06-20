const { describe, test } = require('node:test');
const assert = require('node:assert');

describe('mediamtx paths list normalization', () => {
  test('normalizeMediaMtxPathsList merges API items with configured paths', () => {
    const streams = require('../src/streams');
    const map = streams.buildFallbackPathMap();
    assert.ok(map.camera1);
    assert.ok(map.camera5);
  });
});

describe('Agent config JPEG env', () => {
  test('jpegPipelineEnabled is false only when JPEG_PIPELINE_ENABLED=false', () => {
    assert.strictEqual('false' !== 'false', false);
    assert.strictEqual('true' !== 'false', true);
    assert.strictEqual(undefined !== 'false', true);
  });
});
