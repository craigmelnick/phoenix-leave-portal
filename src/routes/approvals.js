const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { isAwaitingApproval, stage2Pool, fmtDate, statusLabel, nowIso } = require('../helpers');
const { notifyOnApproval, notifyApprovalNeeded } = require('../notify');

const router = express.Router();
router.use(requireAuth);

router.get('/approvals/pending', (req, res) => {
  const allUsers = db.prepare('SELECT * FROM users WHERE active=1').all();
  const pending = db
    .prepare(`SELECT * FROM leave_requests WHERE status LIKE 'pending%'`)
    .all()
    .filter((r) => {
      const employee = allUsers.find((u) => u.id === r.employee_id);
      return employee && isAwaitingApproval(r, req.user.id, employee);
    })
    .map((r) => {
      const employee = allUsers.find((u) => u.id === r.employee_id);
      return {
        id: r.id,
        employeeName: employee.name,
        type: r.type,
        start: r.start_date,
        end: r.end_date,
        days: r.days,
        reason: r.reason,
      };
    });
  res.json({ pending });
});

router.post('/leave-requests/:id/approve', (req, res) => handleDecision(req, res, 'approve'));
router.post('/leave-requests/:id/reject', (req, res) => handleDecision(req, res, 'reject'));

function handleDecision(req, res, action) {
  const r = db.prepare('SELECT * FROM leave_requests WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Request not found.' });
  const employee = db.prepare('SELECT * FROM users WHERE id=?').get(r.employee_id);
  if (!['pending_1', 'pending_2'].includes(r.status)) {
    return res.status(409).json({ error: 'This request has already been decided.' });
  }
  if (!isAwaitingApproval(r, req.user.id, employee)) {
    return res.status(403).json({ error: 'This request is not awaiting your decision.' });
  }

  const approver = req.user;
  const today = fmtDate(new Date().toISOString().slice(0, 10));

  if (action === 'reject') {
    db.prepare(`UPDATE leave_requests SET status='rejected' WHERE id=?`).run(r.id);
    db.prepare('UPDATE users SET pending = pending - ? WHERE id=?').run(r.days, employee.id);
    db.prepare(`INSERT INTO approval_trail (request_id, by_user_id, by_name, action, at) VALUES (?, ?, ?, 'rejected', ?)`).run(
      r.id,
      approver.id,
      approver.name,
      nowIso()
    );
    db.prepare('INSERT INTO audit_log (actor_id, actor_name, action, detail, at) VALUES (?, ?, ?, ?, ?)').run(
      approver.id,
      approver.name,
      'leave_request_rejected',
      `Request #${r.id} for ${employee.name}`,
      nowIso()
    );
    return res.json({ ok: true, status: 'rejected' });
  }

  // approve
  if (r.status === 'pending_1') {
    db.prepare(`UPDATE leave_requests SET status='pending_2' WHERE id=?`).run(r.id);
    db.prepare(`INSERT INTO approval_trail (request_id, by_user_id, by_name, action, at) VALUES (?, ?, ?, 'approved (step 1)', ?)`).run(
      r.id,
      approver.id,
      approver.name,
      nowIso()
    );
    db.prepare('INSERT INTO audit_log (actor_id, actor_name, action, detail, at) VALUES (?, ?, ?, ?, ?)').run(
      approver.id,
      approver.name,
      'leave_request_step1_approved',
      `Request #${r.id} for ${employee.name}`,
      nowIso()
    );
    stage2Pool(employee).forEach((id) => notifyApprovalNeeded(r, employee, id));
    return res.json({ ok: true, status: 'pending_2' });
  }

  if (r.status === 'pending_2') {
    db.prepare(`UPDATE leave_requests SET status='approved' WHERE id=?`).run(r.id);
    db.prepare('UPDATE users SET pending = pending - ?, used = used + ? WHERE id=?').run(r.days, r.days, employee.id);
    db.prepare(`INSERT INTO approval_trail (request_id, by_user_id, by_name, action, at) VALUES (?, ?, ?, 'approved (step 2)', ?)`).run(
      r.id,
      approver.id,
      approver.name,
      nowIso()
    );
    db.prepare('INSERT INTO audit_log (actor_id, actor_name, action, detail, at) VALUES (?, ?, ?, ?, ?)').run(
      approver.id,
      approver.name,
      'leave_request_approved',
      `Request #${r.id} for ${employee.name}`,
      nowIso()
    );
    const freshReq = db.prepare('SELECT * FROM leave_requests WHERE id=?').get(r.id);
    const freshEmployee = db.prepare('SELECT * FROM users WHERE id=?').get(employee.id);
    notifyOnApproval(freshReq, freshEmployee);
    return res.json({ ok: true, status: 'approved' });
  }
}

module.exports = router;
