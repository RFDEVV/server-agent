// Only exact, pre-approved app names / actions are ever allowed to reach
// pm2 or the shell. Nothing from the request body is ever concatenated
// into a shell string — pm2 is driven through its programmatic API, and
// power actions map to one of two hardcoded commands, never user input.

const ALLOWED_PM2_APPS = (process.env.ALLOWED_PM2_APPS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOWED_PM2_ACTIONS = new Set(['start', 'stop', 'restart']);

function isAppAllowed(name) {
  return typeof name === 'string' && ALLOWED_PM2_APPS.includes(name);
}

function isActionAllowed(action) {
  return ALLOWED_PM2_ACTIONS.has(action);
}

module.exports = { ALLOWED_PM2_APPS, isAppAllowed, isActionAllowed };
