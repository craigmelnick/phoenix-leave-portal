const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/notifications', (req, res) => {
  const mine = db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC').all(req.user.id);
  db.prepare('UPDATE notifications SET read=1 WHERE user_id=? AND read=0').run(req.user.id);
  res.json({ notifications: mine.map((n) => ({ id: n.id, text: n.text, read: !!n.read, createdAt: n.created_at })) });
});

router.get('/notifications/unread-count', (req, res) => {
  const row = db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read=0').get(req.user.id);
  res.json({ count: row.c });
});

module.exports = router;
