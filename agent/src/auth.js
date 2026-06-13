const axios = require('axios');
const config = require('./config');

let cachedToken = null;
let tokenExpiresAt = 0;

async function fetchDeviceToken() {
  if (!config.deviceId) {
    throw new Error('DEVICE_ID is required');
  }
  if (!config.deviceTokenSecret) {
    throw new Error('DEVICE_TOKEN_SECRET is required');
  }

  const response = await axios.post(`${config.apiUrl}/api/auth/device-token`, {
    deviceId: config.deviceId,
    role: 'KIOSK',
    secret: config.deviceTokenSecret,
  });

  if (!response.data?.success && !response.data?.token) {
    throw new Error(response.data?.error || 'Failed to obtain device token');
  }

  const token = response.data.token || response.data.accessToken;
  cachedToken = token;
  tokenExpiresAt = Date.now() + (23 * 60 * 60 * 1000);
  return token;
}

function getToken() {
  return cachedToken;
}

function isTokenExpiringSoon() {
  return !cachedToken || Date.now() >= tokenExpiresAt - config.tokenRefreshMarginMs;
}

async function ensureToken() {
  if (isTokenExpiringSoon()) {
    return fetchDeviceToken();
  }
  return cachedToken;
}

function clearToken() {
  cachedToken = null;
  tokenExpiresAt = 0;
}

module.exports = {
  fetchDeviceToken,
  ensureToken,
  getToken,
  isTokenExpiringSoon,
  clearToken,
};
