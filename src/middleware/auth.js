const crypto = require('crypto');
const db = require('../db');

const SESSION_COOKIE = 'phx_session';
const SESSION_DAYS = 14;

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);
  return { token, expiresAt };
}

function destroySession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// Attaches req.user if a valid, unexpired session cookie is present. Does not block the request —
// individual routes decide whether they require a logged-in user.
function attachUser(req, res, next) {
  const token = req.cookies && req.cookies[SESSION_COOKIE];
  if (!token) return next();
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return next();
  if (new Date(session.expires_at) < new Date()) {
    destroySession(token);
    return next();
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(session.user_id);
  if (user) req.user = user;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
  next();
}

function requireDirector(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
  if (req.user.role !== 'director') return res.status(403).json({ error: 'Only the CEO can do this.' });
  next();
}

// Director or manager — used for the handful of things (like viewing, not editing, individual
// leave balances) that department managers now also need, without opening up the full CEO-only
// admin surface (approver assignments, roles, employee records, cancelling anyone's leave).
function requireManagement(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
  if (req.user.role !== 'director' && req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Only the CEO or a manager can do this.' });
  }
  next();
}

module.exports = { SESSION_COOKIE, createSession, destroySession, attachUser, requireAuth, requireDirector, requireManagement };
