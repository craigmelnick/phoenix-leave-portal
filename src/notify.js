// Notification fan-out on final approval: the whole department gets told someone will be out,
// the two people who actually approved it get a "diary" note, and the CEO always gets an
// oversight log entry even if they weren't one of the approvers. Mirrors the prototype's
// notifyOnApproval() logic exactly, against the real database.

// Fired the moment a request first needs a decision — either right after submission (approver 1)
// or right after step 1 is approved (approver 2 / approver 3 pool). Without this, an approver has
// no way of knowing a request is waiting on them until they happen to check the app.
function notifyApprovalNeeded(request, employee, approverId) {
    if (!approverId) return;
    const dept = request.dept_id ? db.prepare('SELECT * FROM departments WHERE id = ?').get(request.dept_id) : null;
    const dateRange = fmtDate(request.start_date) + (request.start_date !== request.end_date ? ' – ' + fmtDate(request.end_date) : '');
    pushNotification(
          approverId,
          `${employee.name}${dept ? ' (' + dept.name + ')' : ''} has requested ${request.days} day(s) of ${request.type} leave, ${dateRange}, and it's waiting on your approval.`
        );
}

const db = require('./db');
const { fmtDate, getCeoId, nowIso } = require('./helpers');
const { sendNotificationEmail } = require('./email');

function pushNotification(userId, text) {
  db.prepare('INSERT INTO notifications (user_id, text, read, created_at) VALUES (?, ?, 0, ?)').run(userId, text, nowIso());
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(userId);
  if (user) sendNotificationEmail(user.email, 'Phoenix Leave Portal notification', text).catch((e) => console.error('Notification email failed:', e.message));
}

function notifyOnApproval(request, employee) {
  const dept = request.dept_id ? db.prepare('SELECT * FROM departments WHERE id = ?').get(request.dept_id) : null;
  const dateRange = fmtDate(request.start_date) + (request.start_date !== request.end_date ? ' – ' + fmtDate(request.end_date) : '');
  const trail = db.prepare('SELECT * FROM approval_trail WHERE request_id = ?').all(request.id);
  const approverNames = trail.filter((t) => t.action.indexOf('approved') === 0).map((t) => t.by_name);

  const alreadyNotified = new Set();

  if (dept) {
    const deptUsers = db.prepare('SELECT * FROM users WHERE dept_id = ? AND id != ? AND active = 1').all(dept.id, employee.id);
    deptUsers.forEach((u) => {
      pushNotification(u.id, `${employee.name} will be on leave ${dateRange} (${request.type}). Their department has been notified.`);
      alreadyNotified.add(u.id);
    });
  }

  const allUsers = db.prepare('SELECT * FROM users WHERE active = 1').all();
  allUsers.forEach((u) => {
    if (approverNames.includes(u.name) && !alreadyNotified.has(u.id) && u.id !== employee.id) {
      pushNotification(u.id, `Diary note: ${employee.name} will be on leave ${dateRange} (${request.type}) — you approved this request.`);
      alreadyNotified.add(u.id);
    }
  });

  const ceoId = getCeoId();
  if (ceoId && !alreadyNotified.has(ceoId)) {
    pushNotification(ceoId, `${employee.name}${dept ? ' (' + dept.name + ')' : ''} — ${request.days} day(s) ${request.type} leave approved for ${dateRange}.`);
  }
}

module.exports = { pushNotification, notifyOnApproval, notifyApprovalNeeded };
