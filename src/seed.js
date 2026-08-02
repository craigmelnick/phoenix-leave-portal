// One-time seed of the real Phoenix roster, departments, holidays, approver chains and the
// handful of historical leave requests carried over from the prototype. Safe to re-run — it
// only inserts rows that don't already exist, so it won't duplicate data or clobber anything
// that's since changed via the real app (e.g. new approver assignments, new requests).

const db = require('./db');
const { nowIso } = require('./helpers');

const departments = [
  { id: 'sales', name: 'Sales' },
  { id: 'invoicing', name: 'Invoicing' },
  { id: 'operations', name: 'Operations' },
  { id: 'officeassist', name: 'Office Assistant' },
  { id: 'financeaccounts', name: 'Finance and Accounts' },
  { id: 'customliason', name: 'Custom Liason' },
  { id: 'driver', name: 'Driver' },
  { id: 'cleaner', name: 'Cleaner' },
  { id: 'execoffice', name: 'Executive Office' },
];

// email pattern: first initial + surname @phoenixintl.co.za (matches the login pattern used
// in the earlier prototype and the company's real convention)
function emailFor(name) {
  const parts = name.toLowerCase().split(/\s+/);
  const handle = parts[0][0] + parts.slice(1).join('');
  return handle + '@phoenixintl.co.za';
}

const users = [
  { id: 'u1', name: 'Craig Melnick', dept: null, role: 'director', title: 'CEO', entitlement: 6.68, used: 0, pending: 0, approver1: null, approver2: null, approver3: null },
  { id: 'u2', name: 'Robin Theron', dept: 'execoffice', role: 'manager', entitlement: 15, used: 5, pending: 0, approver1: 'u7', approver2: 'u1', approver3: 'u18' },
  { id: 'u3', name: 'Anmar Jordaan', dept: 'sales', role: 'staff', entitlement: 15, used: 3, pending: 0, approver1: 'u8', approver2: 'u1', approver3: null },
  { id: 'u4', name: 'Michelle Briesies', dept: 'invoicing', role: 'staff', entitlement: 17.5, used: 5, pending: 0, approver1: 'u19', approver2: 'u1', approver3: null },
  { id: 'u5', name: 'Bianca Smit', dept: 'operations', role: 'staff', entitlement: 17.5, used: 3, pending: 0, approver1: 'u22', approver2: 'u18', approver3: null },
  { id: 'u6', name: 'Imagine Chemwaita', dept: 'officeassist', role: 'staff', entitlement: 15, used: 1, pending: 0, approver1: 'u1', approver2: null, approver3: null },
  { id: 'u7', name: 'Boudine Cook', dept: 'financeaccounts', role: 'staff', entitlement: 17.5, used: 5, pending: 0, approver1: 'u2', approver2: 'u1', approver3: null },
  { id: 'u8', name: 'Tristan Melnick', dept: 'operations', role: 'staff', entitlement: 15, used: 9.5, pending: 0, approver1: 'u3', approver2: 'u1', approver3: null },
  { id: 'u9', name: 'Ian Smith', dept: 'customliason', role: 'staff', entitlement: 17.5, used: 3, pending: 0, approver1: 'u14', approver2: 'u18', approver3: null },
  { id: 'u10', name: 'Wilfred Mkumbuzi', dept: 'driver', role: 'staff', entitlement: 20, used: 2, pending: 0, approver1: 'u11', approver2: 'u18', approver3: null },
  { id: 'u11', name: 'Joseph Seshibe', dept: 'driver', role: 'staff', entitlement: 20, used: 5, pending: 0, approver1: 'u10', approver2: 'u18', approver3: null },
  { id: 'u12', name: 'Trevor Nkuna', dept: 'driver', role: 'staff', entitlement: 15, used: 5.5, pending: 0, approver1: 'u25', approver2: 'u18', approver3: null },
  { id: 'u13', name: 'Eunice Seshibe', dept: 'cleaner', role: 'staff', entitlement: 15, used: 4, pending: 0, approver1: 'u18', approver2: null, approver3: null },
  { id: 'u14', name: 'Christopher Madlala', dept: 'customliason', role: 'staff', entitlement: 15, used: 2, pending: 0, approver1: 'u9', approver2: 'u18', approver3: null },
  { id: 'u15', name: 'Amore Ras', dept: 'operations', role: 'staff', entitlement: 15, used: 4, pending: 2, approver1: 'u16', approver2: 'u18', approver3: null },
  { id: 'u16', name: 'Joedre Gebhardt', dept: 'operations', role: 'staff', entitlement: 15, used: 6.5, pending: 0, approver1: 'u15', approver2: 'u18', approver3: 'u1' },
  { id: 'u17', name: 'Paballo Maishone', dept: 'operations', role: 'staff', entitlement: 15, used: 7, pending: 0, approver1: 'u25', approver2: 'u18', approver3: null },
  { id: 'u18', name: 'Varusha Govender', dept: 'operations', role: 'staff', entitlement: 20, used: 13, pending: 0, approver1: 'u5', approver2: 'u1', approver3: null },
  { id: 'u19', name: 'Karen Everts', dept: 'invoicing', role: 'staff', entitlement: 20, used: 7, pending: 0, approver1: 'u4', approver2: 'u1', approver3: null },
  { id: 'u20', name: 'Sebrina Bezuidenhout', dept: 'operations', role: 'staff', entitlement: 15, used: 11.5, pending: 0, approver1: 'u18', approver2: 'u1', approver3: null },
  { id: 'u21', name: 'Jeanine Leong', dept: 'operations', role: 'staff', entitlement: 17.5, used: 6, pending: 0, approver1: 'u18', approver2: 'u1', approver3: null },
  { id: 'u22', name: 'Mariska Darman', dept: 'operations', role: 'staff', entitlement: 15, used: 12.5, pending: 0, approver1: 'u5', approver2: 'u18', approver3: null },
  { id: 'u23', name: 'Talana Sandmann', dept: 'sales', role: 'staff', entitlement: 9.5, used: 0, pending: 0, approver1: 'u8', approver2: 'u1', approver3: null },
  { id: 'u24', name: 'Deon Botha', dept: 'operations', role: 'staff', entitlement: 15, used: 0, pending: 0, approver1: 'u18', approver2: 'u1', approver3: null },
  { id: 'u25', name: 'Maxwell Ndlovu', dept: 'driver', role: 'staff', entitlement: 20, used: 1, pending: 0, approver1: 'u12', approver2: 'u18', approver3: null },
  { id: 'u26', name: 'Nompumelelo Zwane', dept: 'operations', role: 'staff', entitlement: 15, used: 6, pending: 0, approver1: 'u17', approver2: 'u18', approver3: null },
];

const holidays = ['2026-08-09', '2026-09-24', '2026-12-16', '2026-12-25', '2026-12-26', '2027-01-01', '2027-03-21'];

const historicalRequests = [
  { employeeId: 'u15', dept: 'operations', type: 'Annual', start: '2026-08-10', end: '2026-08-11', days: 2, reason: 'Long weekend trip', status: 'pending_1', trail: [{ by: 'System', action: 'submitted' }] },
  { employeeId: 'u15', dept: 'operations', type: 'Sick', start: '2026-06-15', end: '2026-06-15', days: 1, reason: 'Appointment', status: 'approved', trail: [{ by: 'Joedre Gebhardt', action: 'approved (step 1)' }, { by: 'Craig Melnick', action: 'approved (step 2)' }] },
  { employeeId: 'u22', dept: 'operations', type: 'Sick', start: '2026-07-02', end: '2026-07-02', days: 1, reason: 'Had to go to the doctor.', status: 'approved', trail: [{ by: 'System', action: 'auto-approved (submitted before approvers were assigned)' }] },
  { employeeId: 'u16', dept: 'operations', type: 'Annual', start: '2026-08-17', end: '2026-08-19', days: 3, reason: 'Family event', status: 'approved', trail: [{ by: 'System', action: 'auto-approved (submitted before approvers were assigned)' }] },
  { employeeId: 'u18', dept: 'operations', type: 'Annual', start: '2026-07-08', end: '2026-07-08', days: 1, reason: '', status: 'approved', trail: [{ by: 'System', action: 'auto-approved (submitted before approvers were assigned)' }] },
];

function seed() {
  const insDept = db.prepare('INSERT OR IGNORE INTO departments (id, name) VALUES (?, ?)');
  departments.forEach((d) => insDept.run(d.id, d.name));

  const insHoliday = db.prepare('INSERT OR IGNORE INTO holidays (date) VALUES (?)');
  holidays.forEach((h) => insHoliday.run(h));

  // Only seed the approver chains the very first time the database is created — after that,
  // the CEO's own edits in Admin settings are the source of truth and must never be overwritten
  // by a server restart re-running this seed. We detect "first time" by checking whether the
  // users table is empty before we insert anything.
  const isFreshDatabase = db.prepare('SELECT COUNT(*) c FROM users').get().c === 0;

  // Two passes: insert everyone with no approvers first, then wire up the approver chains.
  // Necessary because the roster references each other (e.g. u2's approver is u7, who hasn't
  // been inserted yet at that point in the list) and foreign keys are enforced immediately.
  const insUser = db.prepare(`
    INSERT OR IGNORE INTO users (id, name, email, dept_id, role, title, entitlement, used, pending, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  users.forEach((u) => {
    insUser.run(u.id, u.name, emailFor(u.name), u.dept, u.role, u.title || null, u.entitlement, u.used, u.pending);
  });
  if (isFreshDatabase) {
    const updApprovers = db.prepare('UPDATE users SET approver1=?, approver2=?, approver3=? WHERE id=?');
    users.forEach((u) => {
      updApprovers.run(u.approver1, u.approver2, u.approver3, u.id);
    });
  }

  const existingReqs = db.prepare('SELECT COUNT(*) c FROM leave_requests').get().c;
  if (existingReqs === 0) {
    const insReq = db.prepare(`
      INSERT INTO leave_requests (employee_id, dept_id, type, start_date, end_date, days, reason, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insTrail = db.prepare(`
      INSERT INTO approval_trail (request_id, by_user_id, by_name, action, at) VALUES (?, ?, ?, ?, ?)
    `);
    historicalRequests.forEach((r) => {
      const info = insReq.run(r.employeeId, r.dept, r.type, r.start, r.end, r.days, r.reason, r.status, nowIso());
      const reqId = Number(info.lastInsertRowid);
      r.trail.forEach((t) => insTrail.run(reqId, null, t.by, t.action, nowIso()));
    });
    console.log(`Seeded ${historicalRequests.length} historical leave requests.`);
  }

  const settingsCount = db.prepare(`SELECT COUNT(*) c FROM settings WHERE key='noticeboard'`).get().c;
  if (settingsCount === 0) {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('noticeboard', ?)`).run(
      'Welcome to the Phoenix Leave Portal! Remember: leave requests need at least 2 working days notice where possible, and the leave year resets on 1 March.'
    );
  }

  console.log(`Seed complete: ${departments.length} departments, ${users.length} users, ${holidays.length} holidays.`);
}

if (require.main === module) {
  seed();
}

module.exports = { seed, emailFor };
