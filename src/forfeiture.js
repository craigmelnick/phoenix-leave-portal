// Automated year-end forfeiture reminder. The Phoenix leave year runs 1 March to the last day of
// February, and unused annual leave does NOT carry over — anything still unused on 28/29 February
// is forfeited automatically (see the rollover cron in server.js). Waiting until the day it's lost
// to tell someone would be useless, so this instead nudges anyone with an unused balance during
// January and February — the two-month run-up to the deadline — while there's still time to
// actually book something.
//
// Sent once per employee per leave year, not once a day: each reminder is recorded on the user's
// own row (forfeiture_reminder_sent_at), and that same rollover cron resets it back to NULL for
// everyone on 1 March, so the cycle starts clean for the next leave year instead of the flag
// staying permanently "already sent" forever.

const db = require('./db');
const { LEAVE_YEAR, remainingDays, fmtDate, nowIso } = require('./helpers');
const { sendNotificationEmail } = require('./email');

// January or February — the run-up to the 28/29 February forfeiture deadline.
function isForfeitureWindow(asOf) {
  const d = asOf ? new Date(asOf) : new Date();
  return d.getMonth() === 0 || d.getMonth() === 1;
}

// Checks every active employee and, for anyone with an unused annual leave balance who hasn't
// already been reminded this leave year, sends a one-off email and marks them so the same
// reminder doesn't go out again tomorrow. A no-op outside January/February. Safe to call as
// often as you like (e.g. once a day from the cron in server.js) — idempotent by design.
function sendForfeitureReminders(asOf) {
  if (!isForfeitureWindow(asOf)) return { sent: 0, window: false };
  const deadline = fmtDate(LEAVE_YEAR.end);
  const candidates = db.prepare('SELECT * FROM users WHERE active=1 AND forfeiture_reminder_sent_at IS NULL').all();
  let sent = 0;
  candidates.forEach((u) => {
    const balance = remainingDays(u);
    if (balance <= 0) return;

    // Mark first (not after the email resolves) so an overlapping/duplicate run of this same
    // check can never double-send the same person — matches the "in-app record always happens,
    // email delivery is best-effort" pattern used everywhere else notifications are sent.
    db.prepare('UPDATE users SET forfeiture_reminder_sent_at=? WHERE id=?').run(nowIso(), u.id);
    sent++;

    const firstName = u.name.split(' ')[0];
    const subject = 'Reminder: unused annual leave will be forfeited';
    const text = `Hi ${firstName}, a friendly reminder that you currently have ${balance} day(s) of annual leave left for this leave year. Phoenix's leave year does not carry over — any balance still unused on ${deadline} will be forfeited. If you'd like to use some of it, head into the Leave Portal and submit a request.`;

    sendNotificationEmail(u.email, subject, text).catch((e) => {
      console.error('Forfeiture reminder email failed:', e.message);
      try {
        db.prepare('INSERT INTO audit_log (actor_id, actor_name, action, detail, at) VALUES (?, ?, ?, ?, ?)').run(
          null,
          'System',
          'notification_email_failed',
          `Forfeiture reminder to ${u.name} (${u.email}) could not be sent: ${e.message}`,
          nowIso()
        );
      } catch (_) { /* best effort - never let logging break the check */ }
    });

    try {
      db.prepare('INSERT INTO audit_log (actor_id, actor_name, action, detail, at) VALUES (?, ?, ?, ?, ?)').run(
        null,
        'System',
        'forfeiture_reminder_sent',
        `Reminded ${u.name} (${u.email}) about ${balance} unused day(s) of annual leave — forfeited on ${deadline} if unused.`,
        nowIso()
      );
    } catch (_) { /* best effort */ }
  });
  return { sent, window: true };
}

module.exports = { sendForfeitureReminders, isForfeitureWindow };
