const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { nowIso } = require('../helpers');
const { sendOtpEmail } = require('../email');
const { createSession, destroySession, SESSION_COOKIE } = require('../middleware/auth');
const { isApproverForSomeone } = require('../helpers');

const router = express.Router();

const OTP_MINUTES = 10;
const isProd = process.env.NODE_ENV === 'production';

// In-memory brute-force protection for the OTP login flow. A 4-digit code only has 9000
// possible values, so without this an attacker who knows (or guesses) someone's work email
// could script their way through every combination well inside the 10-minute expiry window
// and log in as them. Keyed by email rather than IP so a rotating IP doesn't help an attacker,
// and reset on every successful login so it never punishes the legitimate owner long-term.
// This resets on a server restart, which is an acceptable tradeoff for a company this size —
// swap for a DB-backed table if the app ever needs to survive that too.
const MAX_VERIFY_ATTEMPTS = 5;
const VERIFY_LOCKOUT_MS = 15 * 60 * 1000;
const verifyAttempts = new Map(); // email -> { count, lockedUntil }

// Separate, looser limit on *requesting* codes, so a script can't repeatedly trigger emails
// (or repeatedly hammer the lookup) against one address.
const MAX_OTP_REQUESTS = 5;
const REQUEST_WINDOW_MS = 10 * 60 * 1000;
const requestAttempts = new Map(); // email -> { count, windowStart }

function minutesLeft(untilMs) {
  return Math.max(1, Math.ceil((untilMs - Date.now()) / 60000));
}

function publicUser(u) {
  const allUsers = db.prepare('SELECT id, approver1, approver2, approver3 FROM users WHERE active=1').all();
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    deptId: u.dept_id,
    role: u.role,
    title: u.title,
    isApprover: isApproverForSomeone(u.id, allUsers),
  };
}

// Step 1: request a one-time code by email.
router.post('/request-otp', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  const now = Date.now();
  const reqEntry = requestAttempts.get(email);
  if (reqEntry && now - reqEntry.windowStart < REQUEST_WINDOW_MS) {
    if (reqEntry.count >= MAX_OTP_REQUESTS) {
      return res.status(429).json({ error: `Too many code requests for this address. Please try again in ${minutesLeft(reqEntry.windowStart + REQUEST_WINDOW_MS)} minute(s).` });
    }
    reqEntry.count += 1;
  } else {
    requestAttempts.set(email, { count: 1, windowStart: now });
  }

  const user = db.prepare('SELECT * FROM users WHERE lower(email) = ? AND active = 1').get(email);
  if (!user) {
    // Don't reveal whether the email exists — generic response either way.
    return res.json({ ok: true });
  }
  const code = String(crypto.randomInt(1000, 10000));
  const expiresAt = new Date(Date.now() + OTP_MINUTES * 60 * 1000).toISOString();
  db.prepare('INSERT INTO otp_codes (user_id, code, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)').run(
    user.id,
    code,
    expiresAt,
    nowIso()
  );
  try {
    const result = await sendOtpEmail(user.email, code);
    return res.json({ ok: true, devCode: result.devMode && !isProd ? code : undefined });
  } catch (err) {
    console.error('Failed to send OTP email:', err.message);
    return res.status(500).json({ error: 'Could not send the login email. Please try again shortly.' });
  }
});

// Step 2: verify the code and start a session.
router.post('/verify-otp', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim();

  const now = Date.now();
  const attempt = verifyAttempts.get(email);
  if (attempt && attempt.lockedUntil && attempt.lockedUntil > now) {
    return res.status(429).json({ error: `Too many incorrect attempts. Please try again in ${minutesLeft(attempt.lockedUntil)} minute(s), or request a fresh code.` });
  }

  const user = db.prepare('SELECT * FROM users WHERE lower(email) = ? AND active = 1').get(email);

  function recordFailure() {
    const current = verifyAttempts.get(email) || { count: 0, lockedUntil: 0 };
    current.count += 1;
    if (current.count >= MAX_VERIFY_ATTEMPTS) {
      current.lockedUntil = Date.now() + VERIFY_LOCKOUT_MS;
      current.count = 0;
    }
    verifyAttempts.set(email, current);
  }

  if (!user) {
    recordFailure();
    return res.status(400).json({ error: 'Incorrect code — please try again.' });
  }

  const otp = db
    .prepare(
      `SELECT * FROM otp_codes WHERE user_id = ? AND code = ? AND used = 0 ORDER BY id DESC LIMIT 1`
    )
    .get(user.id, code);
  if (!otp || new Date(otp.expires_at) < new Date()) {
    recordFailure();
    return res.status(400).json({ error: 'Incorrect or expired code — please try again.' });
  }
  db.prepare('UPDATE otp_codes SET used = 1 WHERE id = ?').run(otp.id);
  verifyAttempts.delete(email);
  requestAttempts.delete(email);

  const { token, expiresAt } = createSession(user.id);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    expires: new Date(expiresAt),
  });
  db.prepare('INSERT INTO audit_log (actor_id, actor_name, action, detail, at) VALUES (?, ?, ?, ?, ?)').run(
    user.id,
    user.name,
    'login',
    'Signed in via email OTP',
    nowIso()
  );
  res.json({ ok: true, user: publicUser(user) });
});

router.post('/logout', (req, res) => {
  const token = req.cookies && req.cookies[SESSION_COOKIE];
  if (token) destroySession(token);
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
  res.json({ user: publicUser(req.user) });
});


// Public roster for the sign-in dropdown — names and emails only, no leave data, so it's
// safe to expose before anyone has signed in.
router.get('/roster', (req, res) => {
    const users = db.prepare('SELECT id, name, email FROM users WHERE active=1 ORDER BY name').all();
    res.json({ users });
});
module.exports = router;
