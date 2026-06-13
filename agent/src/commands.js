const { exec } = require('child_process');
const { promisify } = require('util');
const screenshot = require('./screenshot');
const updater = require('./updater');

const execAsync = promisify(exec);

function emitCommandResult(socket, payload, success, message) {
  if (!socket?.connected || !payload?.commandId) return;
  socket.emit('device:command-result', {
    commandId: payload.commandId,
    success,
    message: message || (success ? 'Command completed' : 'Command failed'),
    timestamp: new Date().toISOString(),
  });
}

async function runCommand(socket, payload, action, fn) {
  try {
    await fn();
    emitCommandResult(socket, payload, true, `${action} completed`);
  } catch (err) {
    console.error(`[agent] ${action} failed:`, err.message);
    emitCommandResult(socket, payload, false, err.message);
  }
}

function attach(socket) {
  socket.on('device:reboot', async (payload) => {
    console.log('[agent] Command: reboot', payload?.commandId);
    await runCommand(socket, payload, 'reboot', async () => {
      await execAsync('sudo reboot');
    });
  });

  socket.on('device:restart-go2rtc', async (payload) => {
    console.log('[agent] Command: restart-go2rtc', payload?.commandId);
    await runCommand(socket, payload, 'restart-go2rtc', async () => {
      await execAsync('sudo systemctl restart go2rtc || pm2 restart go2rtc');
    });
  });

  socket.on('device:restart-agent', async (payload) => {
    console.log('[agent] Command: restart-agent', payload?.commandId);
    await runCommand(socket, payload, 'restart-agent', async () => {
      await execAsync('pm2 restart railwatch-agent');
    });
  });

  socket.on('device:capture-screenshot', async (payload) => {
    console.log('[agent] Command: capture-screenshot', payload?.commandId);
    await runCommand(socket, payload, 'capture-screenshot', async () => {
      const uploaded = await screenshot.captureAndUpload();
      if (!uploaded.length) {
        throw new Error('No screenshots captured');
      }
    });
  });

  socket.on('device:update', async (payload) => {
    console.log('[agent] Command: update', payload?.commandId);
    await runCommand(socket, payload, 'update', async () => {
      await updater.runUpdate();
    });
  });
}

module.exports = { attach, emitCommandResult };
