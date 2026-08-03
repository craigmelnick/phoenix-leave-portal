const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { getHolidays, statusLabel } = require('../helpers');

const router = express.Router();
router.use(requireAuth);

// Returns leave entries for a single month, scoped to the user's department unless they're
// the CEO (who sees everything). Used for both the 1-month and 12-month (called 12x) views.
router.get('/calendar/month', (req, res) => {
  const user = req.user;
  const year = Number(req.query.year);
  const month = Number(req.query.month); // 0-based
  if (Number.isNaN(year) || Number.isNaN(month)) return res.status(400).json({ error: 'year and month are required.' });

  const isCompanyWide = user.role === 'director';
  const deptId = isCompanyWide ? null : user.dept_id;

  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const startIso = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const endIso = `${year}-${String(month + 1).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;

  // A request occupies [start_date, end_date) — end_date is the return-to-work day, not a leave
  // day — so it only overlaps this month if it starts on/before the month's last day and ends
  // strictly after the month's first day.
  let rows;
  if (deptId) {
    rows = db
      .prepare(`SELECT * FROM leave_requests WHERE dept_id=? AND status NOT IN ('rejected','cancelled') AND start_date <= ? AND end_date > ?`)
      .all(deptId, endIso, startIso);
  } else {
    rows = db
      .prepare(`SELECT * FROM leave_requests WHERE status NOT IN ('rejected','cancelled') AND start_date <= ? AND end_date > ?`)
      .all(endIso, startIso);
  }
  const allUsers = db.prepare('SELECT id, name FROM users').all();
  const holidays = getHolidays();

  const days = {};
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dow = new Date(year, month, d).getDay();
    const entries = rows
      .filter((r) => iso >= r.start_date && iso < r.end_date)
      .map((r) => ({
        employeeName: allUsers.find((u) => u.id === r.employee_id)?.name || '-',
        type: r.type,
        status: r.status,
        statusLabel: statusLabel(r.status),
      }));
    days[d] = { isWeekend: dow === 0 || dow === 6, isHoliday: holidays.includes(iso), entries };
  }

  res.json({
    year,
    month,
    scope: isCompanyWide ? 'All departments' : db.prepare('SELECT name FROM departments WHERE id=?').get(deptId)?.name,
    days,
  });
});

module.exports = router;
