const express = require('express');
const db = require('../db');
const { requireAuth, requireDirector, requireManagement } = require('../middleware/auth');
const { remainingDays, remainingDaysAdvance, accruedDays, roundHalf, nowIso, statusLabel, fmtDate } = require('../helpers');
const { pushNotification } = require('../notify');

const router = express.Router();
router.use(requireAuth);

// ---- Approver assignments - CEO-only, both to view and to edit ----
router.get('/admin/approvers', requireDirector, (req, res) => {
  const users = db.prepare(`SELECT * FROM users WHERE id != ? AND active=1 ORDER BY name`).all(req.user.id);
  const allUsers = db.prepare('SELECT id, name FROM users WHERE active=1 ORDER BY name').all();
  res.json({
    options: allUsers,
    employees: users.map((u) => ({
      id: u.id,
      name: u.name,
      role: u.role,
      approver1: u.approver1,
      approver2: u.approver2,
      approver3: u.approver3,
    })),
  });
});

router.post('/admin/approvers/:userId', requireDirector, (req, res) => {
  const { approver1, approver2, approver3 } = req.body;
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.userId);
  if (!target) return res.status(404).json({ error: 'Employee not found.' });

            // Only log - and only mention - the approver slot(s) that actually changed. Re-saving the
            // same chain, or changing just one of the three slots, shouldn't produce a log entry that
            // implies the whole chain was rewritten.
            const nextApprover1 = approver1 || null;
  const nextApprover2 = approver2 || null;
  const nextApprover3 = approver3 || null;
  const allUsers = db.prepare('SELECT id, name FROM users').all();
  const nameOf = (id) => (id ? (allUsers.find((u) => u.id === id)?.name || id) : 'none');
  const slotChanges = [];
  if ((target.approver1 || null) !== nextApprover1) slotChanges.push(`1st approver: ${nameOf(target.approver1)} to ${nameOf(nextApprover1)}`);
  if ((target.approver2 || null) !== nextApprover2) slotChanges.push(`2nd approver: ${nameOf(target.approver2)} to ${nameOf(nextApprover2)}`);
  if ((target.approver3 || null) !== nextApprover3) slotChanges.push(`3rd approver: ${nameOf(target.approver3)} to ${nameOf(nextApprover3)}`);

            db.prepare('UPDATE users SET approver1=?, approver2=?, approver3=? WHERE id=?').run(
              nextApprover1,
              nextApprover2,
              nextApprover3,
              target.id
              );

            if (slotChanges.length) {
              db.prepare('INSERT INTO audit_log (actor_id, actor_name, action, detail, at) VALUES (?, ?, ?, ?, ?)').run(
                req.user.id,
                req.user.name,
                'approvers_updated',
                `Updated approver chain for ${target.name} - ${slotChanges.join('; ')}`,
                nowIso()
                );
            }
  res.json({ ok: true });
});

// ---- Noticeboard (also reachable here for convenience) ----
router.post('/admin/noticeboard', requireDirector, (req, res) => {
  const message = String(req.body.message || '').slice(0, 2000);
  db.prepare(`INSERT INTO settings (key, value) VALUES ('noticeboard', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(message);
  res.json({ ok: true });
});

// ---- Company-wide reporting - visible to everyone, but never individual balances ----
router.get('/admin/report', (req, res) => {
  const pendingCount = db.prepare(`SELECT COUNT(*) c FROM leave_requests WHERE status LIKE 'pending%'`).get().c;
  const approvedDays = db.prepare(`SELECT COALESCE(SUM(days),0) s FROM leave_requests WHERE status='approved'`).get().s;
  const headcount = db.prepare(`SELECT COUNT(*) c FROM users WHERE dept_id IS NOT NULL AND active=1`).get().c;
  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();

           const deptBreakdown = departments.map((d) => {
             const deptUsers = db.prepare('SELECT COUNT(*) c FROM users WHERE dept_id=? AND active=1').get(d.id).c;
             const deptApproved = db.prepare(`SELECT COALESCE(SUM(days),0) s FROM leave_requests WHERE dept_id=? AND status='approved'`).get(d.id).s;
             const deptPending = db.prepare(`SELECT COUNT(*) c FROM leave_requests WHERE dept_id=? AND status LIKE 'pending%'`).get(d.id).c;
             return { id: d.id, name: d.name, headcount: deptUsers, approvedDays: deptApproved, openRequests: deptPending };
           });

           res.json({
             pendingCount,
             approvedDays,
             headcount,
             departmentCount: departments.length,
             departments: deptBreakdown,
           });
});

// ---- Employee entitlements - CEO and managers can view; only the CEO can edit (enforced by
// the separate PUT /admin/employees/:id route, which stays requireDirector-only) ----
// "remaining" here includes the advance-booking window (everyone automatically qualifies for
// it), matching what the employee themselves sees as their available balance on their dashboard.
router.get('/admin/entitlements', requireManagement, (req, res) => {
  const users = db.prepare(`SELECT * FROM users WHERE dept_id IS NOT NULL AND active=1 ORDER BY name`).all();
  const departments = db.prepare('SELECT * FROM departments').all();
  res.json({
    employees: users.map((u) => ({
      id: u.id,
      name: u.name,
      department: departments.find((d) => d.id === u.dept_id)?.name || '-',
      entitlement: u.entitlement,
      accrued: accruedDays(u),
      used: u.used,
      pending: u.pending,
      remaining: remainingDaysAdvance(u),
      hireDate: u.hire_date,
      contractMonths: u.contract_months,
    })),
  });
});

// ---- Employee management (CEO-only) - add / update someone on the roster ----
router.get('/admin/employees', requireDirector, (req, res) => {
  const users = db.prepare('SELECT * FROM users WHERE active=1 ORDER BY name').all();
  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
  res.json({ employees: users, departments });
});

router.post('/admin/employees', requireDirector, (req, res) => {
  const { id, name, email, deptId, role, title, entitlement, hireDate, dob, contractMonths } = req.body;
  if (!id || !name || !email) return res.status(400).json({ error: 'id, name and email are required.' });
  const exists = db.prepare('SELECT id FROM users WHERE id=? OR lower(email)=?').get(id, String(email).toLowerCase());
  if (exists) return res.status(409).json({ error: 'An employee with that ID or email already exists.' });
  db.prepare(
    `INSERT INTO users (id, name, email, dept_id, role, title, entitlement, used, pending, active, hire_date, contract_months, dob)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?, ?, ?)`
    ).run(
    id,
    name,
    String(email).toLowerCase(),
    deptId || null,
    role || 'staff',
    title || null,
    roundHalf(Number(entitlement)) || 15,
    hireDate || null,
    contractMonths ? Number(contractMonths) : null,
    dob || null
    );
  db.prepare('INSERT INTO audit_log (actor_id, actor_name, action, detail, at) VALUES (?, ?, ?, ?, ?)').run(
    req.user.id,
    req.user.name,
    'employee_added',
    `Added ${name} (${id})`,
    nowIso()
    );
  res.json({ ok: true });
});

router.put('/admin/employees/:id', requireDirector, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Employee not found.' });
  const { name, email, deptId, role, title, entitlement, active, hireDate, contractMonths } = req.body;

           // Email can be corrected here too (e.g. a typo'd address means that person can never receive
           // their login code) - normalised the same way as when an employee is first added, and checked
           // for clashes so two people can never end up sharing one login email.
           let normalizedEmail = target.email;
  if (email !== undefined) {
    normalizedEmail = String(email).trim().toLowerCase();
    if (!normalizedEmail) return res.status(400).json({ error: 'Email cannot be empty.' });
    const clash = db.prepare('SELECT id FROM users WHERE lower(email)=? AND id != ?').get(normalizedEmail, target.id);
    if (clash) return res.status(409).json({ error: 'Another employee already uses that email address.' });
  }

           const nextValues = {
             name: name !== undefined ? name : target.name,
             email: normalizedEmail,
             dept_id: deptId !== undefined ? deptId : target.dept_id,
             role: role !== undefined ? role : target.role,
             title: title !== undefined ? title : target.title,
             entitlement: entitlement !== undefined ? roundHalf(Number(entitlement)) : target.entitlement,
             active: active !== undefined ? (active ? 1 : 0) : target.active,
             hire_date: hireDate !== undefined ? hireDate : target.hire_date,
             contract_months: contractMonths !== undefined ? (contractMonths ? Number(contractMonths) : null) : target.contract_months,
           };

           // Only fields that actually changed value get named in the audit log - saving the form
           // unchanged, or changing just one field, shouldn't produce a log entry that implies every
           // field on the record was touched.
           const fieldLabels = {
             name: 'name', email: 'email', dept_id: 'department', role: 'role', title: 'title',
             entitlement: 'annual entitlement', active: 'active status', hire_date: 'hire date', contract_months: 'contract length',
           };
  const changedKeys = Object.keys(fieldLabels).filter((key) => (target[key] ?? null) !== (nextValues[key] ?? null));

           db.prepare(
             `UPDATE users SET name=?, email=?, dept_id=?, role=?, title=?, entitlement=?, active=?, hire_date=?, contract_months=? WHERE id=?`
             ).run(
             nextValues.name,
             nextValues.email,
             nextValues.dept_id,
             nextValues.role,
             nextValues.title,
             nextValues.entitlement,
             nextValues.active,
             nextValues.hire_date,
             nextValues.contract_months,
             target.id
             );

           if (changedKeys.length) {
             db.prepare('INSERT INTO audit_log (actor_id, actor_name, action, detail, at) VALUES (?, ?, ?, ?, ?)').run(
               req.user.id,
               req.user.name,
               'employee_updated',
               `Updated ${target.name}'s ${changedKeys.map((k) => fieldLabels[k]).join(', ')}`,
               nowIso()
               );
           }
  res.json({ ok: true });
});

// ---- All leave requests (CEO-only) - lets the CEO see and cancel anyone's request, not just
// the ones awaiting their own approval. ----
router.get('/admin/leave-requests', requireManagement, (req, res) => {
  const rows = db
  .prepare(`SELECT * FROM leave_requests WHERE status IN ('pending_1','pending_2','approved') ORDER BY start_date DESC`)
  .all();
  const users = db.prepare('SELECT id, name FROM users').all();
  res.json({
    requests: rows.map((r) => ({
      id: r.id,
      employeeName: users.find((u) => u.id === r.employee_id)?.name || 'Unknown',
      type: r.type,
      start: r.start_date,
      end: r.end_date,
      days: r.days,
      status: r.status,
      statusLabel: statusLabel(r.status),
    })),
  });
});

// CEO cancels an employee's request outright (not an approve/reject decision). Any days already
// counted as used or pending are added back to the employee's balance, and they're notified.
router.post('/admin/leave-requests/:id/cancel', requireDirector, (req, res) => {
  const r = db.prepare('SELECT * FROM leave_requests WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Request not found.' });
  if (!['pending_1', 'pending_2', 'approved'].includes(r.status)) {
    return res.status(409).json({ error: 'This request can no longer be cancelled.' });
  }
  const employee = db.prepare('SELECT * FROM users WHERE id=?').get(r.employee_id);
  const wasApproved = r.status === 'approved';
  db.prepare(`UPDATE leave_requests SET status='cancelled' WHERE id=?`).run(r.id);
  if (wasApproved) db.prepare('UPDATE users SET used = used - ? WHERE id=?').run(r.days, employee.id);
  else db.prepare('UPDATE users SET pending = pending - ? WHERE id=?').run(r.days, employee.id);
  db.prepare(`INSERT INTO approval_trail (request_id, by_user_id, by_name, action, at) VALUES (?, ?, ?, 'cancelled by admin', ?)`).run(
    r.id,
    req.user.id,
    req.user.name,
    nowIso()
    );
  db.prepare('INSERT INTO audit_log (actor_id, actor_name, action, detail, at) VALUES (?, ?, ?, ?, ?)').run(
    req.user.id,
    req.user.name,
    'leave_request_admin_cancelled',
    `Request #${r.id} for ${employee.name} cancelled by admin (${r.days} day(s) ${r.type})`,
    nowIso()
    );
  const dateRange = fmtDate(r.start_date) + (r.start_date !== r.end_date ? ' - ' + fmtDate(r.end_date) : '');
  pushNotification(employee.id, `${req.user.name} has removed your ${r.type} leave request for ${dateRange}.`);
  res.json({ ok: true, status: 'cancelled' });
});

// ---- Manual leave-year rollover trigger (also runs automatically each 1 March - see cron in server.js) ----
router.post('/admin/rollover-leave-year', requireDirector, (req, res) => {
  const users = db.prepare('SELECT * FROM users WHERE active=1').all();
  users.forEach((u) => {
    const forfeited = remainingDays(u);
    if (forfeited > 0) {
      db.prepare('INSERT INTO audit_log (actor_id, actor_name, action, detail, at) VALUES (?, ?, ?, ?, ?)').run(
        req.user.id,
        req.user.name,
        'leave_year_rollover',
        `${u.name} forfeited ${forfeited} unused day(s)`,
        nowIso()
        );
    }
    db.prepare('UPDATE users SET used=0, pending=0 WHERE id=?').run(u.id);
  });
  res.json({ ok: true, message: `Leave year rolled over for ${users.length} employees.` });
});

router.get('/admin/audit-log', requireDirector, (req, res) => {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all();
  res.json({ entries: rows });
});


// ---- Terminate / offboard an employee (CEO-only) ----
// Soft-deletes the account (active=0, matching the pattern used everywhere else - historical leave
// records must survive for reporting/audit), cancels anything still pending so it doesn't linger
// forever awaiting approval, and snapshots the accrued-but-unused annual leave balance as the
// payout owed to them, since that figure would otherwise keep changing after they've left.
router.post('/admin/employees/:id/terminate', requireDirector, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Employee not found.' });
  if (!target.active) return res.status(409).json({ error: 'This employee has already been terminated.' });

            const reason = (req.body && req.body.reason) ? String(req.body.reason).slice(0, 2000) : null;
  const payoutDays = roundHalf(Math.max(0, accruedDays(target) - target.used));

            const pendingRequests = db.prepare(`SELECT * FROM leave_requests WHERE employee_id=? AND status IN ('pending_1','pending_2')`).all(target.id);
  pendingRequests.forEach((r) => {
    db.prepare(`UPDATE leave_requests SET status='cancelled' WHERE id=?`).run(r.id);
  });

            db.prepare(
              'UPDATE users SET active=0, terminated_at=?, termination_reason=?, payout_days=? WHERE id=?'
              ).run(nowIso(), reason, payoutDays, target.id);

            db.prepare('INSERT INTO audit_log (actor_id, actor_name, action, detail, at) VALUES (?, ?, ?, ?, ?)').run(
              req.user.id,
              req.user.name,
              'employee_terminated',
              `${target.name} was terminated by ${req.user.name}${reason ? ` (${reason})` : ''} - ${pendingRequests.length} pending request(s) cancelled, ${payoutDays} day(s) unused leave to pay out`,
              nowIso()
              );

            res.json({ ok: true, payoutDays, cancelledRequests: pendingRequests.length });
});

module.exports = router;
