const { exec } = require('child_process');

// Presets are defined in .env as COMMAND_PRESETS, format:
//   name1::command1;;name2::command2
// e.g. COMMAND_PRESETS="Clear PM2 logs::pm2 flush;;Disk usage::df -h"
// The client only ever sends a preset NAME - the actual shell string lives
// only in .env on the server, so there's no way to inject arbitrary commands
// from the app even if the API key/JWT leaks.
function parsePresets() {
  const raw = process.env.COMMAND_PRESETS || '';
  return raw
    .split(';;')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, command] = entry.split('::').map((s) => s.trim());
      return { name, command };
    })
    .filter((p) => p.name && p.command);
}

function listPresets() {
  return parsePresets().map((p) => p.name);
}

function runPreset(name) {
  const preset = parsePresets().find((p) => p.name === name);
  if (!preset) throw new Error('Unknown preset');
  return new Promise((resolve, reject) => {
    exec(preset.command, { timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout.slice(0, 8000)); // cap response size
    });
  });
}

module.exports = { listPresets, runPreset };
