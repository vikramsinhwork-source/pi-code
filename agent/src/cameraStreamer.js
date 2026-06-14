const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const config = require('./config');
const streamFrames = require('./streamFrames');

const FRAME_DIR = path.join(os.tmpdir(), 'railwatch-cam-frames');
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

const ffmpegProcs = new Map();    // name -> ChildProcess
const uploadTimers = new Map();   // name -> interval handle
const watchdogTimers = new Map(); // name -> interval handle  ← NEW
const lastMtime = new Map();      // name -> mtimeMs
const lastSignature = new Map();  // name -> frame signature
const uploadStats = new Map();    // name -> rolling stats
const uploadInFlight = new Map(); // name -> bool

// ── NEW: track when Pi last successfully wrote/uploaded a frame ──
const lastFfmpegWriteMs = new Map();  // name -> timestamp ffmpeg last changed file
const lastUploadSuccessMs = new Map(); // name -> timestamp of last successful upload
const ffmpegRestartCount = new Map();  // name -> number of restarts
const ffmpegStartedMs = new Map();     // name -> when current process started

let running = false;

// ─── Logging ────────────────────────────────────────────────────────────────

function log(level, name, msg, extra = '') {
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console[level === 'warn' ? 'warn' : 'log'](
    `[agent][${level}][${name}] ${ts} — ${msg}${extra ? ' | ' + extra : ''}`
  );
}

// ─── Frame helpers ───────────────────────────────────────────────────────────

function frameSignature(buf) {
  if (!buf || !buf.length) return 0;
  const len = buf.length;
  const q1 = Math.floor(len / 4);
  const q2 = Math.floor(len / 2);
  const q3 = Math.floor((len * 3) / 4);
  return [len, buf[0], buf[q1], buf[q2], buf[q3], buf[len - 1]].join(':');
}

function isCompleteJpeg(buf) {
  return (
    buf &&
    buf.length > 500 &&
    buf.subarray(0, 2).equals(SOI) &&
    buf.subarray(buf.length - 2).equals(EOI)
  );
}

function framePath(name) {
  return path.join(FRAME_DIR, `${name}.jpg`);
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
    log('log', name,
      `frame-stats fps=${fps.toFixed(2)} changed_fps=${changedFps.toFixed(2)} ` +
      `avg_upload_ms=${avgUploadMs.toFixed(1)} uploads=${stats.uploads}`
    );
    stats.windowStartMs = now;
    stats.uploads = 0;
    stats.changedUploads = 0;
    stats.totalUploadMs = 0;
  }
  uploadStats.set(name, stats);
}

// ─── ffmpeg ──────────────────────────────────────────────────────────────────

function spawnFfmpeg(name, source) {
  const out = framePath(name);
  const restarts = ffmpegRestartCount.get(name) || 0;

  log('log', name, `spawnFfmpeg restart=#${restarts} source=${String(source).split(':')[0]}`);

  const args = [
    '-nostdin',
    '-rtsp_transport', 'tcp',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-i', source,
    '-an',
    '-r', String(config.cameraFps),
    '-vf', 'scale=480:-1',  // shrink to 480px wide — reduces file from 60KB → ~8KB
    '-q:v', '12',           // lower quality (7=best/heavy, 31=worst/tiny) — sweet spot at 12
    '-f', 'image2',
    '-update', '1',
    '-y', out,
  ];

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

  // Capture stderr for diagnostics — only log last 200 chars on exit
  let stderrTail = '';
  proc.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-200);
  });

  ffmpegStartedMs.set(name, Date.now());

  proc.on('exit', (code) => {
    ffmpegProcs.delete(name);
    stopWatchdog(name); // ← stop watchdog when ffmpeg exits (will restart with new one)

    const uptimeMs = Date.now() - (ffmpegStartedMs.get(name) || Date.now());
    log('warn', name,
      `ffmpeg exited code=${code} uptime=${(uptimeMs / 1000).toFixed(1)}s`,
      `stderr_tail: ${stderrTail.replace(/\n/g, ' ')}`
    );

    if (running) {
      // Backoff: 3s if it ran >30s (healthy run), else 6s, cap at 10s
      const delay = uptimeMs > 30000 ? 3000 : restarts < 3 ? 6000 : 10000;
      log('log', name, `scheduling ffmpeg restart in ${delay}ms`);
      setTimeout(() => {
        if (running) {
          ffmpegRestartCount.set(name, restarts + 1);
          spawnFfmpeg(name, source);
        }
      }, delay);
    }
  });

  ffmpegProcs.set(name, proc);

  // ── NEW: fs.watch to track when ffmpeg actually writes a frame ──
  // This gives us ground truth on whether ffmpeg is alive and producing.
  try {
    const watcher = fs.watch(path.dirname(out), (event, filename) => {
      if (filename === path.basename(out) && event === 'change') {
        lastFfmpegWriteMs.set(name, Date.now());
      }
    });
    // Store watcher so we can close it on stop
    proc._frameWatcher = watcher;
    proc.on('exit', () => { try { watcher.close(); } catch (_) {} });
  } catch (_) {
    // fs.watch not available on all Pi OS configs — not fatal
  }
}

// ─── Watchdog ────────────────────────────────────────────────────────────────
// Every 8s: check if ffmpeg has written a new frame in the last 12s.
// If not, kill the process — the exit handler restarts it automatically.

const WATCHDOG_INTERVAL_MS = 8000;
const WATCHDOG_STALE_THRESHOLD_MS = 12000;

function startWatchdog(name, source) {
  stopWatchdog(name);

  const timer = setInterval(() => {
    const lastWrite = lastFfmpegWriteMs.get(name);
    const proc = ffmpegProcs.get(name);

    if (!proc) return; // already dead, exit handler will restart

    if (!lastWrite) {
      // ffmpeg just started, give it 15s to produce first frame
      const startedMs = ffmpegStartedMs.get(name) || 0;
      if (Date.now() - startedMs > 15000) {
        log('warn', name, 'watchdog: no frame ever written after 15s — killing ffmpeg');
        try { proc.kill('SIGKILL'); } catch (_) {}
      }
      return;
    }

    const staleMs = Date.now() - lastWrite;
    if (staleMs > WATCHDOG_STALE_THRESHOLD_MS) {
      log('warn', name,
        `watchdog: ffmpeg stalled (no new frame for ${staleMs}ms) — killing to restart`
      );
      try { proc.kill('SIGKILL'); } catch (_) {}
      // exit handler fires, restarts ffmpeg, new watchdog starts with spawnFfmpeg
    }
  }, WATCHDOG_INTERVAL_MS);

  watchdogTimers.set(name, timer);
}

function stopWatchdog(name) {
  const t = watchdogTimers.get(name);
  if (t) { clearInterval(t); watchdogTimers.delete(name); }
}

// ─── Uploader ────────────────────────────────────────────────────────────────

// Force-upload after this many ms even if mtime hasn't changed.
// Ensures backend always has a recent frame (keepalive) and catches
// the edge case where ffmpeg re-writes identical bytes (mtime changes but sig same).
const FORCE_UPLOAD_AFTER_MS = 12000;

function startUploader(name) {
  const out = framePath(name);

  const timer = setInterval(async () => {
    if (uploadInFlight.get(name)) return;
    uploadInFlight.set(name, true);

    try {
      let stat;
      try {
        stat = await fsp.stat(out);
      } catch (err) {
        if (err.code === 'ENOENT') return; // ffmpeg not producing yet
        throw err;
      }

      const mtimeChanged = stat.mtimeMs !== lastMtime.get(name);
      const lastUpload = lastUploadSuccessMs.get(name) || 0;
      const forceUpload = (Date.now() - lastUpload) > FORCE_UPLOAD_AFTER_MS;

      // ── KEY FIX: upload if mtime changed OR if we haven't uploaded in 12s ──
      if (!mtimeChanged && !forceUpload) return;

      if (!mtimeChanged && forceUpload) {
        log('log', name, `force-upload: no mtime change but ${Date.now() - lastUpload}ms since last upload`);
      }

      const buf = await fsp.readFile(out);
      if (!isCompleteJpeg(buf)) {
        log('log', name, 'skipping torn/incomplete JPEG');
        return;
      }

      const sig = frameSignature(buf);
      const changed = lastSignature.get(name) !== sig;

      lastMtime.set(name, stat.mtimeMs);
      lastSignature.set(name, sig);

      const uploadStartMs = Date.now();
      await streamFrames.uploadFrame(name, buf);
      const uploadMs = Date.now() - uploadStartMs;

      lastUploadSuccessMs.set(name, Date.now()); // ← track successful upload time

      noteUploadStat(name, { changed, uploadMs });

      // At 29KB/s connection, warn only if upload takes >3s (likely network hiccup)
      if (uploadMs > 3000) {
        log('warn', name, `slow-upload upload_ms=${uploadMs} size_bytes=${buf.length}`);
      }
    } catch (err) {
      log('warn', name, `upload failed: ${err.message}`);
    } finally {
      uploadInFlight.set(name, false);
    }
  }, config.cameraUploadIntervalMs);

  uploadTimers.set(name, timer);
}

// ─── Health export (for heartbeat reporting) ─────────────────────────────────

function getCameraHealth(name) {
  return {
    name,
    ffmpegAlive: ffmpegProcs.has(name),
    uploaderAlive: uploadTimers.has(name),
    lastFfmpegWriteMs: lastFfmpegWriteMs.get(name) || null,
    lastUploadSuccessMs: lastUploadSuccessMs.get(name) || null,
    ffmpegRestarts: ffmpegRestartCount.get(name) || 0,
    ffmpegStaleMs: lastFfmpegWriteMs.get(name)
      ? Date.now() - lastFfmpegWriteMs.get(name)
      : null,
    uploadStaleMs: lastUploadSuccessMs.get(name)
      ? Date.now() - lastUploadSuccessMs.get(name)
      : null,
  };
}

function getAllCameraHealth() {
  return [...ffmpegProcs.keys()].map(getCameraHealth);
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

async function start(cameras = []) {
  running = true;
  await fsp.mkdir(FRAME_DIR, { recursive: true }).catch(() => {});

  const wanted = new Set(cameras.map((c) => c.name));

  for (const name of [...ffmpegProcs.keys()]) {
    if (!wanted.has(name)) stopOne(name);
  }

  for (const { name, source } of cameras) {
    if (!name || !source) continue;
    if (!ffmpegProcs.has(name)) {
      spawnFfmpeg(name, source);
      startWatchdog(name, source); // ← start watchdog alongside ffmpeg
    }
    if (!uploadTimers.has(name)) startUploader(name);
  }
}

function stopOne(name) {
  const proc = ffmpegProcs.get(name);
  if (proc) {
    try { proc.kill('SIGKILL'); } catch (_) {}
    ffmpegProcs.delete(name);
  }
  const timer = uploadTimers.get(name);
  if (timer) { clearInterval(timer); uploadTimers.delete(name); }
  stopWatchdog(name);
  uploadInFlight.delete(name);
  lastMtime.delete(name);
  lastFfmpegWriteMs.delete(name);
  lastUploadSuccessMs.delete(name);
  fs.rmSync(framePath(name), { force: true });
}

function stop() {
  running = false;
  for (const name of [...ffmpegProcs.keys()]) stopOne(name);
}

module.exports = { start, stop, getCameraHealth, getAllCameraHealth };
