// Real, persistent database for the Phoenix Leave & Attendance Portal.
// Uses Node's built-in node:sqlite (no native compilation required — runs anywhere Node 22.5+ runs).
// The whole database lives in one file on disk (data/leave.db), so it survives restarts and deploys.
// This can be swapped for Postgres/MySQL later without changing the rest of the app much, since all
// access goes through the small set of functions in this file.

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'leave.db');

const db = new DatabaseSync(DB_PATH);
// WAL mode is preferable (better concurrent read/write) but isn't supported on every
// filesystem (e.g. some network-mounted or FUSE volumes) — fall back quietly if it fails
// rather than crashing the whole app on startup.
try {
  db.exec('PRAGMA journal_mode = WAL;');
} catch (err) {
  console.warn('WAL journal mode not supported on this filesystem, falling back to default:', err.message);
}
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  dept_id TEXT REFERENCES departments(id),
  role TEXT NOT NULL DEFAULT 'staff',       -- 'staff' | 'manager' | 'director'
  title TEXT,
  entitlement REAL NOT NULL DEFAULT 15,
  used REAL NOT NULL DEFAULT 0,
  pending REAL NOT NULL DEFAULT 0,
  approver1 TEXT REFERENCES users(id),
  approver2 TEXT REFERENCES users(id),
  approver3 TEXT REFERENCES users(id),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS holidays (
  date TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id TEXT NOT NULL REFERENCES users(id),
  dept_id TEXT REFERENCES departments(id),
  type TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  days REAL NOT NULL,
  reason TEXT,
  doc_filename TEXT,
  status TEXT NOT NULL DEFAULT 'pending_1',  -- pending_1 | pending_2 | approved | rejected
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approval_trail (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES leave_requests(id),
  by_user_id TEXT,
  by_name TEXT NOT NULL,
  action TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT,
  actor_name TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  code TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS escalation_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
        start_date TEXT NOT NULL,
          end_date TEXT NOT NULL,
            days REAL NOT NULL,
              reason TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                  requested_at TEXT NOT NULL,
                    decided_at TEXT,
                      decided_by TEXT,
                        approved_at TEXT,
                          expires_at TEXT
                          );
`);

// Columns/tables added after initial launch. SQLite's ALTER TABLE ADD COLUMN has no "IF NOT
// EXISTS" form, so this guards each one with try/catch and swallows only the "already there"
// error, meaning it's safe to run on every boot regardless of whether this is a brand new
// database or one that already has the column from a previous deploy.
function addColumnIfMissing(table, columnDef) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  } catch (err) {
    if (!/duplicate column name/i.test(err.message)) throw err;
  }
}
addColumnIfMissing('users', 'hire_date TEXT');
addColumnIfMissing('users', 'contract_months INTEGER');
addColumnIfMissing('leave_requests', 'escalation_id INTEGER REFERENCES escalation_requests(id)');
// Tracks the last time each employee was sent a year-end forfeiture reminder (src/forfeiture.js).
// NULL means "not reminded yet this leave year" — reset back to NULL for everyone by the same
// 1 March rollover cron (server.js) that forfeits the unused balance, so the reminder cycle
// starts fresh for the new leave year rather than staying permanently "already sent".
addColumnIfMissing('users', 'forfeiture_reminder_sent_at TEXT');

// One-off email corrections supplied by the CEO (Aug 2026). A few operations/warehouse staff
// don't have individual company inboxes and share one with a colleague — a "+name" tag keeps
// each row's email unique (required for login-by-email to resolve to the right person) while
// mail for the whole group still lands in that one shared inbox. Matches on the old (wrong)
// address, so once applied this is a no-op on every future boot.
const emailCorrections = [
    ['eseshibe@phoenixintl.co.za', 'vgovender+eunice@phoenixintl.co.za'],
    ['ismith@phoenixintl.co.za', 'ian@phoenixintl.co.za'],
    ['ichemwaita@phoenixintl.co.za', 'cmelnick+imagine@phoenixintl.co.za'],
    ['jseshibe@phoenixintl.co.za', 'vgovender+joseph@phoenixintl.co.za'],
    ['mndlovu@phoenixintl.co.za', 'vgovender+maxwell@phoenixintl.co.za'],
    ['tnkuna@phoenixintl.co.za', 'vgovender+trevor@phoenixintl.co.za'],
    ['tmelnick@phoenixintl.co.za', 'tristan@phoenixintl.co.za'],
    ['wmkumbuzi@phoenixintl.co.za', 'vgovender+wilfred@phoenixintl.co.za'],
  ];
const updateEmail = db.prepare('UPDATE users SET email=? WHERE email=?');
for (const [oldEmail, newEmail] of emailCorrections) {
    updateEmail.run(newEmail, oldEmail);
}
db.prepare(`UPDATE users SET name='Marishka Darman' WHERE email='mdarman@phoenixintl.co.za' AND name != 'Marishka Darman'`).run();

module.exports = db;
