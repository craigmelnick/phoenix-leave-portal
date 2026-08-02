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
  const user = db.prepare('SELECT * FROM users WHERE lower(email) = ? AND active = 1').get(email);
  if (!user) return res.status(400).json({ error: 'Incorrect code — please try again.' });

  const otp = db
    .prepare(
      `SELECT * FROM otp_codes WHERE user_id = ? AND code = ? AND used = 0 ORDER BY id DESC LIMIT 1`
    )
    .get(user.id, code);
  if (!otp || new Date(otp.expires_at) < new Date()) {
    return res.status(400).json({ error: 'Incorrect or expired code — please try again.' });
  }
  db.prepare('UPDATE otp_codes SET used = 1 WHERE id = ?').run(otp.id);

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

module.exports = router;
