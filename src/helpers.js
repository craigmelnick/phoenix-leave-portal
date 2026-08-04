// Shared business logic — leave year, business-day counting, date validation, approval routing.
// These mirror the logic from the earlier prototype exactly (including the timezone-safe date
// handling fix), just running server-side against real data instead of in-memory arrays.

const db = require('./db');

const LEAVE_YEAR = { start: '2026-03-01', end: '2027-02-28' };

// Shown on the dashboard welcome banner every time someone logs in, and reused (with a
// thank-you line) in the leave-approval email. Kept short, work-appropriate and generic —
// no attribution disputes, nothing that reads oddly out of context in an email.
const MOTIVATIONAL_QUOTES = [
  'Well done is better than well said.',
  'The way to get started is to quit talking and begin doing.',
  'Success is the sum of small efforts, repeated day in and day out.',
  'It always seems impossible until it is done.',
  'Believe you can, and you are halfway there.',
  'Hard work beats talent when talent does not work hard.',
  'A little progress each day adds up to big results.',
  'Teamwork makes the dream work.',
  'Great things are done by a series of small things brought together.',
  'The harder you work for something, the greater you will feel when you achieve it.',
  'Your work is going to fill a large part of your life — the only way to be truly satisfied is to do great work.',
  'Opportunities do not happen. You create them.',
  'Do not watch the clock; do what it does. Keep going.',
  'Every accomplishment starts with the decision to try.',
  'Take care of your people, and they will take care of everything else.',
  'Small daily improvements are the key to staggering long-term results.',
  'The best way to predict the future is to create it.',
  'Keep your eyes on the stars, and your feet on the ground.',
  'Quality is not an act, it is a habit.',
  'You do not have to be great to start, but you have to start to be great.',
];

function randomQuote() {
  return MOTIVATIONAL_QUOTES[Math.floor(Math.random() * MOTIVATIONAL_QUOTES.length)];
}

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

// End date is the day the employee is BACK at work, not a day of leave — so the range counted
// is [start, end), i.e. up to but not including the end date. A request from the 16th to the
// 19th is 3 leave days (16th, 17th, 18th), returning to work on the 19th.
function businessDaysBetween(startStr, endStr) {
  const holidays = getHolidays();
  let start = new Date(startStr + 'T00:00:00');
  let end = new Date(endStr + 'T00:00:00');
  let count = 0;
  let d = new Date(start);
  while (d < end) {
    const day = d.getDay();
    const iso = toLocalIso(d);
    if (day !== 0 && day !== 6 && !holidays.includes(iso)) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

// Leave-day figures are only ever shown to the half-day, never finer — rounds to the nearest
// 0.5 rather than leaving arbitrary two-decimal fractions (like 8.33 or 7.29, which fall
// straight out of entitlement/12 monthly accrual math) on screen or in balance checks.
// Used for direct data-entry figures (e.g. an admin typing in an annual entitlement), where
// "nearest" is the intuitive behaviour and there's no earned/unearned distinction to protect.
function roundHalf(n) {
  return Math.round(n * 2) / 2;
}

// Same half-day grid, but always rounds DOWN. Used anywhere a figure represents what someone
// has actually earned so far (accrued days, and anything derived from it, like remaining
// balance) — rounding those to the *nearest* half instead of down could round e.g. a true
// accrual of 8.75 days up to 9, letting someone book a whole extra day they have not actually
// earned yet. Flooring guarantees the half-day-only display rule never overstates entitlement.
function floorHalf(n) {
  return Math.floor(n * 2) / 2;
}

// Annual leave is earned monthly, in arrears — you must complete a full calendar month before
// that month's share is credited. A person on 15 days/year earns 15/12 = 1.25 days for each
// completed month. The clock always resets to the leave year start (1 March) for everyone, but:
//   - someone hired partway through the leave year only starts accruing from their hire date
//     (true joining date, not 1 March) — so a new starter is correctly prorated;
//   - someone on a fixed-term contract (e.g. 6 months at a time) stops accruing once their
//     contract_months is reached, even if the leave year isn't over yet.
// Counts complete months elapsed since max(leave year start, hire date), capped at 12 and at
// contract_months when the employee is on a fixed-term contract.
function monthsElapsedInArrears(user, asOf) {
  const yearStart = new Date(LEAVE_YEAR.start + 'T00:00:00');
  const hireDate = user && user.hire_date ? new Date(user.hire_date + 'T00:00:00') : null;
  const start = hireDate && hireDate > yearStart ? hireDate : yearStart;
  const ref = asOf ? new Date(asOf) : new Date();
  let months = (ref.getFullYear() - start.getFullYear()) * 12 + (ref.getMonth() - start.getMonth());
  if (ref.getDate() < start.getDate()) months -= 1;
  months = Math.max(0, months);
  const cap = user && user.contract_months ? Math.min(12, user.contract_months) : 12;
  return Math.min(cap, months);
}

// Floored to the half-day (never rounded up) — this is the figure every balance check is built
// on, so it must never overstate what has actually been earned.
function accruedDays(user, asOf) {
  const months = monthsElapsedInArrears(user, asOf);
  return floorHalf((user.entitlement * months) / 12);
}

// "Available" balance is based on what's actually been accrued so far this leave year (in
// arrears), not the full annual entitlement — matches the real company policy: you can't book
// leave you haven't earned yet. Floored (not rounded) so a partial half-day from the accrual
// or used/pending figures can never tip someone's available balance above what they've earned.
function remainingDays(user) {
  return floorHalf(accruedDays(user) - user.used - user.pending);
}

// How far ahead someone is allowed to book leave in the normal flow before it needs management
// escalation. Policy: 6 months ahead in March, growing by one month for every completed month
// of the leave year (April = 7 months, May = 8, ... August = 11) — and once the leave year is
// half over (from September onward), the whole rest of the current leave year is bookable with
// no escalation needed at all.
function addMonths(date, n) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d;
}

function advanceWindowCutoff(asOf) {
  const ref = asOf ? new Date(asOf) : new Date();
  const yearStart = new Date(LEAVE_YEAR.start + 'T00:00:00');
  let idx = (ref.getFullYear() - yearStart.getFullYear()) * 12 + (ref.getMonth() - yearStart.getMonth());
  idx = Math.max(0, Math.min(11, idx));
  if (idx <= 5) return toLocalIso(addMonths(ref, 6 + idx));
  return LEAVE_YEAR.end;
}

function isBeyondAdvanceWindow(startIso, asOf) {
  return startIso > advanceWindowCutoff(asOf);
}

// Same idea as remainingDays(), but projected forward to a future date — lets someone book
// annual leave they haven't earned yet today, as long as they will have earned it by the time
// the leave actually starts (and it's within the advance window above). Floored for the same
// reason as remainingDays(): this feeds the actual balance-exceeded check on submission, so it
// must never show/allow more than what will truly be earned by that date.
function remainingDaysAsOf(user, asOfIso) {
  return floorHalf(accruedDays(user, asOfIso) - user.used - user.pending);
}

// The headline "available to book right now" balance, including the advance-booking window —
// everyone automatically qualifies for the growing advance window (6 months in March, growing
// by a month each month, and the whole rest of the leave year from September), so this is what
// actually gets shown to staff and the CEO as the leave balance, rather than only what's strictly
// accrued as of today. Never runs past the leave year end, since nothing is earned beyond that
// without a fresh leave year starting.
function remainingDaysAdvance(user) {
  return remainingDaysAsOf(user, advanceWindowCutoff());
}

// How many days someone has already taken/approved+pending beyond what they've actually earned
// as of today — the exposure HR would need to claw back from a final salary if they resigned
// right now. Zero once accrual catches up. Rounded (not floored) here on purpose: accruedDays()
// is already floored down, so this exposure figure is already conservative (equal to or larger
// than the true overage) — rounding the remainder to the nearest half just keeps the number
// itself on the half-day grid without needing to floor twice.
function advanceDaysTaken(user) {
  return Math.max(0, roundHalf(user.used + user.pending - accruedDays(user)));
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

// Hard block: only one person per department may be on leave (approved or pending) at once.
// Each request occupies [start, end) — end date is the return-to-work day, not a leave day —
// so two requests only truly overlap if one's start is before the other's end and vice versa.
function overlappingColleagues(deptId, start, end, excludeEmployeeId) {
  if (!deptId) return [];
  const rows = db
    .prepare(
      `SELECT * FROM leave_requests WHERE dept_id = ? AND status NOT IN ('rejected','cancelled') AND employee_id != ?`
    )
    .all(deptId, excludeEmployeeId);
  const s = new Date(start + 'T00:00:00');
  const e = new Date(end + 'T00:00:00');
  return rows.filter((r) => {
    const rs = new Date(r.start_date + 'T00:00:00');
    const re = new Date(r.end_date + 'T00:00:00');
    return rs < e && re > s;
  });
}

function fmtDate(iso) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
}

function statusLabel(s) {
  return { pending_1: 'Pending 1st approval', pending_2: 'Pending 2nd approval', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled' }[s] || s;
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = {
  LEAVE_YEAR,
  MOTIVATIONAL_QUOTES,
  randomQuote,
  toLocalIso,
  isValidCalendarDate,
  getHolidays,
  businessDaysBetween,
  roundHalf,
  floorHalf,
  remainingDays,
  accruedDays,
  advanceWindowCutoff,
  isBeyondAdvanceWindow,
  remainingDaysAsOf,
  remainingDaysAdvance,
  advanceDaysTaken,
  stage2Pool,
  getCeoId,
  isAwaitingApproval,
  isApproverForSomeone,
  overlappingColleagues,
  fmtDate,
  statusLabel,
  nowIso,
};
