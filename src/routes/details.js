// Employee self-service details: low-sensitivity fields (phone, emergency contact, address) can
// be updated directly by the employee themselves. Higher-sensitivity fields (ID number, bank
// details - the fields that actually matter for payroll and identity) go through a CEO-approved
// change request instead of applying instantly, the same "escalate for approval" pattern already
// used for advance leave bookings: nothing here is ever silently overwritten.

const express = require('express');
const db = require('../db');
const { requireAuth, requireDirector } = require('../middleware/auth');
const { nowIso } = require('../helpers');
const { pushNotification } = require('../notify');

const router = express.Router();
router.use(requireAuth);

const DIRECT_FIELDS = ['phone', 'emergency_contact_name', 'emergency_contact_phone', 'address'];
const SENSITIVE_FIELDS = {
  id_number: 'ID / passport number',
  bank_name: 'Bank name',
  bank_account_number: 'Bank account number',
  bank_branch_code: 'Bank branch code',
};

router.get('/details/me', (req, res) => {
  const u = req.user;
  res.json({
    phone: u.phone || '',
    emergencyContactName: u.emergency_contact_name || '',
    emergencyContactPhone: u.emergency_contact_phone || '',
    address: u.address || '',
    idNumber: u.id_number || '',
    bankName: u.bank_name || '',
    bankAccountNumber: u.bank_account_number || '',
    bankBranchCode: u.bank_branch_code || '',
  });
});

router.post('/details/me', (req, res) => {
  const { phone, emergencyContactName, emergencyContactPhone, address } = req.body;
  db.prepare(
    'UPDATE users SET phone=?, emergency_contact_name=?, emergency_contact_phone=?, address=? WHERE id=?'
  ).run(phone || null, emergencyContactName || null, emergencyContactPhone || null, address || null, req.user.id);
  db.prepare('INSERT INTO audit_log (actor_id, actor_name, action, detail, at) VALUES (?, ?, ?, ?, ?)').run(
    req.user.id, req.user.name, 'employee_details_updated', `${req.user.name} updated their own contact details`, nowIso()
  );
  res.json({ ok: true });
});

router.post('/details/change-request', (req, res) => {
  const { field, newValue } = req.body;
  const label = SENSITIVE_FIELDS[field];
  if (!label) return res.status(400).json({ error: 'That field cannot be changed this way.' });
  if (!newValue || !String(newValue).trim()) return res.status(400).json({ error: 'Please enter a value.' });
  const existing = db.prepare(`SELECT * FROM detail_change_requests WHERE employee_id=? AND field=? AND status='pending'`).get(req.user.id, field);
  if (existing) return res.status(409).json({ error: 'You already have a pending request for this field.' });
  const oldValue = req.user[field] || '';
  const info = db.prepare(
    'INSERT INTO detail_change_requests (employee_id, field, field_label, old_value, new_value, status, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(req.user.id, field, label, oldValue, String(newValue).trim(), 'pending', nowIso());
  db.prepare('INSERT INTO audit_log (actor_id, actor_name, action, detail, at) VALUES (?, ?, ?, ?, ?)').run(
    req.user.id, req.user.name, 'detail_change_requested', `${req.user.name} requested to change ${label}`, nowIso()
  );
  const ceoId = db.prepare(`SELECT id FROM users WHERE role='director' ORDER BY id LIMIT 1`).get()?.id;
  if (ceoId) pushNotification(ceoId, `${req.user.name} has requested to change their ${label.toLowerCase()} - needs your approval.`);
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});

router.get('/details/change-requests/mine', (req, res) => {
  const rows = db.prepare('SELECT * FROM detail_change_requests WHERE employee_id=? ORDER BY id DESC').all(req.user.id);
  res.json({ requests: rows });
});

router.get('/details/change-requests/pending', requireDirector, (req, res) => {
  const rows = db.prepare(`SELECT * FROM detail_change_requests WHERE status='pending' ORDER BY requested_at ASC`).all();
  const users = db.prepare('SELECT id, name FROM users').all();
  res.json({
    requests: rows.map((r) => ({ ...r, employeeName: users.find((u) => u.id === r.employee_id)?.name || 'Unknown' })),
  });
});

router.post('/details/change-requests/:id/approve', requireDirector, (req, res) => handleDetailDecision(req, res, 'approve'));
router.post('/details/change-requests/:id/reject', requireDirector, (req, res) => handleDetailDecision(req, res, 'reject'));

function handleDetailDecision(req, res, action) {
  const r = db.prepare('SELECT * FROM detail_change_requests WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Request not found.' });
  if (r.status !== 'pending') return res.status(409).json({ error: 'This request has already been decided.' });
  const status = action === 'approve' ? 'approved' : 'rejected';
  db.prepare('UPDATE detail_change_requests SET status=?, decided_at=?, decided_by=? WHERE id=?').run(status, nowIso(), req.user.name, r.id);
  if (action === 'approve') {
    db.prepare(`UPDATE users SET ${r.field}=? WHERE id=?`).run(r.new_value, r.employee_id);
  }
  const employee = db.prepare('SELECT * FROM users WHERE id=?').get(r.employee_id);
  if (employee) {
    pushNotification(
      employee.id,
      action === 'approve'
        ? `Your request to change your ${r.field_label.toLowerCase()} has been approved and updated.`
        : `Your request to change your ${r.field_label.toLowerCase()} was declined by the CEO.`
    );
  }
  db.prepare('INSERT INTO audit_log (actor_id, actor_name, action, detail, at) VALUES (?, ?, ?, ?, ?)').run(
    req.user.id, req.user.name, `detail_change_${status}`, `${r.field_label} change for ${employee ? employee.name : r.employee_id}`, nowIso()
  );
  res.json({ ok: true, status });
}

module.exports = router;
