const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const {
  LEAVE_YEAR,
  isValidCalendarDate,
  businessDaysBetween,
  remainingDays,
  accruedDays,
  advanceWindowCutoff,
  isBeyondAdvanceWindow,
  remainingDaysAsOf,
  remainingDaysAdvance,
  advanceDaysTaken,
  stage2Pool,
  isAwaitingApproval,
  overlappingColleagues,
  fmtDate,
  statusLabel,
  nowIso,
} = require('../helpers');
const { notifyOnApproval, notifyApprovalNeeded } = require('../notify');

const router = express.Router();
router.use(requireAuth);

function typeUsedPending(userId, type) {
  const used = db
    .prepare(`SELECT COALESCE(SUM(days),0) s FROM leave_requests WHERE employee_id=? AND type=? AND status='approved'`)
    .get(userId, type).s;
  const pending = db
    .prepare(`SELECT COALESCE(SUM(days),0) s FROM leave_requests WHERE employee_id=? AND type=? AND status LIKE 'pending%'`)
    .get(userId, type).s;
  return { used, pending };
}

// Balance for whichever leave type is actually being requested - Annual uses the accrual-based
// entitlement on the user row (optionally projected forward to a future date), Sick and Family
// Responsibility have their own fixed yearly pools, everything else (Study/Maternity/Paternity/
// Unpaid) has no capped balance today.
function balanceForType(user, type, asOfStart) {
  if (type === 'Annual') {
    return { entitlement: user.entitlement, used: user.used, pending: user.pending, available: remainingDaysAsOf(user, asOfStart) };
  }
  if (type === 'Sick') {
    const tp = typeUsedPending(user.id, 'Sick');
    return { entitlement: 10, used: tp.used, pending: tp.pending, available: Math.max(0, 10 - tp.used - tp.pending) };
  }
  if (type === 'Family Responsibility') {
    const tp = typeUsedPending(user.id, 'Family Responsibility');
    return { entitlement: 3, used: tp.used, pending: tp.pending, available: Math.max(0, 3 - tp.used - tp.pending) };
  }
  return { entitlement: null, used: 0, pending: 0, available: Infinity };
}

router.get('/dashboard', (req, res) => {
  const user = req.user;
  const today = new Date();
  const myPending = db.prepare(`SELECT * FROM leave_requests WHERE employee_id=? AND status LIKE 'pending%'`).all(user.id);
  const upcoming = db
    .prepare(`SELECT * FROM leave_requests WHERE employee_id=? AND status='approved' AND start_date >= ? ORDER BY start_date ASC`)
    .all(user.id, today.toISOString().slice(0, 10));

  const allUsers = db.prepare('SELECT * FROM users WHERE active=1').all();
  const myPendingApprovals = db
    .prepare(`SELECT * FROM leave_requests WHERE status LIKE 'pending%'`)
    .all()
    .filter((r) => {
      const employee = allUsers.find((u) => u.id === r.employee_id);
      return employee && isAwaitingApproval(r, user.id, employee);
    });

  let heroLine;
  if (myPendingApprovals.length > 0 && myPending.length > 0) {
    heroLine = `You have ${myPendingApprovals.length} request(s) waiting on your approval, and ${myPending.length} of your own awaiting a decision.`;
  } else if (myPendingApprovals.length > 0) {
    heroLine = `You have ${myPendingApprovals.length} request(s) waiting on your approval.`;
  } else if (myPending.length > 0) {
    heroLine = `You have ${myPending.length} request(s) awaiting a decision.`;
  } else {
    heroLine = 'Your leave position and the decisions needing attention are up to date.';
  }

  const sick = typeUsedPending(user.id, 'Sick');
  const fam = typeUsedPending(user.id, 'Family Responsibility');

  const noticeboard = db.prepare(`SELECT value FROM settings WHERE key='noticeboard'`).get();
  const isYearEndWindow = today.getMonth() === 0 || today.getMonth() === 1;

  // Annual leave's headline "available" figure includes the advance-booking window (everyone
  // automatically qualifies for it - 6 months ahead in March, growing to the full leave year by
  // September), not just what's strictly accrued as of today. "accrued" stays literal, and
  // advanceEligible/advanceWindowEnd let the UI explain the gap between the two.
  const advanceAvailable = remainingDaysAdvance(user);
  const trueAvailable = remainingDays(user);

  res.json({
    firstName: user.name.split(' ')[0],
    heroLine,
    balances: {
      annual: {
        label: 'Annual leave',
        entitlement: user.entitlement,
        accrued: accruedDays(user),
        used: user.used,
        pending: user.pending,
        available: advanceAvailable,
        advanceTaken: advanceDaysTaken(user),
        advanceEligible: Math.max(0, Math.round((advanceAvailable - trueAvailable) * 100) / 100),
        advanceWindowEnd: advanceWindowCutoff(),
      },
      sick: { label: 'Sick leave', entitlement: 10, used: sick.used, pending: sick.pending, available: Math.max(0, 10 - sick.used - sick.pending) },
      family: { label: 'Family responsibility', entitlement: 3, used: fam.used, pending: fam.pending, available: Math.max(0, 3 - fam.used - fam.pending) },
    },
    leaveYear: LEAVE_YEAR,
    yearEndReminder: isYearEndWindow && remainingDays(user) > 0 ? remainingDays(user) : null,
    noticeboard: noticeboard ? noticeboard.value : '',
    upcoming: upcoming.map((r) => ({ id: r.id, type: r.type, start: r.start_date, end: r.end_date, days: r.days })),
  });
});

router.post('/noticeboard', (req, res) => {
  if (req.user.role !== 'director') return res.status(403).json({ error: 'Only the CEO can update the noticeboard.' });
  const message = String(req.body.message || '').slice(0, 2000);
  db.prepare(`INSERT INTO settings (key, value) VALUES ('noticeboard', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(message);
  res.json({ ok: true, message });
});

router.get('/leave-requests/mine', (req, res) => {
  const mine = db.prepare('SELECT * FROM leave_requests WHERE employee_id=? ORDER BY start_date DESC').all(req.user.id);
  const out = mine.map((r) => {
    const trail = db.prepare('SELECT * FROM approval_trail WHERE request_id=? ORDER BY id ASC').all(r.id);
    return {
      id: r.id,
      type: r.type,
      start: r.start_date,
      end: r.end_date,
      days: r.days,
      reason: r.reason,
      doc: r.doc_filename,
      status: r.status,
      statusLabel: statusLabel(r.status),
      trail: trail.map((t) => `${t.by_name} ${t.action}`),
    };
  });
  res.json({ requests: out });
});

// Live preview while filling out the request form - days, approval route, conflicts, balance check.
router.get('/leave-requests/preview', (req, res) => {
  const user = req.user;
  const { start, end, type } = req.query;
  if (!isValidCalendarDate(start) || !isValidCalendarDate(end) || end <= start) {
    return res.json({ valid: false, message: "Please choose a valid start date and return-to-work date (the return date must be after the start date)." });
  }
  const days = businessDaysBetween(start, end);
  const overlap = user.dept_id ? overlappingColleagues(user.dept_id, start, end, user.id) : [];
  const allUsers = db.prepare('SELECT * FROM users WHERE active=1').all();
  const flow = user.approver1
    ? `${allUsers.find((u) => u.id === user.approver1).name} -> ${stage2Pool(user)
        .map((id) => allUsers.find((u) => u.id === id).name)
        .join(' or ')} -> CEO notified`
    : 'Self-approved (CEO)';
  const overlapNames = overlap.map((r) => allUsers.find((u) => u.id === r.employee_id).name);

  // Leave starting more than the advance window from now needs the CEO to approve an escalation
  // first - the normal accrual projection below doesn't apply until that's granted.
  const beyondWindow = isBeyondAdvanceWindow(start);
  const bal = balanceForType(user, type, beyondWindow ? undefined : start);
  res.json({
    valid: true,
    days,
    flow,
    needsEscalation: beyondWindow,
    exceedsBalance: !beyondWindow && bal.available !== Infinity && days > bal.available,
    available: bal.available === Infinity ? null : bal.available,
    accrued: type === 'Annual' ? accruedDays(user, beyondWindow ? undefined : start) : bal.entitlement,
    entitlement: bal.entitlement,
    blocked: overlap.length > 0,
    overlapNames,
  });
});

router.post('/leave-requests', (req, res) => {
  const user = req.user;
  const { type, start, end, reason, escalationId } = req.body;
  if (!isValidCalendarDate(start) || !isValidCalendarDate(end) || end <= start) {
    return res.status(400).json({ error: "Please choose a valid start date and return-to-work date (the return date must be after the start date)." });
  }
  const validTypes = ['Annual', 'Sick', 'Family Responsibility', 'Study Leave', 'Maternity', 'Paternity', 'Unpaid'];
  if (!validTypes.includes(type)) return res.status(400).json({ error: 'Invalid leave type.' });

  const overlap = user.dept_id ? overlappingColleagues(user.dept_id, start, end, user.id) : [];
  if (overlap.length > 0) {
    const allUsers = db.prepare('SELECT * FROM users WHERE active=1').all();
    const names = overlap.map((r) => allUsers.find((u) => u.id === r.employee_id).name).join(', ');
    return res.status(409).json({
      error: `This request can't be submitted: ${names} already has leave during this period, and only one person per department may be off at a time.`,
    });
  }

  const days = businessDaysBetween(start, end);
  // Leave starting more than the advance window from now needs a CEO-approved escalation first -
  // the employee can't just submit it through the normal flow.
  let usedEscalation = null;
  if (isBeyondAdvanceWindow(start)) {
    if (!escalationId) {
      return res.status(409).json({
        needsEscalation: true,
        error: `This request starts beyond the normal advance-booking window. You'll need to escalate this to the CEO for approval before you can submit it.`,
      });
    }
    const esc = db.prepare('SELECT * FROM escalation_requests WHERE id=? AND employee_id=?').get(escalationId, user.id);
    if (!esc || esc.status !== 'approved') {
      return res.status(409).json({ error: 'That escalation has not been approved by the CEO, or no longer exists.' });
    }
    if (new Date(esc.expires_at) < new Date()) {
      db.prepare(`UPDATE escalation_requests SET status='expired' WHERE id=?`).run(esc.id);
      return res.status(409).json({ error: 'Your 24-hour window to submit this escalated request has expired. Please ask the CEO to escalate again.' });
    }
    if (esc.type !== type || esc.start_date !== start || esc.end_date !== end) {
      return res.status(409).json({ error: 'This request must exactly match what was escalated and approved (type and dates).' });
    }
    usedEscalation = esc;
  } else if (days > 0) {
    const bal = balanceForType(user, type, start);
    if (bal.available !== Infinity && days > bal.available) {
      return res.status(409).json({
        error: `This request exceeds your available ${type} balance. You have ${bal.available} day(s) available${bal.entitlement != null ? ` (${bal.used} used, ${bal.pending} pending, of ${bal.entitlement} entitled)` : ''}.`,
      });
    }
  }
  const status = user.approver1 ? 'pending_1' : 'approved';

  const info = db
    .prepare(
      `INSERT INTO leave_requests (employee_id, dept_id, type, start_date, end_date, days, reason, status, created_at, escalation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(user.id, user.dept_id, type, start, end, days, reason || '', status, nowIso(), usedEscalation ? usedEscalation.id : null);
  const reqId = Number(info.lastInsertRowid);

  if (usedEscalation) {
    db.prepare(`UPDATE escalation_requests SET status='used' WHERE id=?`).run(usedEscalation.id);
  }

  db.prepare(`INSERT INTO approval_trail (request_id, by_user_id, by_name, action, at) VALUES (?, ?, ?, ?, ?)`).run(
    reqId,
    null,
    'System',
    'submitted',
    nowIso()
  );

  if (status === 'approved') {
    db.prepare('UPDATE users SET used = used + ? WHERE id = ?').run(days, user.id);
    db.prepare(`INSERT INTO approval_trail (request_id, by_user_id, by_name, action, at) VALUES (?, ?, ?, ?, ?)`).run(
      reqId,
      user.id,
      user.name,
      'approved (self, CEO)',
      nowIso()
    );
    const freshReq = db.prepare('SELECT * FROM leave_requests WHERE id=?').get(reqId);
    notifyOnApproval(freshReq, user);
  } else {
    db.prepare('UPDATE users SET pending = pending + ? WHERE id = ?').run(days, user.id);
    const freshReq = db.prepare('SELECT * FROM leave_requests WHERE id=?').get(reqId);
    notifyApprovalNeeded(freshReq, user, user.approver1);
  }

  db.prepare('INSERT INTO audit_log (actor_id, actor_name, action, detail, at) VALUES (?, ?, ?, ?, ?)').run(
    user.id,
    user.name,
    'leave_request_submitted',
    `${type} leave, ${start} to ${end} (${days} day(s))${usedEscalation ? ' - via approved escalation' : ''}`,
    nowIso()
  );

  res.json({ ok: true, id: reqId, days, status });
});

// Employee withdraws their own request, even if already (partially) approved. Any days already
// counted as used or pending are added back to their balance.
router.post('/leave-requests/:id/cancel', (req, res) => {
  const r = db.prepare('SELECT * FROM leave_requests WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Request not found.' });
  if (r.employee_id !== req.user.id) return res.status(403).json({ error: 'You can only cancel your own requests.' });
  if (!['pending_1', 'pending_2', 'approved'].includes(r.status)) {
    return res.status(409).json({ error: 'This request can no longer be cancelled.' });
  }
  const wasApproved = r.status === 'approved';
  db.prepare(`UPDATE leave_requests SET status='cancelled' WHERE id=?`).run(r.id);
  if (wasApproved) db.prepare('UPDATE users SET used = used - ? WHERE id=?').run(r.days, req.user.id);
  else db.prepare('UPDATE users SET pending = pending - ? WHERE id=?').run(r.days, req.user.id);
  db.prepare(`INSERT INTO approval_trail (request_id, by_user_id, by_name, action, at) VALUES (?, ?, ?, 'cancelled by employee', ?)`).run(
    r.id,
    req.user.id,
    req.user.name,
    nowIso()
  );
  db.prepare('INSERT INTO audit_log (actor_id, actor_name, action, detail, at) VALUES (?, ?, ?, ?, ?)').run(
    req.user.id,
    req.user.name,
    'leave_request_cancelled',
    `Request #${r.id} cancelled by employee (${r.days} day(s) ${r.type})`,
    nowIso()
  );
  res.json({ ok: true, status: 'cancelled' });
});

router.get('/leave-requests/:id/certificate', (req, res) => {
  const r = db.prepare('SELECT * FROM leave_requests WHERE id=?').get(req.params.id);
  if (!r || r.status !== 'approved') return res.status(404).json({ error: 'Certificate not available for this request.' });
  const employee = db.prepare('SELECT * FROM users WHERE id=?').get(r.employee_id);
  if (req.user.id !== employee.id && req.user.role !== 'director') {
    return res.status(403).json({ error: 'Not authorised to view this certificate.' });
  }
  const dept = r.dept_id ? db.prepare('SELECT * FROM departments WHERE id=?').get(r.dept_id) : null;
  const trail = db.prepare('SELECT * FROM approval_trail WHERE request_id=?').all(r.id);
  const approvals = trail.filter((t) => t.action.indexOf('approved') === 0).map((t) => t.by_name);
  res.json({
    refNo: 'PHX-' + String(r.id).padStart(5, '0'),
    issuedDate: fmtDate(new Date().toISOString().slice(0, 10)),
    employeeName: employee.name,
    department: dept ? dept.name : '-',
    type: r.type,
    dateRange: fmtDate(r.start_date) + (r.start_date !== r.end_date ? ' - ' + fmtDate(r.end_date) : ''),
    days: r.days,
    approvedBy: approvals.length ? approvals.join(', ') : 'Auto-approved',
    remainingBalance: remainingDays(employee),
    entitlement: employee.entitlement,
    leaveYear: LEAVE_YEAR,
  });
});

module.exports = router;
