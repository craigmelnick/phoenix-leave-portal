require('dotenv').config();
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const cron = require('node-cron');

const db = require('./db');
const { seed } = require('./seed');
const { attachUser } = require('./middleware/auth');
const { remainingDays, nowIso } = require('./helpers');

const authRoutes = require('./routes/auth');
const leaveRoutes = require('./routes/leave');
const approvalsRoutes = require('./routes/approvals');
const notificationsRoutes = require('./routes/notifications');
const calendarRoutes = require('./routes/calendar');
const adminRoutes = require('./routes/admin');
const escalationsRoutes = require('./routes/escalations');

// Make sure the real Phoenix roster / departments / holidays exist on first run.
// Safe to call every startup — it only inserts rows that aren't already there.
seed();

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(attachUser);

app.use('/api/auth', authRoutes);
app.use('/api', leaveRoutes);
app.use('/api', approvalsRoutes);
app.use('/api', notificationsRoutes);
app.use('/api', calendarRoutes);
app.use('/api', adminRoutes);
app.use('/api', escalationsRoutes);

// no-cache (not "don't cache" — "always revalidate with the server first") so that every
// deploy is reflected immediately for everyone, instead of browsers silently serving an old
// cached copy of app.js/styles.css until someone happens to hard-refresh.
app.use(
    express.static(path.join(__dirname, '..', 'public'), {
          etag: true,
          lastModified: true,
          setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
    })
  );
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Automatic leave-year rollover, 1 March each year at 00:05 server time: unused annual leave is
// forfeited (logged to the audit trail, one entry per employee), and used/pending reset to zero
// for the new leave year. This is the "no carry-over grace period" rule, enforced automatically
// so nobody has to remember to do it by hand.
cron.schedule('5 0 1 3 *', () => {
  console.log('Running automatic leave-year rollover...');
  const users = db.prepare('SELECT * FROM users WHERE active=1').all();
  users.forEach((u) => {
    const forfeited = remainingDays(u);
    if (forfeited > 0) {
      db.prepare('INSERT INTO audit_log (actor_id, actor_name, action, detail, at) VALUES (?, ?, ?, ?, ?)').run(
        null,
        'System',
        'leave_year_rollover',
        `${u.name} forfeited ${forfeited} unused day(s)`,
        nowIso()
      );
    }
    db.prepare('UPDATE users SET used=0, pending=0 WHERE id=?').run(u.id);
  });
  console.log(`Leave year rolled over for ${users.length} employees.`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Phoenix Leave Portal running on http://localhost:${PORT}`);
});
