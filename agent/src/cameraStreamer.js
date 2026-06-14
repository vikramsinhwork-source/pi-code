const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const config = require('./config');
const streamFrames = require('./streamFrames');

// Persistent low-latency camera pipeline.
//
// For each RTSP camera, a single long-lived ffmpeg process decodes the stream
// and continuously overwrites one JPEG file (-update 1) at a modest fps. A warm
// decoder avoids the ~2s per-frame ffmpeg startup cost that made spawn-per-frame
// capture a slideshow. A separate uploader pushes the newest frame to the backend.

const FRAME_DIR = path.join(os.tmpdir(), 'railwatch-cam-frames');
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

const ffmpegProcs = new Map();   // name -> ChildProcess
const uploadTimers = new Map();  // name -> interval handle
const lastMtime = new Map();     // name -> mtimeMs
const lastSignature = new Map(); // name -> frame signature
const uploadStats = new Map();   // name -> rolling stats
let running = false;

// #region agent log
function debugLog(hypothesisId, location, message, data = {}, runId = 'run1') {
  fetch('http://127.0.0.1:7515/ingest/ab84a119-a91c-4713-881e-a8c644fb3969', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Debug-Session-Id': '2b0af4',
    },
    body: JSON.stringify({
      sessionId: '2b0af4',
      runId,
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
}
// #endregion

function frameSignature(buf) {
  if (!buf || !buf.length) return 0;
  const len = buf.length;
  const q1 = Math.floor(len / 4);
  const q2 = Math.floor(len / 2);
  const q3 = Math.floor((len * 3) / 4);
  return [len, buf[0], buf[q1], buf[q2], buf[q3], buf[len - 1]].join(':');
}

function noteUploadStat(name, { changed, uploadMs }) {
  const now = Date.now();
  const stats = uploadStats.get(name) || {
    windowStartMs: now,
    uploads: 0,
    changedUploads: 0,
    totalUploadMs: 0,
  };
  stats.uploads += 1;
  if (changed) stats.changedUploads += 1;
  stats.totalUploadMs += uploadMs;

  const elapsedMs = now - stats.windowStartMs;
  if (elapsedMs >= 10000) {
    const elapsedSec = elapsedMs / 1000;
    const fps = stats.uploads / elapsedSec;
    const changedFps = stats.changedUploads / elapsedSec;
    const avgUploadMs = stats.uploads ? stats.totalUploadMs / stats.uploads : 0;
    // eslint-disable-next-line no-console
    console.log(
      `[agent][frame-stats] stream=${name} fps=${fps.toFixed(2)} changed_fps=${changedFps.toFixed(2)} avg_upload_ms=${avgUploadMs.toFixed(1)} uploads=${stats.uploads}`
    );
    stats.windowStartMs = now;
    stats.uploads = 0;
    stats.changedUploads = 0;
    stats.totalUploadMs = 0;
  }
  uploadStats.set(name, stats);
}

function framePath(name) {
  return path.join(FRAME_DIR, `${name}.jpg`);
}

function spawnFfmpeg(name, source) {
  const out = framePath(name);
  // #region agent log
  debugLog('H1', 'cameraStreamer.js:spawnFfmpeg', 'Starting ffmpeg decoder', {
    streamName: name,
    sourceScheme: String(source || '').split(':')[0] || 'unknown',
    cameraFps: config.cameraFps,
  });
  // #endregion
  const args = [
    '-nostdin',
    '-rtsp_transport', 'tcp',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-i', source,
    '-an',
    '-r', String(config.cameraFps),
    '-q:v', '7',
    '-f', 'image2',
    '-update', '1',
    '-y', out,
  ];
  const proc = spawn('ffmpeg', args, { stdio: 'ignore' });
  proc.on('exit', (code) => {
    // #region agent log
    debugLog('H1', 'cameraStreamer.js:spawnFfmpeg:exit', 'ffmpeg decoder exited', {
      streamName: name,
      exitCode: code,
    });
    // #endregion
    ffmpegProcs.delete(name);
    if (running) {
      setTimeout(() => { if (running) spawnFfmpeg(name, source); }, 3000);
    }
  });
  ffmpegProcs.set(name, proc);
}

function isCompleteJpeg(buf) {
  return buf
    && buf.length > 500
    && buf.subarray(0, 2).equals(SOI)
    && buf.subarray(buf.length - 2).equals(EOI);
}

function startUploader(name) {
  const out = framePath(name);
  const timer = setInterval(async () => {
    try {
      const stat = await fsp.stat(out);
      if (stat.mtimeMs === lastMtime.get(name)) return;
      const buf = await fsp.readFile(out);
      if (!isCompleteJpeg(buf)) return; // skip torn frame mid-write
      const sig = frameSignature(buf);
      const prevSig = lastSignature.get(name);
      const changed = prevSig !== sig;
      // #region agent log
      debugLog('H1', 'cameraStreamer.js:startUploader:beforeUpload', 'Prepared frame for upload', {
        streamName: name,
        fileMtimeMs: stat.mtimeMs,
        sizeBytes: buf.length,
        frameChanged: changed,
      });
      // #endregion
      lastMtime.set(name, stat.mtimeMs);
      lastSignature.set(name, sig);
      const uploadStartMs = Date.now();
      await streamFrames.uploadFrame(name, buf);
      const uploadMs = Date.now() - uploadStartMs;
      noteUploadStat(name, { changed, uploadMs });
      if (uploadMs > 1200) {
        // eslint-disable-next-line no-console
        console.warn(`[agent][slow-upload] stream=${name} upload_ms=${uploadMs} size_bytes=${buf.length}`);
      }
      // #region agent log
      debugLog('H2', 'cameraStreamer.js:startUploader:afterUpload', 'Frame upload succeeded', {
        streamName: name,
        uploadedBytes: buf.length,
        uploadMs,
      });
      // #endregion
    } catch (err) {
      if (err.code === 'ENOENT') return; // decoder not producing yet
      // eslint-disable-next-line no-console
      console.warn(`[agent] Camera upload failed (${name}):`, err.message);
      // #region agent log
      debugLog('H2', 'cameraStreamer.js:startUploader:catch', 'Frame upload failed', {
        streamName: name,
        error: err.message,
        statusCode: err.response?.status || null,
      });
      // #endregion
    }
  }, config.cameraUploadIntervalMs);
  uploadTimers.set(name, timer);
}

async function start(cameras = []) {
  running = true;
  await fsp.mkdir(FRAME_DIR, { recursive: true }).catch(() => {});

  const wanted = new Set(cameras.map((c) => c.name));

  // Stop streams that are no longer present.
  for (const name of [...ffmpegProcs.keys()]) {
    if (!wanted.has(name)) stopOne(name);
  }

  for (const { name, source } of cameras) {
    if (!name || !source) continue;
    if (!ffmpegProcs.has(name)) spawnFfmpeg(name, source);
    if (!uploadTimers.has(name)) startUploader(name);
  }
}

function stopOne(name) {
  const proc = ffmpegProcs.get(name);
  if (proc) { try { proc.kill('SIGKILL'); } catch (_) {} ffmpegProcs.delete(name); }
  const timer = uploadTimers.get(name);
  if (timer) { clearInterval(timer); uploadTimers.delete(name); }
  lastMtime.delete(name);
  fs.rmSync(framePath(name), { force: true });
}

function stop() {
  running = false;
  for (const name of [...ffmpegProcs.keys()]) stopOne(name);
}

module.exports = { start, stop };
