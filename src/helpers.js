// Shared business logic — leave year, business-day counting, date validation, approval routing.
// These mirror the logic from the earlier prototype exactly (including the timezone-safe date
// handling fix), just running server-side against real data instead of in-memory arrays.

const db = require('./db');

const LEAVE_YEAR = { start: '2026-03-01', end: '2027-02-28' };

function toLocalIso(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Validates a YYYY-MM-DD string represents a real calendar date, entirely in local time —
// no toISOString() round-trip, which is what caused the "please choose a valid start date" bug
// in the original prototype for anyone in a timezone ahead of UTC (e.g. South Africa, UTC+2).
function isValidCalendarDate(iso) {
  if (typeof iso !== 'string') return false;
  const parts = iso.split('-').map(Number);
  if (parts.length !== 3 || parts.some((p) => Number.isNaN(p))) return false;
  const [y, m, day] = parts;
  const d = new Date(y, m - 1, day);
  return d.getFullYear() === y && d.getMonth() === m - 1 && d.getDate() === day;
}

function getHolidays() {
  return db.prepare('SELECT date FROM holidays').all().map((r) => r.date);
}

function businessDaysBetween(startStr, endStr) {
  const holidays = getHolidays();
  let start = new Date(startStr + 'T00:00:00');
  let end = new Date(endStr + 'T00:00:00');
  let count = 0;
  let d = new Date(start);
  while (d <= end) {
    const day = d.getDay();
    const iso = toLocalIso(d);
    if (day !== 0 && day !== 6 && !holidays.includes(iso)) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

function remainingDays(user) {
  return Math.round((user.entitlement - user.used - user.pending) * 100) / 100;
}

// The backup pool for the *second* (final) approval step — either person can act.
// Defaults to the CEO if no second approver has been assigned.
function stage2Pool(employee) {
  const pool = [employee.approver2, employee.approver3].filter(Boolean);
  return pool.length ? pool : [getCeoId()];
}

let cachedCeoId = null;
function getCeoId() {
  if (cachedCeoId) return cachedCeoId;
  const row = db.prepare(`SELECT id FROM users WHERE role='director' ORDER BY id LIMIT 1`).get();
  cachedCeoId = row ? row.id : null;
  return cachedCeoId;
}

function isAwaitingApproval(request, userId, employee) {
  if (request.status === 'pending_1') return employee.approver1 === userId;
  if (request.status === 'pending_2') return stage2Pool(employee).includes(userId);
  return false;
}

function isApproverForSomeone(userId, allUsers) {
  return allUsers.some(
    (u) =>
      u.approver1 === userId ||
      u.approver2 === userId ||
      u.approver3 === userId ||
      (!u.approver2 && !u.approver3 && userId === getCeoId() && u.approver1)
  );
}

// Hard block: only one person per department may be on leave (approved or pending) at once,
// on overlapping dates. This is enforced here (not just in the UI) so it can't be bypassed.
function overlappingColleagues(deptId, start, end, excludeEmployeeId) {
  if (!deptId) return [];
  const rows = db
    .prepare(
      `SELECT * FROM leave_requests WHERE dept_id = ? AND status != 'rejected' AND employee_id != ?`
    )
    .all(deptId, excludeEmployeeId);
  const s = new Date(start + 'T00:00:00');
  const e = new Date(end + 'T00:00:00');
  return rows.filter((r) => {
    const rs = new Date(r.start_date + 'T00:00:00');
    const re = new Date(r.end_date + 'T00:00:00');
    return rs <= e && re >= s;
  });
}

function fmtDate(iso) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
}

function statusLabel(s) {
  return { pending_1: 'Pending 1st approval', pending_2: 'Pending 2nd approval', approved: 'Approved', rejected: 'Rejected' }[s] || s;
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = {
  LEAVE_YEAR,
  toLocalIso,
  isValidCalendarDate,
  getHolidays,
  businessDaysBetween,
  remainingDays,
  stage2Pool,
  getCeoId,
  isAwaitingApproval,
  isApproverForSomeone,
  overlappingColleagues,
  fmtDate,
  statusLabel,
  nowIso,
};
