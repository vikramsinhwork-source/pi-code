const config = require('./config');
const socket = require('./socket');

async function main() {
  if (!config.deviceId) {
    console.error('DEVICE_ID is required');
    process.exit(1);
  }
  if (!config.deviceTokenSecret) {
    console.error('DEVICE_TOKEN_SECRET is required');
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
