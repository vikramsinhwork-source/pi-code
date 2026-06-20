const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const config = require('./config');
const auth = require('./auth');

const execFileAsync = promisify(execFile);

function isVncSource(sourceUrl) {
  return !!sourceUrl && /^vnc:\/\//i.test(sourceUrl);
}

function vncUrlToSnapshotTarget(vncUrl) {
  const match = String(vncUrl).match(/^vnc:\/\/([^:]+):(\d+)$/i);
  if (!match) return null;
  const host = match[1];
  const port = Number(match[2]);
  const display = port >= 5900 ? port - 5900 : port;
  return `${host}:${display}`;
}

async function captureVncFrame(vncUrl) {
  const target = vncUrlToSnapshotTarget(vncUrl);
  if (!target) throw new Error('Invalid VNC URL');

  const tmpPath = path.join(os.tmpdir(), `railwatch-frame-${Date.now()}.jpg`);
  await execFileAsync(
    'vncsnapshot',
    ['-quality', '80', '-allowblank', target, tmpPath],
    { timeout: 60000 }
  );

  const buffer = await fs.readFile(tmpPath);
  await fs.unlink(tmpPath).catch(() => {});

  if (!buffer?.length) throw new Error('Empty frame');
  if (buffer.length < 500) throw new Error(`Frame too small (${buffer.length} bytes)`);
  return buffer;
}

async function captureRtspFrame(streamName) {
  const rtspUrl = `rtsp://127.0.0.1:8554/${encodeURIComponent(streamName)}`;
  const tmpPath = path.join(os.tmpdir(), `railwatch-frame-${Date.now()}.jpg`);
  await execFileAsync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-y', '-rtsp_transport', 'tcp', '-i', rtspUrl, '-frames:v', '1', '-q:v', '3', tmpPath],
    { timeout: 30000 }
  );

  const buffer = await fs.readFile(tmpPath);
  await fs.unlink(tmpPath).catch(() => {});

  if (!buffer?.length) throw new Error('Empty frame');
  if (buffer.length < 500) throw new Error(`Frame too small (${buffer.length} bytes)`);
  return buffer;
}

async function captureFrame(streamName, sourceUrl) {
  if (isVncSource(sourceUrl)) {
    return captureVncFrame(sourceUrl);
  }
  return captureRtspFrame(streamName);
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

function normalizeStreams(streams = []) {
  return streams.map((entry) => {
    if (typeof entry === 'string') {
      return { name: entry, source: null };
    }
    return {
      name: entry?.name,
      source: entry?.source || null,
    };
  }).filter((entry) => entry.name);
}

async function uploadOneStream({ name: streamName, source }) {
  const buffer = await captureFrame(streamName, source);
  await uploadFrame(streamName, buffer);
}

// Capture/upload strictly one stream at a time to avoid overloading the Pi.
async function uploadFramesForStreams(streams = [], { vncOnly = false, rtspOnly = false } = {}) {
  if (!config.deviceId || !streams.length) return;

  let list = normalizeStreams(streams);
  if (vncOnly) list = list.filter((s) => isVncSource(s.source));
  if (rtspOnly) list = list.filter((s) => !isVncSource(s.source));
  if (!list.length) return;

  for (const stream of list) {
    try {
      await uploadOneStream(stream);
    } catch (err) {
      console.warn(`[agent] Frame upload failed (${stream.name}):`, err.message);
      if (err.response?.status === 401) auth.clearToken();
    }
  }
}

module.exports = {
  captureFrame,
  uploadFrame,
  uploadFramesForStreams,
  isVncSource,
};
