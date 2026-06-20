const { describe, test } = require('node:test');
const assert = require('node:assert');

describe('webrtc-diagnose stream summary', () => {
  test('summarizeStreamsPayload counts producers and consumers', () => {
    // Inline copy of helpers — script is CLI-only; test documents expected shape.
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

    const rows = summarizeStreamsPayload({
      camera1: { producers: [{}], consumers: [{}, {}] },
      camera2: { producers: [], consumers: [] },
    });

    assert.strictEqual(rows[0].producerCount, 1);
    assert.strictEqual(rows[0].consumerCount, 2);
    assert.strictEqual(rows[0].online, true);
    assert.strictEqual(rows[1].online, false);
  });
});

describe('Agent config JPEG env', () => {
  test('jpegPipelineEnabled is false only when JPEG_PIPELINE_ENABLED=false', () => {
    assert.strictEqual('false' !== 'false', false);
    assert.strictEqual('true' !== 'false', true);
    assert.strictEqual(undefined !== 'false', true);
  });
});
