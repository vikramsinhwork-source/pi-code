const fs = require('fs/promises');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const FormData = require('form-data');
const axios = require('axios');
const config = require('./config');
const auth = require('./auth');

const execAsync = promisify(exec);

async function ensureScreenshotDir() {
  await fs.mkdir(config.screenshotDir, { recursive: true });
}

async function captureDesktop(outputPath) {
  await execAsync(`DISPLAY=${config.kioskDisplay} scrot -o "${outputPath}"`, {
    env: { ...process.env, DISPLAY: config.kioskDisplay },
  });
}

async function captureKiosk(outputPath) {
  const streamName = process.env.STREAM_NAME || 'kiosk1';
  const frameUrl = `${config.go2rtcUrl}/api/frame.jpeg?src=${streamName}`;
  await execAsync(`curl -sf "${frameUrl}" -o "${outputPath}"`);
}

async function captureBoth() {
  await ensureScreenshotDir();
  const stamp = Date.now();
  const desktopPath = path.join(config.screenshotDir, `desktop-${stamp}.png`);
  const kioskPath = path.join(config.screenshotDir, `kiosk-${stamp}.jpg`);

  const results = [];

  try {
    await captureDesktop(desktopPath);
    results.push({ screenType: 'desktop', filePath: desktopPath });
  } catch (err) {
    console.warn('[agent] Desktop capture failed:', err.message);
  }

  try {
    await captureKiosk(kioskPath);
    results.push({ screenType: 'kiosk', filePath: kioskPath });
  } catch (err) {
    console.warn('[agent] Kiosk capture failed:', err.message);
  }

  return results;
}

async function uploadScreenshot(screenType, filePath) {
  const token = await auth.ensureToken();
  const buffer = await fs.readFile(filePath);
  const form = new FormData();
  form.append('deviceId', config.deviceId);
  form.append('screenType', screenType);
  form.append('screenshot', buffer, {
    filename: path.basename(filePath),
    contentType: screenType === 'desktop' ? 'image/png' : 'image/jpeg',
  });

  await axios.post(`${config.apiUrl}/api/monitoring/devices/screenshot`, form, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...form.getHeaders(),
    },
    maxBodyLength: Infinity,
  });
}

async function captureAndUpload() {
  const captures = await captureBoth();
  const uploaded = [];

  for (const item of captures) {
    try {
      await uploadScreenshot(item.screenType, item.filePath);
      uploaded.push(item.screenType);
    } catch (err) {
      console.error(`[agent] Upload failed (${item.screenType}):`, err.message);
    } finally {
      await fs.unlink(item.filePath).catch(() => {});
    }
  }

  return uploaded;
}

module.exports = {
  captureAndUpload,
  captureBoth,
  uploadScreenshot,
};
