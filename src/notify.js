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
const { fmtDate, getCeoId, nowIso, randomQuote, buildCertificateData, renderCertificateHtml } = require('./helpers');
const { sendNotificationEmail, sendCertificateEmail } = require('./email');

// Every notification always gets its in-app record (the bell icon), regardless of whether the
// email send succeeds — so nobody misses something waiting on them just because SMTP hiccuped.
// If the email itself fails, that failure is written to the audit log (visible under Audit log
// in the admin section) instead of only going to the server console, which nobody can see on a
// live Render deployment. That way a silent delivery failure like a bounce or spam-block shows
// up as a first-class, CEO-visible event instead of vanishing.
function pushNotification(userId, text) {
  db.prepare('INSERT INTO notifications (user_id, text, read, created_at) VALUES (?, ?, 0, ?)').run(userId, text, nowIso());
  const user = db.prepare('SELECT email, name FROM users WHERE id = ?').get(userId);
  if (user) {
    sendNotificationEmail(user.email, 'Phoenix Leave Portal notification', text).catch((e) => {
      console.error('Notification email failed:', e.message);
      try {
        db.prepare('INSERT INTO audit_log (actor_id, actor_name, action, detail, at) VALUES (?, ?, ?, ?, ?)').run(
          null,
          'System',
          'notification_email_failed',
          `Email to ${user.name} (${user.email}) could not be sent: ${e.message}`,
          nowIso()
        );
      } catch (_) { /* best effort - never let logging break the request */ }
    });
  }
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

// Tells the employee themselves that their own leave was approved — notifyOnApproval() above
// deliberately excludes the employee from all three of its notification loops (it's written for
// telling everyone ELSE), so without this the person who actually asked for the leave never
// heard back. Includes a rotating motivational quote and a genuine thank-you, since this is the
// one notification in the whole system that's actually good news for the person receiving it.
function notifyEmployeeApproved(request, employee) {
  const dateRange = fmtDate(request.start_date) + (request.start_date !== request.end_date ? ' – ' + fmtDate(request.end_date) : '');
  const message = `Good news, ${employee.name.split(' ')[0]} — your ${request.type} leave for ${dateRange} (${request.days} day(s)) has been approved. Thank you for all your hard work — enjoy your well-earned break! "${randomQuote()}"`;
  pushNotification(employee.id, message);
  emailCertificate(request, employee);
}

// Emails the employee their leave certificate the moment their request is finally approved —
// separate from the in-app "good news" notification above, since that one just needs to be
// seen, while this is a proper keepsake document worth having in an inbox. Best-effort: a
// failure here must never break the approval flow itself, so it's logged to the audit trail
// (same pattern as pushNotification's own email failures) rather than thrown.
function emailCertificate(request, employee) {
  try {
    const cert = buildCertificateData(request.id);
    if (!cert) return;
    const html = renderCertificateHtml(cert);
    const text = `Your ${cert.type} leave certificate (${cert.refNo}) for ${cert.dateRange} is attached in this email. Approved by: ${cert.approvedBy}. Remaining balance: ${cert.remainingBalance} of ${cert.entitlement} day(s) this leave year.`;
    sendCertificateEmail(employee.email, employee.name, `Your leave certificate — ${cert.refNo}`, html, text).catch((e) => {
      console.error('Certificate email failed:', e.message);
      try {
        db.prepare('INSERT INTO audit_log (actor_id, actor_name, action, detail, at) VALUES (?, ?, ?, ?, ?)').run(
          null,
          'System',
          'notification_email_failed',
          `Certificate email to ${employee.name} (${employee.email}) could not be sent: ${e.message}`,
          nowIso()
        );
      } catch (_) { /* best effort - never let logging break the request */ }
    });
  } catch (e) {
    console.error('Certificate build failed:', e.message);
  }
}

module.exports = { pushNotification, notifyOnApproval, notifyApprovalNeeded, notifyEmployeeApproved };
