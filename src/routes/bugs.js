// Lets any signed-in employee flag a problem with the app directly to the CEO, without needing
// to know his email address or leave the portal. Goes to every director-role account (today just
// Craig) both as an in-app notification and by email (pushNotification does both), and is logged
// to the audit trail so there's a permanent record even if the email happens to bounce.

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { nowIso } = require('../helpers');
const { pushNotification } = require('../notify');

const router = express.Router();
router.use(requireAuth);

router.post('/bugs/report', (req, res) => {
  const description = String(req.body.description || '').trim().slice(0, 2000);
  if (!description) return res.status(400).json({ error: 'Please describe the issue before sending.' });
  const page = req.body.page ? String(req.body.page).slice(0, 50) : null;

  const text = `Bug report from ${req.user.name}${page ? ` (on the "${page}" page)` : ''}: ${description}`;

  const directors = db.prepare("SELECT id FROM users WHERE role='director' AND active=1").all();
  directors.forEach((d) => pushNotification(d.id, text));

  db.prepare('INSERT INTO audit_log (actor_id, actor_name, action, detail, at) VALUES (?, ?, ?, ?, ?)').run(
    req.user.id,
    req.user.name,
    'bug_reported',
    text,
    nowIso()
  );

  res.json({ ok: true });
});

module.exports = router;
