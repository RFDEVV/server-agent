const jwt = require('jsonwebtoken');

// Step 1: the app logs in with the long-lived API_KEY (POST /auth/login)
// and gets back a short-lived JWT. Every other route requires that JWT.
// This keeps the raw API_KEY off the wire on every single request.

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ ok: false, error: 'Invalid API key' });
  }
  next();
}

function requireJwt(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: 'Missing token' });

  jwt.verify(token, process.env.JWT_SECRET, (err, payload) => {
    if (err) return res.status(401).json({ ok: false, error: 'Invalid or expired token' });
    req.tokenPayload = payload;
    next();
  });
}

// Same check, but for the socket.io handshake (token passed as auth.token)
function socketAuth(socket, next) {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error('unauthorized'));
  jwt.verify(token, process.env.JWT_SECRET, (err) => {
    if (err) return next(new Error('unauthorized'));
    next();
  });
}

module.exports = { requireApiKey, requireJwt, socketAuth };
