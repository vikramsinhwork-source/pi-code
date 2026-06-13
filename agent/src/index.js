const config = require('./config');
const socket = require('./socket');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function main() {
  if (!config.deviceId) {
    console.error('DEVICE_ID is required (UUID from POST /api/devices — not a stream name)');
    process.exit(1);
  }
  if (!UUID_REGEX.test(config.deviceId)) {
    console.error(
      `DEVICE_ID must be a UUID provisioned in the backend (got "${config.deviceId}").`,
      'Create a RASPBERRY device via admin API/UI, then set DEVICE_ID to its id.'
    );
    process.exit(1);
  }
  if (!config.deviceTokenSecret) {
    console.error('DEVICE_TOKEN_SECRET is required (must match backend .env)');
    process.exit(1);
  }

  console.log('[agent] Starting railwatch-agent', config.agentVersion);
  console.log('[agent] API:', config.apiUrl);
  console.log('[agent] Device:', config.deviceId);

  await socket.connect();

  process.on('SIGINT', () => {
    console.log('[agent] Shutting down');
    socket.disconnect();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    socket.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[agent] Fatal error:', err);
  console.error(err?.response?.data);
  console.error(err?.stack);
  process.exit(1);
});
