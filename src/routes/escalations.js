const express = require('express');
const db = require('../db');
const { requireAuth, requireDirector } = require('../middleware/auth');
const { fmtDate, nowIso, getCeoId, businessDaysBetween, isValidCalendarDate } = require('../helpers');
const { pushNotification } = require('../notify');

const router = express.Router();
router.use(requireAuth);
// Employee asks the CEO for permission to book leave more than 6 months in advance — the normal
// submission flow blocks this outright, so this is the only way around it.
router.post('/leave-requests/escalate', (req, res) => {
    const user = req.user;
    const { type, start, end, reason } = req.body;
    const validTypes = ['Annual', 'Sick', 'Family Responsibility', 'Study Leave', 'Maternity', 'Paternity', 'Unpaid'];
    if (!validTypes.includes(type)) return res.status(400).json({ error: 'Invalid leave type.' });
    if (!isValidCalendarDate(start) || !isValidCalendarDate(end) || end < start) {
          return res.status(400).json({ error: "Please choose a valid start and end date (end date can't be before the start date)." });
    }
    const days = businessDaysBetween(start, end);
    const info = db
      .prepare(
              `INSERT INTO escalation_requests (employee_id, type, start_date, end_date, days, reason, status, requested_at)
                     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
            )
      .run(user.id, type, start, end, days, reason || '', nowIso());
    const escId = Number(info.lastInsertRowid);

              const ceoId = getCeoId();
    if (ceoId) {
          const dateRange = fmtDate(start) + (start !== end ? ' – ' + fmtDate(end) : '');
          pushNotification(
                  ceoId,
                  `${user.name} is asking to book ${days} day(s) of ${type} leave starting ${dateRange}, more than 6 months from today — this needs your approval before they can submit it.`
                );
    }

              db.prepare('INSERT INTO audit_log (actor_id, actor_name, action, detail, at) VALUES (?, ?, ?, ?, ?)').run(
                    user.id,
                    user.name,
                    'leave_escalation_requested',
                    `${type} leave, ${start} to ${end} (${days} day(s)) — more than 6 months in advance`,
                    nowIso()
                  );

              res.json({ ok: true, escalationId: escId });
});

// Employee's own escalation history, so they know when one is approved and their 24-hour
// window is running.
router.get('/leave-requests/escalations/mine', (req, res) => {
    const rows = db
      .prepare('SELECT * FROM escalation_requests WHERE employee_id=? ORDER BY id DESC')
      .all(req.user.id)
      .map((e) => {
              if (e.status === 'approved' && new Date(e.expires_at) < new Date()) {
                        db.prepare(`UPDATE escalation_requests SET status='expired' WHERE id=?`).run(e.id);
                        e.status = 'expired';
              }
              return e;
      });
    res.json({
          escalations: rows.map((e) => ({
                  id: e.id,
                  type: e.type,
                  start: e.start_date,
                  end: e.end_date,
                  days: e.days,
                  status: e.status,
                  expiresAt: e.expires_at,
          })),
    });
});

// CEO-only: review escalations awaiting a decision.
router.get('/escalations/pending', requireDirector, (req, res) => {
    const rows = db.prepare(`SELECT * FROM escalation_requests WHERE status='pending' ORDER BY id ASC`).all();
    const employees = db.prepare('SELECT id, name FROM users WHERE active=1').all();
    res.json({
          pending: rows.map((e) => ({
                  id: e.id,
                  employeeName: (employees.find((u) => u.id === e.employee_id) || {}).name || 'Unknown',
                  type: e.type,
                  start: e.start_date,
                  end: e.end_date,
                  days: e.days,
                  reason: e.reason,
          })),
    });
});

router.post('/escalations/:id/approve', requireDirector, (req, res) => handleDecision(req, res, 'approve'));
router.post('/escalations/:id/reject', requireDirector, (req, res) => handleDecision(req, res, 'reject'));

function handleDecision(req, res, action) {
    const esc = db.prepare('SELECT * FROM escalation_requests WHERE id=?').get(req.params.id);
    if (!esc) return res.status(404).json({ error: 'Escalation request not found.' });
    if (esc.status !== 'pending') return res.status(409).json({ error: 'This escalation has already been decided.' });

  const employee = db.prepare('SELECT * FROM users WHERE id=?').get(esc.employee_id);
    const dateRange = fmtDate(esc.start_date) + (esc.start_date !== esc.end_date ? ' – ' + fmtDate(esc.end_date) : '');

  if (action === 'reject') {
        db.prepare(`UPDATE escalation_requests SET status='rejected', decided_at=?, decided_by=? WHERE id=?`).run(
                nowIso(),
                req.user.id,
                esc.id
              );
        pushNotification(
                employee.id,
                `Your request to book ${esc.days} day(s) of ${esc.type} leave starting ${dateRange} (more than 6 months in advance) was declined by ${req.user.name}.`
              );
  } else {
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        db.prepare(`UPDATE escalation_requests SET status='approved', decided_at=?, decided_by=?, approved_at=?, expires_at=? WHERE id=?`).run(
                nowIso(),
                req.user.id,
                nowIso(),
                expiresAt,
                esc.id
              );
        pushNotification(
                employee.id,
                `${req.user.name} approved your request to book ${esc.days} day(s) of ${esc.type} leave starting ${dateRange}. You have 24 hours to submit the actual leave request before this approval expires.`
              );
  }

  db.prepare('INSERT INTO audit_log (actor_id, actor_name, action, detail, at) VALUES (?, ?, ?, ?, ?)').run(
        req.user.id,
        req.user.name,
        action === 'reject' ? 'leave_escalation_rejected' : 'leave_escalation_approved',
        `${esc.type} leave for ${employee.name}, ${esc.start_date} to ${esc.end_date}`,
        nowIso()
      );

  res.json({ ok: true, status: action === 'reject' ? 'rejected' : 'approved' });
}

module.exports = router;
