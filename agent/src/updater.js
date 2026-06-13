const { exec } = require('child_process');
const { promisify } = require('util');
const config = require('./config');

const execAsync = promisify(exec);

async function runUpdate() {
  const repoPath = config.repoPath;
  console.log('[agent] Running update in', repoPath);

  const steps = [
    `cd "${repoPath}" && git pull`,
    `cd "${repoPath}/agent" && npm install --production`,
    'pm2 restart railwatch-agent',
  ];

  for (const cmd of steps) {
    console.log('[agent] Executing:', cmd);
    const { stdout, stderr } = await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024 });
    if (stdout) console.log(stdout.trim());
    if (stderr) console.warn(stderr.trim());
  }

  console.log('[agent] Update completed');
}

module.exports = { runUpdate };
