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
let running = false;

function framePath(name) {
  return path.join(FRAME_DIR, `${name}.jpg`);
}

function spawnFfmpeg(name, source) {
  const out = framePath(name);
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
      lastMtime.set(name, stat.mtimeMs);
      await streamFrames.uploadFrame(name, buf);
    } catch (err) {
      if (err.code === 'ENOENT') return; // decoder not producing yet
      // eslint-disable-next-line no-console
      console.warn(`[agent] Camera upload failed (${name}):`, err.message);
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
