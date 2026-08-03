const express = require('express');
const db = require('../db');
const { requireAuth, requireDirector } = require('../middleware/auth');
const { remainingDays,accruedDays,  nowIso } = require('../helpers');

const router = express.Router();
router.use(requireAuth);

// ---- Approver assignments — CEO-only, both to view and to edit ----
router.get('/admin/approvers', requireDirector, (req, res) => {
  const users = db.prepare(`SELECT * FROM users WHERE id != ? AND active=1 ORDER BY name`).all(req.user.id);
  const allUsers = db.prepare('SELECT id, name FROM users WHERE active=1 ORDER BY name').all();
  res.json({
    options: allUsers,
    employees: users.map((u) => ({
      id: u.id,
      name: u.name,
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
  db.prepare('UPDATE users SET approver1=?, approver2=?, approver3=? WHERE id=?').run(
    approver1 || null,
    approver2 || null,
    approver3 || null,
    target.id
  );
  db.prepare('INSERT INTO audit_log (actor_id, actor_name, action, detail, at) VALUES (?, ?, ?, ?, ?)').run(
    req.user.id,
    req.user.name,
    'approvers_updated',
    `Updated approver chain for ${target.name}`,
    nowIso()
  );
  res.json({ ok: true });
});

// ---- Noticeboard (also reachable here for convenience) ----
router.post('/admin/noticeboard', requireDirector, (req, res) => {
  const message = String(req.body.message || '').slice(0, 2000);
  db.prepare(`INSERT INTO settings (key, value) VALUES ('noticeboard', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(message);
  res.json({ ok: true });
});

// ---- Company-wide reporting — visible to everyone, but never individual balances ----
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

// ---- Employee entitlements — CEO-only (privacy: managers never see individual balances) ----
router.get('/admin/entitlements', requireDirector, (req, res) => {
  const users = db.prepare(`SELECT * FROM users WHERE dept_id IS NOT NULL AND active=1 ORDER BY name`).all();
  const departments = db.prepare('SELECT * FROM departments').all();
  res.json({
    employees: users.map((u) => ({
      id: u.id,
      name: u.name,
      department: departments.find((d) => d.id === u.dept_id)?.name || '—',
      entitlement: u.entitlement,
      accrued: accruedDays(u),
      used: u.used,
      pending: u.pending,
      remaining: remainingDays(u),
    })),
  });
});

// ---- Employee management (CEO-only) — add / update someone on the roster ----
router.get('/admin/employees', requireDirector, (req, res) => {
  const users = db.prepare('SELECT * FROM users WHERE active=1 ORDER BY name').all();
  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
  res.json({ employees: users, departments });
});

router.post('/admin/employees', requireDirector, (req, res) => {
  const { id, name, email, deptId, role, title, entitlement } = req.body;
  if (!id || !name || !email) return res.status(400).json({ error: 'id, name and email are required.' });
  const exists = db.prepare('SELECT id FROM users WHERE id=? OR lower(email)=?').get(id, String(email).toLowerCase());
  if (exists) return res.status(409).json({ error: 'An employee with that ID or email already exists.' });
  db.prepare(
    `INSERT INTO users (id, name, email, dept_id, role, title, entitlement, used, pending, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 1)`
  ).run(id, name, String(email).toLowerCase(), deptId || null, role || 'staff', title || null, Number(entitlement) || 15);
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
  const { name, deptId, role, title, entitlement, active } = req.body;
  db.prepare(
    `UPDATE users SET name=COALESCE(?,name), dept_id=?, role=COALESCE(?,role), title=?, entitlement=COALESCE(?,entitlement), active=COALESCE(?,active) WHERE id=?`
  ).run(name, deptId ?? target.dept_id, role, title, entitlement !== undefined ? Number(entitlement) : undefined, active !== undefined ? (active ? 1 : 0) : undefined, target.id);
  res.json({ ok: true });
});

// ---- Manual leave-year rollover trigger (also runs automatically each 1 March — see cron in server.js) ----
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

module.exports = router;
