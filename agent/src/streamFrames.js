const axios = require('axios');
const FormData = require('form-data');
const config = require('./config');
const auth = require('./auth');

async function captureFrame(streamName) {
  const url = `${config.go2rtcUrl}/api/frame.jpeg?src=${encodeURIComponent(streamName)}`;
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 20000,
    validateStatus: (s) => s === 200,
  });
  if (!response.data?.byteLength) {
    throw new Error('Empty frame');
  }
  if (response.data.byteLength < 500) {
    throw new Error(`Frame too small (${response.data.byteLength} bytes)`);
  }
  return Buffer.from(response.data);
}

async function uploadFrame(streamName, buffer) {
  const token = await auth.ensureToken();
  const form = new FormData();
  form.append('frame', buffer, {
    filename: `${streamName}.jpg`,
    contentType: 'image/jpeg',
  });

  const url = `${config.apiUrl}/api/monitoring/devices/${config.deviceId}/streams/${encodeURIComponent(streamName)}/frame`;
  await axios.post(url, form, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...form.getHeaders(),
    },
    maxBodyLength: Infinity,
    timeout: 30000,
  });
}

async function uploadFramesForStreams(streamNames = []) {
  if (!config.deviceId || !streamNames.length) return;

  for (const streamName of streamNames) {
    try {
      const buffer = await captureFrame(streamName);
      await uploadFrame(streamName, buffer);
    } catch (err) {
      console.warn(`[agent] Frame upload failed (${streamName}):`, err.message);
      if (err.response?.status === 401) auth.clearToken();
    }
  }
}

module.exports = { captureFrame, uploadFrame, uploadFramesForStreams };
