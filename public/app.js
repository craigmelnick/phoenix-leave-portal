/* Phoenix Leave & Attendance Portal — real client, talking to the Express + SQLite API.
   Same visual design as the earlier prototype; every view now fetches real, persistent data
   instead of reading from in-memory JS arrays. */

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const AVATAR_PALETTE = ['#0d9488','#2563eb','#7c3aed','#db2777','#ea580c','#16a34a','#0891b2'];

let user = null;
let currentView = 'dashboard';
let certificateReqId = null;
let calMode = 'year';
let calMonthIdx = new Date().getMonth();
let calYear = new Date().getFullYear();
let pendingEmail = null;
let devOtp = null;
let roster = [];
let adminDirty = false;

/* ---------------- API helper ---------------- */

async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || 'Something went wrong.');
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------------- Helpers ---------------- */

function fmtDate(iso) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
}
// Escapes free-text fields (leave reason, noticeboard message, uploaded filenames) before they're
// inserted into innerHTML - without this, someone typing something like <img src=x onerror=...>
// into the Reason box would have it executed as real HTML for every approver, department
// colleague and admin who later views that request. Everything else in the UI (names, dates,
// statuses) comes from the roster or the server's own generated strings, not raw user input.
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function avatarColorFor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}
function avatarHtml(name) {
  const initials = name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return `<span class="avatar" style="background:${avatarColorFor(name)}">${initials}</span>`;
}
function statusLabel(s) {
  return { pending_1: 'Pending 1st approval', pending_2: 'Pending 2nd approval', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled' }[s] || s;
}

/* ---------------- Login / OTP ---------------- */

function renderLogin() {
  document.getElementById('loginScreen').style.display = 'flex';
  let html = `<div class="login-card">
    <span class="login-mark"><img src="/assets/logo-icon.jpg" alt=""></span>
    <h2>Phoenix Leave Portal</h2>`;
  if (!pendingEmail) {
    html += `<p>Sign in to manage your leave.</p>
          <div class="login-field"><label>Your name</label>
                  <select id="loginName">
                            <option value="">Select your name…</option>
                                      ${roster.map((u) => `<option value="${u.email}">${u.name}</option>`).join('')}
                                              </select>
                                                    </div>
                                                          <div class="otp-demo-note">We'll email you a one-time code — it's free to send and everyone already has a company inbox, so there's nothing to install and no per-message cost.</div>
                                                                <div id="loginError" style="color:var(--red);font-size:12.5px;margin-bottom:6px;min-height:16px;"></div>
                                                                      <button class="btn full" onclick="requestOtp()">Email me a code</button>`;
  } else {
    html += `<p>Enter the 4-digit code sent to<br><b>${pendingEmail}</b>.</p>`;
    if (devOtp) {
      html += `<div class="otp-demo-note">Dev mode: SMTP isn't configured on this server yet, so no real email was sent. Your code is <b>${devOtp}</b> — set SMTP_HOST etc. in .env to send real emails.</div>`;
    }
    html += `<div class="login-field"><input id="otpInput" class="otp-input" maxlength="4" inputmode="numeric" placeholder="••••"></div>
      <div id="otpError" style="color:var(--red);font-size:12.5px;margin-bottom:6px;min-height:16px;"></div>
      <button class="btn full" style="margin-bottom:8px;" onclick="verifyOtp()">Verify &amp; sign in</button>
      <button class="btn secondary full" onclick="backToStep1()">‹ Back</button>`;
  }
  html += `</div>`;
  document.getElementById('loginScreen').innerHTML = html;
}

async function requestOtp() {
  const email = document.getElementById('loginName').value.trim();
  if (!email) { document.getElementById('loginError').textContent = 'Please select your name.'; return; }
  try {
    const result = await api('/auth/request-otp', { method: 'POST', body: { email } });
    pendingEmail = email;
    devOtp = result.devCode || null;
    renderLogin();
  } catch (e) {
    document.getElementById('loginError').textContent = e.message;
  }
}

async function verifyOtp() {
  const code = document.getElementById('otpInput').value.trim();
  try {
    const result = await api('/auth/verify-otp', { method: 'POST', body: { email: pendingEmail, code } });
    user = result.user;
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    currentView = 'dashboard';
    render();
  } catch (e) {
    document.getElementById('otpError').textContent = e.message;
  }
}

function backToStep1() { pendingEmail = null; devOtp = null; renderLogin(); }

async function logout() {
  if (!confirm('Log out?')) return;
  await api('/auth/logout', { method: 'POST' });
  user = null;
  pendingEmail = null;
  document.getElementById('app').style.display = 'none';
  renderLogin();
}

/* ---------------- Nav ---------------- */

function navItemsFor(u) {
  const items = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'request', label: 'Request leave' },
    { id: 'myrequests', label: 'My requests' },
    { id: 'details', label: 'My details' },
  ];
  if (u.isApprover || u.role === 'director') items.push({ id: 'approvals', label: 'Approvals' });
  items.push({ id: 'teamcal', label: 'Team calendar' });
  items.push({ id: 'notifications', label: 'Notifications' });
  if (u.role === 'director' || u.role === 'manager') items.push({ id: 'admin', label: 'Admin settings' });
  if (u.role === 'director') items.push({ id: 'audit', label: 'Audit log' });
  items.push({ id: 'ideas', label: 'Platform ideas' });
  return items;
}

function renderNav() {
  const nav = document.getElementById('nav');
  nav.innerHTML = '';
  navItemsFor(user).forEach((item) => {
    const el = document.createElement('div');
    el.className = 'nav-item' + (currentView === item.id ? ' active' : '');
    el.innerHTML = `<span class="icon-circle"><img src="/assets/logo-icon.jpg" alt=""></span>${item.label}`;
    el.onclick = () => navigateTo(item.id);
    nav.appendChild(el);
  });
}

function renderBottomNav() {
  const bar = document.getElementById('bottomNav');
  bar.innerHTML = '';
  navItemsFor(user).forEach((item) => {
    const el = document.createElement('div');
    el.className = 'bottom-nav-item' + (currentView === item.id ? ' active' : '');
    el.innerHTML = `<span class="icon-circle"><img src="/assets/logo-icon.jpg" alt=""></span>${item.label}`;
    el.onclick = () => navigateTo(item.id);
    bar.appendChild(el);
  });
}

function renderTopbarMeta() {
  const dateEl = document.getElementById('topbarDate');
  dateEl.textContent = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }).toUpperCase();
  const avatar = document.getElementById('accountAvatar');
  const initials = user.name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  avatar.textContent = initials;
  avatar.style.background = avatarColorFor(user.name);
  avatar.title = user.name + ' — log out';
}

async function renderBell() {
  try {
    const { count } = await api('/notifications/unread-count');
    const badge = document.getElementById('bellBadge');
    if (count > 0) { badge.style.display = 'inline-block'; badge.textContent = count; }
    else { badge.style.display = 'none'; }
  } catch (e) { /* ignore */ }
  document.getElementById('bellBtn').onclick = () => { currentView = 'notifications'; render(); };
}

/* ---------------- Views ---------------- */

function balanceCard(label, icon, color, ent, used, pending, available, accrued, advanceTaken) {
  const usedPct = ent > 0 ? Math.min(100, (used / ent) * 100) : 0;
   const accruedLine = accrued != null
       ? `<div class="balance-foot"><span>${accrued} of ${ent} accrued so far</span></div>`
          : '';
     const advanceLine = advanceTaken > 0
         ? `<div class="balance-foot" style="color:#b45309;"><span>⚠ ${advanceTaken} advance day(s) taken (not yet earned)</span></div>`
              : '';
  return `<div class="balance-card">
    <div class="balance-top"><span class="balance-label">${label}</span><span class="balance-icon" style="background:${color}22;color:${color}">${icon}</span></div>
    <div class="balance-num">${available}</div>
    <div class="balance-sub">days available</div>
    <div class="balance-bar"><div class="balance-bar-fill" style="width:${usedPct}%;background:${color}"></div></div>
    <div class="balance-foot"><span>${used} used</span><span>${pending} pending</span></div>
    ${accruedLine}
      ${advanceLine}
  </div>`;
}

async function viewDashboard() {
  const d = await api('/dashboard');
  let html = `<div class="hero">
    <p class="hero-eyebrow">Phoenix International Logistics</p>
    <h2>Welcome, ${d.firstName}</h2>
    <p>${d.heroLine}</p>
    ${d.quote ? `<p class="hero-quote" style="font-style:italic;opacity:.85;margin:6px 0 18px;font-size:13.5px;">\u201c${d.quote}\u201d</p>` : ''}
    <button class="hero-btn" onclick="currentView='request'; render();">Request leave &nbsp;+</button>
  </div>`;

  html += `<div class="balance-grid">`;
  html += balanceCard('Annual leave', '☀️', '#0090bd', d.balances.annual.entitlement, d.balances.annual.used, d.balances.annual.pending, d.balances.annual.available, d.balances.annual.accrued, d.balances.annual.advanceTaken);
  html += balanceCard('Sick leave', '✚', '#dc2626', d.balances.sick.entitlement, d.balances.sick.used, d.balances.sick.pending, d.balances.sick.available);
  html += balanceCard('Family responsibility', '♥', '#d97706', d.balances.family.entitlement, d.balances.family.used, d.balances.family.pending, d.balances.family.available);
  html += `</div>`;

  html += `<div class="info-box">Leave year: <b>${fmtDate(d.leaveYear.start)} – ${fmtDate(d.leaveYear.end)}</b>. Unused days do not carry over — any balance left on ${fmtDate(d.leaveYear.end)} is forfeited.</div>`;

  if (d.yearEndReminder) {
    html += `<div class="warn-box">⏰ Year-end reminder: you still have ${d.yearEndReminder} day(s) of annual leave unused, and it will be forfeited on ${fmtDate(d.leaveYear.end)}. Book it before then.</div>`;
  }

  html += `<div class="panel"><h2>Noticeboard</h2><p style="font-size:13.5px;color:var(--ink);margin:0;">${esc(d.noticeboard)}</p>`;
  if (user.role === 'director') {
    html += `<div style="margin-top:12px;">
      <textarea id="noticeboardInput" rows="2" style="width:100%;">${esc(d.noticeboard)}</textarea>
      <button class="btn secondary small" style="margin-top:8px;" onclick="saveNoticeboard()">Update noticeboard</button>
    </div>`;
  }
  html += `</div>`;

  html += `<div class="panel"><h2>Upcoming approved leave</h2>`;
  if (d.upcoming.length === 0) { html += `<div class="empty">No upcoming approved leave booked yet.</div>`; }
  else {
    html += `<div class="table-scroll"><table><tr><th>Type</th><th>From</th><th>To</th><th>Days</th></tr>`;
    d.upcoming.forEach((r) => html += `<tr><td>${r.type}</td><td>${fmtDate(r.start)}</td><td>${fmtDate(r.end)}</td><td>${r.days}</td></tr>`);
    html += `</table></div>`;
  }
  html += `</div>`;
  return html;
}

async function saveNoticeboard() {
  const message = document.getElementById('noticeboardInput').value;
  await api('/noticeboard', { method: 'POST', body: { message } });
  render();
}

function viewRequest() {
  const todayIso = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowIso = tomorrow.toISOString().slice(0, 10);
  return `<div class="panel"><h2>Request leave <span class="hint">Business days only — weekends &amp; public holidays are excluded automatically</span></h2>
      <p style="margin:-8px 0 16px;font-size:13.5px;color:var(--ink);">Applicant: <b>${user.name}</b></p>
      <div class="form-grid">
      <div class="form-field"><label>Leave type</label>
        <select id="reqType"><option>Annual</option><option>Sick</option><option>Family Responsibility</option><option>Study Leave</option><option>Maternity</option><option>Paternity</option><option>Unpaid</option></select>
      </div>
      <div class="form-field"><label>Available balance</label>
        <input id="reqAvailable" value="…" disabled>
      </div>
      <div class="form-field"><label>Start date</label>
        <input type="date" id="reqStart" value="${todayIso}">
      </div>
      <div class="form-field"><label>End date <span class="hint">the day you return to work — e.g. the 16th to the 19th is 3 days off</span></label>
        <input type="date" id="reqEnd" value="${tomorrowIso}">
      </div>
      <div class="form-field full"><label>Reason (optional)</label><textarea id="reqReason" rows="2" placeholder="e.g. family trip, medical appointment..."></textarea></div>
      <div class="form-field full" id="docField" style="display:none;">
        <label id="docFieldLabel">Supporting document <span class="hint">e.g. a doctor's/sick note — optional, stored with the request</span></label>
        <input type="file" id="reqDoc" onchange="updateRequestPreview()">
      </div>
    </div>
    <div id="reqPreview" style="margin-top:14px;"></div>
    <div style="margin-top:14px;">
      <button class="btn" id="submitBtn" onclick="submitLeaveRequest()">Submit for approval</button>
    </div>
  </div>`;
}

function toggleDocField() {
  const type = document.getElementById('reqType').value;
  const needsDoc = ['Sick', 'Maternity', 'Paternity', 'Study Leave'].includes(type);
  document.getElementById('docField').style.display = needsDoc ? 'block' : 'none';
}

function readRequestDates() {
  const start = document.getElementById('reqStart').value;
  const end = document.getElementById('reqEnd').value;
  return { start, end };
}

async function updateRequestPreview() {
     const { start, end } = readRequestDates();
     const type = document.getElementById('reqType').value;
     const box = document.getElementById('reqPreview');
     const submitBtn = document.getElementById('submitBtn');
     const availableInput = document.getElementById('reqAvailable');
     window.activeEscalationId = null;
     window.sickNoteRequired = false;
     try {
            const p = new URLSearchParams({ start, end, type });
            const preview = await api('/leave-requests/preview?' + p.toString());
            if (availableInput) availableInput.value = preview.available + ' days';
            if (!preview.valid) {
                     box.innerHTML = `<div class="warn-box">⚠️ ${preview.message}</div>`;
                     if (submitBtn) submitBtn.disabled = true;
                     return;
            }
            let html = `<div class="info-box">This request is for <b>${preview.days} business day(s)</b>, ${fmtDate(start)} – ${fmtDate(end)}. Approval route: <b>${preview.flow}</b>.</div>`;

            if (preview.needsEscalation) {
                     const { escalations } = await api('/leave-requests/escalations/mine');
                     const match = escalations.find((e) => e.type === type && e.start === start && e.end === end);
                     if (match && match.status === 'approved') {
                                const hoursLeft = Math.max(0, Math.round((new Date(match.expiresAt) - new Date()) / 3600000));
                                html += `<div class="info-box">✅ The CEO approved booking this far ahead. You have about ${hoursLeft} hour(s) left to submit before this approval expires.</div>`;
                                window.activeEscalationId = match.id;
                                box.innerHTML = html;
                                if (submitBtn) submitBtn.disabled = false;
                                return;
                     }
                     if (match && match.status === 'pending') {
                                html += `<div class="warn-box">⏳ Waiting on the CEO to approve this escalation. You'll get a notification once it's decided.</div>`;
                                box.innerHTML = html;
                                if (submitBtn) submitBtn.disabled = true;
                                return;
                     }
                     html += `<div class="warn-box">🚫 Staff can only book up to 6 months in advance through the normal flow. This start date is beyond that window, so it needs the CEO's approval first.</div>
                             <div style="margin-top:8px;"><button class="btn secondary small" type="button" onclick="escalateRequest()">Escalate to management</button></div>`;
                     box.innerHTML = html;
                     if (submitBtn) submitBtn.disabled = true;
                     return;
            }

            if (preview.exceedsBalance) {
                     html += `<div class="warn-box">⚠️ This exceeds your available balance of ${preview.available} day(s).</div>`;
            }
            if (preview.blocked) {
                     html += `<div class="warn-box">🚫 Not permitted — only one person per department may be on leave at a time. ${preview.overlapNames.join(', ')} already ${preview.overlapNames.length > 1 ? 'have' : 'has'} approved or pending leave during this period. Please choose different dates.</div>`;
            }

            let docMissing = false;
            const docLabel = document.getElementById('docFieldLabel');
            if (preview.sickNoteRequired) {
                     window.sickNoteRequired = true;
                     const hasDoc = document.getElementById('reqDoc') && document.getElementById('reqDoc').files.length > 0;
                     if (docLabel) docLabel.innerHTML = `Supporting document <span class="hint" style="color:#b45309;">required — this sick leave is next to a weekend or public holiday, so a doctor's note is needed</span>`;
                     if (!hasDoc) {
                                docMissing = true;
                                html += `<div class="warn-box">🩺 This sick leave starts or ends right next to a weekend or public holiday, so a doctor's note is required before you can submit — please attach one above.</div>`;
                     }
            } else if (docLabel) {
                     docLabel.innerHTML = `Supporting document <span class="hint">e.g. a doctor's/sick note — optional, stored with the request</span>`;
            }

            box.innerHTML = html;
            if (submitBtn) submitBtn.disabled = preview.blocked || docMissing;
     } catch (e) {
            box.innerHTML = `<div class="warn-box">⚠️ ${e.message}</div>`;
     }
}

async function escalateRequest() {
     const type = document.getElementById('reqType').value;
     const { start, end } = readRequestDates();
     const reason = document.getElementById('reqReason').value;
     try {
            await api('/leave-requests/escalate', { method: 'POST', body: { type, start, end, reason } });
            alert("Escalation request sent to the CEO for approval. You'll get a notification once it's decided, and then have 24 hours to submit the matching leave request.");
            updateRequestPreview();
     } catch (e) {
            alert(e.message);
     }
}

async function submitLeaveRequest() {
  const type = document.getElementById('reqType').value;
  const { start, end } = readRequestDates();
  const reason = document.getElementById('reqReason').value;
  const docInput = document.getElementById('reqDoc');
  const docFilename = docInput && docInput.files.length > 0 ? docInput.files[0].name : null;
  try {
        const result = await api('/leave-requests', { method: 'POST', body: { type, start, end, reason, docFilename, escalationId: window.activeEscalationId || undefined } });
    alert(`Request submitted: ${result.days} day(s) of ${type} leave, ${fmtDate(start)} – ${fmtDate(end)}. Status: ${statusLabel(result.status)}.`);
    currentView = 'myrequests';
    render();
  } catch (e) {
    alert(e.message);
  }
}

async function viewMyRequests() {
  const { requests } = await api('/leave-requests/mine');
  let html = `<div class="panel"><h2>My requests</h2>`;
  if (requests.length === 0) { html += `<div class="empty">No leave requests yet.</div>`; }
  else {
    html += `<div class="table-scroll"><table><tr><th>Type</th><th>From</th><th>To</th><th>Days</th><th>Status</th><th>Notes</th><th>Audit trail</th><th></th></tr>`;
    requests.forEach((r) => {
      const trailText = r.trail.length ? r.trail.join('<br>') : '—';
      const docText = r.doc ? `<br><span style="color:var(--muted);">📎 ${esc(r.doc)}</span>` : '';
      const certBtn = r.status === 'approved' ? `<button class="btn small secondary" onclick="openCertificate(${r.id})">Certificate</button>` : '';
      const cancellable = ['pending_1', 'pending_2', 'approved'].includes(r.status);
      const cancelBtn = cancellable ? `<button class="btn small danger" onclick="cancelMyRequest(${r.id})" title="Withdraw this request">✕ Cancel</button>` : '';
      html += `<tr><td>${r.type}</td><td>${fmtDate(r.start)}</td><td>${fmtDate(r.end)}</td><td>${r.days}</td>
        <td><span class="pill ${r.status}">${r.statusLabel}</span></td><td style="color:var(--muted)">${r.reason ? esc(r.reason) : '—'}${docText}</td>
        <td style="font-size:11.5px;color:var(--muted);">${trailText}</td><td style="white-space:nowrap;">${certBtn} ${cancelBtn}</td></tr>`;
    });
    html += `</table></div>`;
  }
  html += `</div>`;
  return html;
}

async function cancelMyRequest(id) {
  if (!confirm('Cancel this leave request? Any used or pending days will be added back to your balance.')) return;
  try {
    await api(`/leave-requests/${id}/cancel`, { method: 'POST' });
    alert('Your request has been cancelled and your balance has been updated.');
    render();
  } catch (e) {
    alert(e.message);
  }
}

async function viewApprovals() {
  const { pending } = await api('/approvals/pending');
  let html = `<div class="panel"><h2>Awaiting your approval <span class="hint">Requests where you're assigned as an approver</span></h2>`;
  if (pending.length === 0) { html += `<div class="empty">Nothing waiting on you right now.</div>`; }
  else {
    html += `<div class="table-scroll"><table><tr><th>Employee</th><th>Type</th><th>From</th><th>To</th><th>Days</th><th>Reason</th><th></th></tr>`;
    pending.forEach((r) => {
      html += `<tr><td>${avatarHtml(r.employeeName)}${r.employeeName}</td><td>${r.type}</td><td>${fmtDate(r.start)}</td><td>${fmtDate(r.end)}</td><td>${r.days}</td><td style="color:var(--muted)">${r.reason ? esc(r.reason) : '—'}</td>
        <td style="white-space:nowrap;">
          <button class="btn small" onclick="actOnRequest(${r.id},'approve')">Approve</button>
          <button class="btn small danger" onclick="actOnRequest(${r.id},'reject')">Reject</button>
        </td></tr>`;
    });
    html += `</table></div>`;
  }
  html += `</div>`;

     if (user.role === 'director') {
            const { pending: escalations } = await api('/escalations/pending');
            html += `<div class="panel"><h2>Advance-leave escalations <span class="hint">Requests to book more than 6 months ahead — only you can approve these</span></h2>`;
            if (escalations.length === 0) { html += `<div class="empty">No pending escalation requests.</div>`; }
            else {
                     html += `<div class="table-scroll"><table><tr><th>Employee</th><th>Type</th><th>From</th><th>To</th><th>Days</th><th>Reason</th><th></th></tr>`;
                     escalations.forEach((e) => {
                                html += `<tr><td>${avatarHtml(e.employeeName)}${e.employeeName}</td><td>${e.type}</td><td>${fmtDate(e.start)}</td><td>${fmtDate(e.end)}</td><td>${e.days}</td><td style="color:var(--muted)">${e.reason ? esc(e.reason) : '—'}</td>
                                          <td style="white-space:nowrap;">
                                                      <button class="btn small" onclick="actOnEscalation(${e.id},'approve')">Approve</button>
                                                                  <button class="btn small danger" onclick="actOnEscalation(${e.id},'reject')">Reject</button>
                                                                            </td></tr>`;
                     });
                     html += `</table></div>`;
            }
            html += `</div>`;
     }
  return html;
}

async function actOnRequest(id, action) {
  try {
    const result = await api(`/leave-requests/${id}/${action}`, { method: 'POST' });
    alert(action === 'reject' ? 'Declined. A notification has been sent.' : `Approved (now: ${statusLabel(result.status)}). Notifications have been sent.`);
    render();
  } catch (e) {
    alert(e.message);
  }
}

async function actOnEscalation(id, action) {
     try {
            await api(`/escalations/${id}/${action}`, { method: 'POST' });
            alert(action === 'reject' ? 'Escalation declined. The employee has been notified.' : 'Escalation approved. The employee now has 24 hours to submit the matching leave request.');
            render();
     } catch (e) {
            alert(e.message);
     }
}

function monthGrid(year, month, monthData, compact) {
  const first = new Date(year, month, 1);
  const startOffset = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  const dayNames = compact ? ['M', 'T', 'W', 'T', 'F', 'S', 'S'] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  let html = `<div class="cal-grid ${compact ? 'compact' : ''}">`;
  dayNames.forEach((dn) => html += `<div class="cal-head ${compact ? 'compact' : ''}">${dn}</div>`);
  cells.forEach((d) => {
    if (d === null) { html += `<div class="cal-cell ${compact ? 'compact' : ''}" style="background:#f8fafc;"></div>`; return; }
    const info = (monthData && monthData.days && monthData.days[d]) || { isWeekend: false, isHoliday: false, entries: [] };
    html += `<div class="cal-cell ${compact ? 'compact' : ''} ${info.isWeekend ? 'weekend' : ''} ${info.isHoliday ? 'holiday' : ''}"><div class="daynum">${d}${(info.isHoliday && !compact) ? ' 🎌' : ''}</div>`;
    const typeColor = { Annual: '#0090bd', Sick: '#dc2626', Unpaid: '#64748b', 'Family Responsibility': '#d97706', 'Study Leave': '#7c3aed', Maternity: '#db2777', Paternity: '#16a34a' };
  if (compact) {
      html += `<div class="dot-wrap">`;
      info.entries.slice(0, 6).forEach((e) => {
        const color = e.status === 'approved' ? typeColor[e.type] : '#94a3b8';
        html += `<span class="dot-tag" style="background:${color}" title="${e.employeeName} — ${e.statusLabel}"></span>`;
      });
      html += `</div>`;
    } else {
      info.entries.slice(0, 3).forEach((e) => {
        const color = e.status === 'approved' ? typeColor[e.type] : '#94a3b8';
        html += `<span class="tag" style="background:${color}" title="${e.employeeName} — ${e.statusLabel}">${e.employeeName.split(' ')[0]}</span>`;
      });
      if (info.entries.length > 3) html += `<span class="tag" style="background:#334155;">+${info.entries.length - 3} more</span>`;
    }
    html += `</div>`;
  });
  html += `</div>`;
  return html;
}

async function viewTeamCal() {
  let html = `<div class="panel"><h2>Team calendar <span class="hint" id="calScopeLabel"></span></h2>
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:16px;">
      <div class="cal-toggle">
        <button class="btn secondary small ${calMode === 'year' ? 'active' : ''}" onclick="setCalMode('year')">12-month view</button>
        <button class="btn secondary small ${calMode === 'month' ? 'active' : ''}" onclick="setCalMode('month')">1-month view</button>
      </div>`;
  if (calMode === 'month') {
    html += `<div style="display:flex;align-items:center;gap:10px;">
        <button class="btn secondary small" onclick="shiftCalMonth(-1)">‹ Prev</button>
        <b>${MONTH_NAMES[calMonthIdx]} ${calYear}</b>
        <button class="btn secondary small" onclick="shiftCalMonth(1)">Next ›</button>
      </div>`;
  }
  html += `</div><div id="calBody">Loading…</div></div>`;
  setTimeout(loadCalendarBody, 0);
  return html;
}

async function loadCalendarBody() {
  const body = document.getElementById('calBody');
  if (!body) return;
  if (calMode === 'month') {
    const data = await api(`/calendar/month?year=${calYear}&month=${calMonthIdx}`);
    document.getElementById('calScopeLabel').textContent = data.scope;
    body.innerHTML = monthGrid(calYear, calMonthIdx, data, false);
  } else {
    let y = 2026, m = 2; // leave year starts March 2026, matching the company's leave-year convention
    let html = `<div class="year-grid">`;
    const months = [];
    for (let i = 0; i < 12; i++) { months.push({ y, m }); m++; if (m > 11) { m = 0; y++; } }
    const results = await Promise.all(months.map((mm) => api(`/calendar/month?year=${mm.y}&month=${mm.m}`)));
    document.getElementById('calScopeLabel').textContent = results[0] ? results[0].scope : '';
    months.forEach((mm, i) => {
      html += `<div class="month-block"><h4>${MONTH_NAMES[mm.m]} ${mm.y}</h4>${monthGrid(mm.y, mm.m, results[i], true)}</div>`;
    });
    html += `</div>`;
    body.innerHTML = html;
  }
}

function setCalMode(mode) { calMode = mode; render(); }
function shiftCalMonth(delta) {
  calMonthIdx += delta;
  if (calMonthIdx > 11) { calMonthIdx = 0; calYear++; }
  if (calMonthIdx < 0) { calMonthIdx = 11; calYear--; }
  render();
}

async function viewNotifications() {
  const { notifications } = await api('/notifications');
  let html = `<div class="panel"><h2>Notifications <span class="hint">Read-only — informational, no action required</span></h2>`;
  if (notifications.length === 0) { html += `<div class="empty">No notifications yet.</div>`; }
  else { notifications.forEach((n) => html += `<div class="notif-item"><div class="notif-dot"></div><div>${esc(n.text)}</div></div>`); }
  html+= `</div>`;
  return html;
}

function approverOptions(options, excludeId, selected) {
  let opts = `<option value="" ${!selected ? 'selected' : ''}>— None (defaults to CEO) —</option>`;
  options.filter((u) => u.id !== excludeId).forEach((u) => {
    opts += `<option value="${u.id}" ${u.id === selected ? 'selected' : ''}>${u.name}</option>`;
  });
  return opts;
}

async function viewAdmin() {
  adminDirty = false;
  let html = '';

  if (user.role === 'director') {
    const { requests: pendingDetailRequests } = await api('/details/change-requests/pending').catch(() => ({ requests: [] }));
    if (pendingDetailRequests.length) {
      html += `<div class="panel"><h2>Pending ID & banking detail changes</h2><p class="hint" style="margin:4px 0 10px;">These changes only take effect once you approve them.</p><div class="table-scroll"><table><tr><th>Employee</th><th>Field</th><th>Current</th><th>Requested</th><th>Requested on</th><th></th></tr>` +
        pendingDetailRequests.map((r) => `<tr><td>${avatarHtml(r.employeeName)}${esc(r.employeeName)}</td><td>${esc(r.field_label)}</td><td>${esc(r.old_value || '—')}</td><td><b>${esc(r.new_value)}</b></td><td>${fmtDateTime(r.requested_at)}</td><td><button class="btn" style="padding:4px 10px;font-size:13px;" onclick="decideDetailChange(${r.id},'approve')">Approve</button> <button class="btn" style="padding:4px 10px;font-size:13px;background:var(--danger,#c0392b);margin-left:6px;" onclick="decideDetailChange(${r.id},'reject')">Reject</button></td></tr>`).join('') +
        `</table></div></div>`;
    }
    html += `<div class="panel" id="adminSaveBar" style="position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
      <span style="font-size:13px;color:var(--muted);" id="adminDirtyLabel">All changes saved.</span>
      <button class="btn" id="adminSaveBtn" onclick="manualSaveAdmin()">Save changes</button>
    </div>`;
    const { options, employees } = await api('/admin/approvers');
    html += `<div class="panel"><h2>Approver assignments <span class="hint">Only you can set this — who signs off each person's leave</span></h2>
      <p style="font-size:12.5px;color:var(--muted);margin:-4px 0 8px;">Approver 1 must sign off first. Approver 2 (and optional Approver 3, for extra cover if one is off) sign off second — either is enough. Leave Approver 2 blank to send the second step straight to you.</p>
      <div class="table-scroll"><table><tr><th>Employee</th><th>Approver 1</th><th>Approver 2</th><th>Approver 3 (backup)</th></tr>`;
    employees.forEach((e) => {
      html += `<tr>
        <td>${avatarHtml(e.name)}${e.name}</td>
        <td><select id="app1_${e.id}" onchange="markAdminDirty()">${approverOptions(options, e.id, e.approver1)}</select></td>
        <td><select id="app2_${e.id}" onchange="markAdminDirty()">${approverOptions(options, e.id, e.approver2)}</select></td>
        <td><select id="app3_${e.id}" onchange="markAdminDirty()">${approverOptions(options, e.id, e.approver3)}</select></td>
      </tr>`;
    });
    html += `</table></div></div>`;

    const { employees: allEmp } = await api('/admin/employees');
    html += `<div class="panel"><h2>User roles <span class="hint">Set who has admin (CEO/Director) access vs a regular staff account</span></h2>
      <div class="table-scroll"><table><tr><th>Employee</th><th>Role</th></tr>`;
    allEmp.forEach((e) => {
      html += `<tr>
        <td>${avatarHtml(e.name)}${e.name}</td>
        <td><select id="role_${e.id}" onchange="markAdminDirty()">
          <option value="staff" ${e.role === 'staff' ? 'selected' : ''}>Regular user</option>
          <option value="manager" ${e.role === 'manager' ? 'selected' : ''}>Manager (approver)</option>
          <option value="director" ${e.role === 'director' ? 'selected' : ''}>Admin (Director / CEO)</option>
        </select></td>
      </tr>`;
    });
    html += `</table></div></div>`;

    const { departments: newEmpDepts } = await api('/admin/employees');
    html += `<div class="panel"><h2>Add employee</h2><div class="form-grid">
      <div class="form-field"><label>Employee ID</label><input id="newEmpId" placeholder="e.g. jsmith"></div>
      <div class="form-field"><label>Full name</label><input id="newEmpName"></div>
      <div class="form-field"><label>Email</label><input id="newEmpEmail" type="email"></div>
      <div class="form-field"><label>Department</label><select id="newEmpDept"><option value="">—</option>${newEmpDepts.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
      <div class="form-field"><label>Title</label><input id="newEmpTitle"></div>
      <div class="form-field"><label>Role</label><select id="newEmpRole"><option value="staff">Staff</option><option value="manager">Manager (approver)</option><option value="director">Admin (Director / CEO)</option></select></div>
      <div class="form-field"><label>Annual entitlement (days)</label><input id="newEmpEnt" type="number" step="0.5" value="15"></div>
      <div class="form-field"><label>Hire date</label><input id="newEmpHire" type="date"></div>
      <div class="form-field"><label>Contract length (months, optional)</label><input id="newEmpContract" type="number"></div>
    </div><button class="btn" style="margin-top:10px;" onclick="addEmployee()">Add employee</button></div>`;

    const { requests: allReqs } = await api('/admin/leave-requests');
    html += `<div class="panel"><h2>All leave requests <span class="hint">Cancel any request company-wide — the employee is notified automatically</span></h2>`;
    if (allReqs.length === 0) { html += `<div class="empty">No active leave requests.</div>`; }
    else {
      html += `<div class="table-scroll"><table><tr><th>Employee</th><th>Type</th><th>From</th><th>To</th><th>Days</th><th>Status</th><th></th></tr>`;
      allReqs.forEach((r) => {
        html += `<tr><td>${avatarHtml(r.employeeName)}${r.employeeName}</td><td>${r.type}</td><td>${fmtDate(r.start)}</td><td>${fmtDate(r.end)}</td><td>${r.days}</td>
          <td><span class="pill ${r.status}">${r.statusLabel}</span></td>
          <td><button class="btn small danger" onclick="adminCancelRequest(${r.id})" title="Cancel this leave request">✕ Cancel</button></td></tr>`;
      });
      html += `</table></div>`;
    }
    html += `</div>`;
  } else {
    html += `<div class="info-box">Only the CEO can view or change who approves each person's leave, assign user roles, or cancel someone else's leave request.</div>`;
  }

  const report = await api('/admin/report');
  html += `<div class="cards-row">
    <div class="card"><h3>Open requests</h3><div class="big">${report.pendingCount}</div><div class="sub">across all departments</div></div>
    <div class="card"><h3>Approved days (YTD)</h3><div class="big">${report.approvedDays}</div><div class="sub">this leave year</div></div>
    <div class="card"><h3>Headcount</h3><div class="big">${report.headcount}</div><div class="sub">across ${report.departmentCount} departments</div></div>
  </div>`;

  html += `<div class="panel"><h2>Approved days by department</h2><div class="table-scroll"><table><tr><th>Department</th><th>Headcount</th><th>Approved days (YTD)</th><th>Open requests</th></tr>`;
  report.departments.forEach((d) => {
    html += `<tr><td><b>${d.name}</b></td><td>${d.headcount}</td><td>${d.approvedDays}</td><td>${d.openRequests}</td></tr>`;
  });
  html += `</table></div></div>`;

  if (user.role === 'manager') {
    const { requests: allReqsForManager } = await api('/admin/leave-requests');
    html += `<div class="panel"><h2>All leave requests <span class="hint">View only — the CEO can cancel a request</span></h2>`;
    if (allReqsForManager.length === 0) { html += `<div class="empty">No active leave requests.</div>`; }
    else {
      html += `<div class="table-scroll"><table><tr><th>Employee</th><th>Type</th><th>From</th><th>To</th><th>Days</th><th>Status</th></tr>`;
      allReqsForManager.forEach((r) => {
        html += `<tr><td>${avatarHtml(r.employeeName)}${r.employeeName}</td><td>${r.type}</td><td>${fmtDate(r.start)}</td><td>${fmtDate(r.end)}</td><td>${r.days}</td><td><span class="pill ${r.status}">${r.statusLabel}</span></td></tr>`;
      });
      html += `</table></div>`;
    }
    html += `</div>`;
  }

  if (user.role === 'director' || user.role === 'manager') {
    const { employees } = await api('/admin/entitlements');
    const canEditEntitlements = user.role === 'director';
    html += `<div class="panel"><h2>Employee entitlements <span class="hint">${canEditEntitlements ? 'Visible to you and department managers' : 'Visible to management — view only; the CEO makes any changes'}</span></h2><p class="hint" style="margin:4px 0 10px;">Annual entitlement is earned monthly in arrears from each person's hire date (reset to 1 March each leave year) — "Accrued to date" is what's actually available to take right now. Fixed-term contract staff stop accruing once their contract ends.</p><div class="table-scroll"><table><tr><th>Employee</th><th>Department</th><th>Since</th><th>Annual entitlement</th><th>Accrued to date</th><th>Used</th><th>Pending</th><th>Remaining</th></tr>`;
    employees.forEach((e) => {
           const since = e.hireDate ? fmtDate(e.hireDate) : '—';
           const contractNote = e.contractMonths ? `<div class="hint">${e.contractMonths}-month contract</div>` : '';
           const entCell = canEditEntitlements
             ? `<input type="number" id="ent_${e.id}" value="${e.entitlement}" step="0.5" style="width:70px;" oninput="markAdminDirty()">`
             : e.entitlement;
           html += `<tr><td>${avatarHtml(e.name)}${e.name}</td><td>${e.department}</td><td>${since}${contractNote}</td><td>${entCell}</td><td>${e.accrued}</td><td>${e.used}</td><td>${e.pending}</td><td><b style="color:var(--teal-dark)">${e.remaining}</b></td></tr>`;

    });
    html += `</table></div></div>`;
  } else {
    html += `<div class="info-box">Individual leave balances are only visible to management and to each employee for their own account — this keeps how much leave a colleague has earned private.</div>`;
  }
  return html;
}

function markAdminDirty() {
  adminDirty = true;
  const label = document.getElementById('adminDirtyLabel');
  if (label) { label.textContent = 'You have unsaved changes — click Save changes before leaving this screen.'; label.style.color = '#b45309'; }
}

async function saveAllAdminChanges() {
  const promises = [];
  document.querySelectorAll('[id^="app1_"]').forEach((el) => {
    const id = el.id.replace('app1_', '');
    const approver1 = document.getElementById('app1_' + id).value || null;
    const approver2 = document.getElementById('app2_' + id).value || null;
    const approver3 = document.getElementById('app3_' + id).value || null;
    promises.push(api(`/admin/approvers/${id}`, { method: 'POST', body: { approver1, approver2, approver3 } }));
  });
  document.querySelectorAll('[id^="role_"]').forEach((el) => {
    const id = el.id.replace('role_', '');
    promises.push(api(`/admin/employees/${id}`, { method: 'PUT', body: { role: el.value } }));
  });
  document.querySelectorAll('[id^="ent_"]').forEach((el) => {
    const id = el.id.replace('ent_', '');
    promises.push(api(`/admin/employees/${id}`, { method: 'PUT', body: { entitlement: Number(el.value) } }));
  });
  await Promise.all(promises);
  adminDirty = false;
}

async function manualSaveAdmin() {
  const btn = document.getElementById('adminSaveBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    await saveAllAdminChanges();
    render();
  } catch (e) {
    alert('Some changes failed to save: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Save changes'; }
  }
}

// Guards navigation away from the Admin screen while there are unsaved edits - the employee data
// (approvers, roles, entitlements) is sensitive enough that Craig wants an explicit choice every
// time, rather than changes silently getting lost by clicking to another tab.
function navigateTo(viewId) {
  if (currentView === 'admin' && adminDirty) {
    showLeaveAdminPrompt(viewId);
    return;
  }
  currentView = viewId;
  render();
}

function showLeaveAdminPrompt(nextView) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:999;display:flex;align-items:center;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:14px;padding:24px 26px;max-width:360px;box-shadow:0 12px 32px rgba(0,0,0,.25);">
      <h3 style="margin:0 0 8px;font-size:16px;">Save your changes?</h3>
      <p style="margin:0 0 18px;font-size:13.5px;color:var(--muted);">You've made changes on this screen that haven't been saved yet. Choose what you'd like to do before leaving.</p>
      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button class="btn secondary" id="lpDiscard">Don't save</button>
        <button class="btn" id="lpSave">Save changes</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  document.getElementById('lpSave').onclick = async () => {
    document.getElementById('lpSave').textContent = 'Saving…';
    try {
      await saveAllAdminChanges();
    } catch (e) {
      alert('Some changes failed to save: ' + e.message);
    }
    document.body.removeChild(overlay);
    adminDirty = false;
    currentView = nextView;
    render();
  };
  document.getElementById('lpDiscard').onclick = () => {
    document.body.removeChild(overlay);
    adminDirty = false;
    currentView = nextView;
    render();
  };
}

async function saveApprovers(userId) {
  const approver1 = document.getElementById('app1_' + userId).value || null;
  const approver2 = document.getElementById('app2_' + userId).value || null;
  const approver3 = document.getElementById('app3_' + userId).value || null;
  await api(`/admin/approvers/${userId}`, { method: 'POST', body: { approver1, approver2, approver3 } });
  alert('Approvers updated.');
  render();
}

async function saveRole(userId) {
  const role = document.getElementById('role_' + userId).value;
  await api(`/admin/employees/${userId}`, { method: 'PUT', body: { role } });
  alert('Role updated.');
  render();
}

async function adminCancelRequest(id) {
  if (!confirm('Cancel this leave request? The employee will be notified and any used/pending days will be restored to their balance.')) return;
  try {
    await api(`/admin/leave-requests/${id}/cancel`, { method: 'POST' });
    alert('Request cancelled and the employee has been notified.');
    render();
  } catch (e) {
    alert(e.message);
  }
}

async function saveEntitlement(userId) {
     const value = document.getElementById('ent_' + userId).value;
     await api(`/admin/employees/${userId}`, { method: 'PUT', body: { entitlement: Number(value) } });
     alert('Entitlement updated.');
     render();
}

function openCertificate(id) { certificateReqId = id; currentView = 'certificate'; render(); }

async function viewCertificate() {
  try {
    const c = await api(`/leave-requests/${certificateReqId}/certificate`);
    return `
      <div class="no-print" style="margin-bottom:14px;">
        <button class="btn secondary" onclick="currentView='myrequests'; render();">‹ Back to My requests</button>
        <button class="btn" onclick="window.print()" style="margin-left:8px;">🖨️ Print / Save as PDF</button>
      </div>
      <div class="certificate">
        <div class="cert-header">
          <img src="/assets/logo-icon.jpg" alt="" class="cert-logo">
          <div>
            <div class="cert-company">Phoenix International Logistics</div>
            <div class="cert-sub">Certificate of Approved Leave</div>
          </div>
        </div>
        <div class="cert-ref">Reference: ${c.refNo} &nbsp;•&nbsp; Issued: ${c.issuedDate}</div>
        <table class="cert-table">
          <tr><td>Employee</td><td><b>${c.employeeName}</b></td></tr>
          <tr><td>Department</td><td>${c.department}</td></tr>
          <tr><td>Leave type</td><td>${c.type}</td></tr>
          <tr><td>Dates</td><td><b>${c.dateRange}</b></td></tr>
          <tr><td>Business days</td><td>${c.days}</td></tr>
          <tr><td>Approved by</td><td>${c.approvedBy}</td></tr>
          <tr><td>Remaining balance after this leave</td><td><b>${c.remainingBalance} day(s)</b> of ${c.entitlement} entitlement, this leave year</td></tr>
        </table>
        <p class="cert-footnote">This certificate confirms the leave above has been approved in the Phoenix Leave &amp; Attendance Portal. Leave year runs ${fmtDate(c.leaveYear.start)} – ${fmtDate(c.leaveYear.end)}; unused days do not carry over.</p>
      </div>`;
  } catch (e) {
    return `<div class="panel"><div class="empty">${e.message}</div>
      <button class="btn secondary" onclick="currentView='myrequests'; render();">‹ Back to My requests</button></div>`;
  }
}

function auditActionLabel(action) {
  const map = {
    leave_request_submitted: 'Leave request submitted',
    leave_request_step1_approved: 'Leave request approved (step 1)',
    leave_request_approved: 'Leave request approved (final)',
    leave_request_rejected: 'Leave request declined',
    leave_request_cancelled: 'Leave request cancelled by employee',
    leave_request_admin_cancelled: 'Leave request cancelled by admin',
    leave_escalation_requested: 'Advance-leave escalation requested',
    leave_escalation_approved: 'Advance-leave escalation approved',
    leave_escalation_rejected: 'Advance-leave escalation declined',
    leave_year_rollover: 'Leave year rollover (forfeiture)',
    employee_added: 'Employee added',
    employee_updated: 'Employee record updated',
    approvers_updated: 'Approver chain updated',
    notification_email_failed: 'Notification email failed to send',
  };
  return map[action] || action;
}

function fmtDateTime(iso) {
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function viewAuditLog() {
  const { entries } = await api('/admin/audit-log');
  let html = `<div class="panel"><h2>Audit log <span class="hint">Every leave decision and admin action across every account, most recent first</span></h2>`;
  if (entries.length === 0) {
    html += `<div class="empty">No audit activity yet.</div>`;
  } else {
    html += `<div class="table-scroll"><table><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr>`;
    entries.forEach((e) => {
      html += `<tr>
        <td style="white-space:nowrap;color:var(--muted);font-size:12px;">${fmtDateTime(e.at)}</td>
        <td style="white-space:nowrap;">${avatarHtml(e.actor_name)}${e.actor_name}</td>
        <td>${auditActionLabel(e.action)}</td>
        <td style="color:var(--muted)">${esc(e.detail)}</td>
      </tr>`;
    });
    html += `</table></div>`;
  }
  html += `</div>`;
  return html;
}

function viewIdeas() {
  return `<div class="panel"><h2>Feature ideas from other leave platforms <span class="hint">researched from BambooHR, Personio, Deputy, Factorial, AttendanceBot</span></h2>
    <ul class="feature-list">
      <li><b>Team availability / conflict warnings</b> — flags when teammates in the same department are already off during the requested dates.</li>
      <li><b>Per-person approver assignment</b> — the CEO personally assigns up to three approvers for each employee.</li>
      <li><b>Self-service balance &amp; history</b> — staff see entitlement, used, pending and remaining without asking HR.</li>
      <li><b>Public holiday awareness</b> — requests auto-exclude weekends and public holidays from the day count.</li>
      <li><b>Multiple leave types</b> — Annual, Sick, Family Responsibility, Study Leave, Maternity, Paternity, Unpaid, with a document upload for sick leave.</li>
      <li><b>Email notifications</b> — approvers and the CEO get an email the moment a request needs them or gets decided.</li>
      <li><b>Audit trail</b> — every approval step is timestamped and attributed; visible per request on My Requests.</li>
      <li><b>Manager &amp; company-wide reporting</b> — approved days and open requests by department, without exposing individual balances.</li>
      <li><b>Automatic year-end reminders</b> — a banner nudges staff every January/February who still have unused balance before it's forfeited.</li>
      <li><b>Private balances</b> — only the CEO and the employee themselves can see that employee's exact leave balance.</li>
      <li><b>Printable leave certificate</b> — a digital, downloadable confirmation of approved leave with remaining balance.</li>
      <li><b>Real, persistent database</b> — every request, approval and notification is stored permanently, surviving restarts and giving a genuine audit record.</li>
    </ul>
  </div>`;
}

/* ---------------- Render ---------------- */

const titles = { dashboard: 'Dashboard', request: 'Request leave', myrequests: 'My requests', details: 'My details', approvals: 'Approvals', teamcal: 'Team calendar', notifications: 'Notifications', admin: 'Admin settings', audit: 'Audit log', ideas: 'Platform ideas', certificate: 'Leave certificate' };

async function render() {
  renderNav();
  renderBottomNav();
  renderBell();
  renderTopbarMeta();
  document.getElementById('pageTitle').textContent = titles[currentView] || 'Dashboard';
  const content = document.getElementById('content');
  content.innerHTML = '<div class="empty">Loading…</div>';
  let html = '';
  try {
    if (currentView === 'dashboard') html = await viewDashboard();
    else if (currentView === 'request') html = viewRequest();
    else if (currentView === 'myrequests') html = await viewMyRequests();
    else if (currentView === 'approvals') html = await viewApprovals();
    else if (currentView === 'teamcal') html = await viewTeamCal();
    else if (currentView === 'notifications') html = await viewNotifications();
    else if (currentView === 'admin') html = (user.role === 'director' || user.role === 'manager') ? await viewAdmin() : (currentView = 'dashboard', await viewDashboard());
    else if (currentView === 'details') html = await viewDetails();
    else if (currentView === 'audit') html = user.role === 'director' ? await viewAuditLog() : (currentView = 'dashboard', await viewDashboard());
    else if (currentView === 'ideas') html = viewIdeas();
    else if (currentView === 'certificate') html = await viewCertificate();
  } catch (e) {
    html = `<div class="panel"><div class="empty">${e.message}</div></div>`;
  }
  content.innerHTML = html;

  if (currentView === 'request') {
    ['reqStart', 'reqEnd'].forEach((id) => {
      document.getElementById(id).addEventListener('change', updateRequestPreview);
    });
    document.getElementById('reqType').addEventListener('change', () => { toggleDocField(); updateRequestPreview(); });
    updateRequestPreview();
  }
}


async function viewDetails() {
  const [me, mine] = await Promise.all([
    api('/details/me'),
    api('/details/change-requests/mine'),
  ]);
  const sensitiveLabels = {
    idNumber: 'ID / passport number',
    bankName: 'Bank name',
    bankAccountNumber: 'Bank account number',
    bankBranchCode: 'Bank branch code',
  };
  const sensitiveFieldKeys = { idNumber: 'id_number', bankName: 'bank_name', bankAccountNumber: 'bank_account_number', bankBranchCode: 'bank_branch_code' };
  const pendingByField = {};
  mine.requests.filter((r) => r.status === 'pending').forEach((r) => { pendingByField[r.field] = r; });

  let html = '<div class="panel"><h2>My contact details</h2><p class="hint" style="margin:4px 0 10px;">These update immediately — no approval needed.</p><div class="form-grid">';
  html += `<div class="form-field"><label>Phone</label><input id="det_phone" value="${esc(me.phone)}"></div>`;
  html += `<div class="form-field"><label>Emergency contact name</label><input id="det_ecn" value="${esc(me.emergencyContactName)}"></div>`;
  html += `<div class="form-field"><label>Emergency contact phone</label><input id="det_ecp" value="${esc(me.emergencyContactPhone)}"></div>`;
  html += `<div class="form-field"><label>Address</label><input id="det_addr" value="${esc(me.address)}"></div>`;
  html += '</div><button class="btn" style="margin-top:10px;" onclick="saveMyDetails()">Save contact details</button></div>';

  html += '<div class="panel"><h2>ID &amp; banking details</h2><p class="hint" style="margin:4px 0 10px;">Changes to these fields need CEO approval before they take effect, to protect against payroll fraud.</p><div class="form-grid">';
  Object.keys(sensitiveLabels).forEach((key) => {
    const fieldKey = sensitiveFieldKeys[key];
    const pending = pendingByField[fieldKey];
    html += `<div class="form-field"><label>${sensitiveLabels[key]}</label><div>${esc(me[key]) || '<span class="hint">Not set</span>'}</div>`;
    if (pending) {
      html += `<div class="hint">Pending approval: ${esc(pending.new_value)}</div>`;
    } else {
      html += `<div style="display:flex;gap:6px;margin-top:4px;"><input id="det_req_${fieldKey}" placeholder="New value"><button class="btn" style="padding:6px 10px;font-size:13px;" onclick="requestDetailChange('${fieldKey}')">Request change</button></div>`;
    }
    html += '</div>';
  });
  html += '</div></div>';

  const history = mine.requests.filter((r) => r.status !== 'pending');
  if (history.length) {
    html += '<div class="panel"><h2>Change request history</h2><div class="table-scroll"><table><tr><th>Field</th><th>Requested</th><th>Status</th><th>Decided</th></tr>';
    history.forEach((r) => {
      html += `<tr><td>${esc(r.field_label)}</td><td>${esc(r.new_value)}</td><td class="pill">${esc(r.status)}</td><td>${r.decided_at ? fmtDateTime(r.decided_at) : '—'}</td></tr>`;
    });
    html += '</table></div></div>';
  }
  return html;
}

async function saveMyDetails() {
  const phone = document.getElementById('det_phone').value.trim();
  const emergencyContactName = document.getElementById('det_ecn').value.trim();
  const emergencyContactPhone = document.getElementById('det_ecp').value.trim();
  const address = document.getElementById('det_addr').value.trim();
  try {
    await api('/details/me', { method: 'POST', body: { phone, emergencyContactName, emergencyContactPhone, address } });
    render();
  } catch (e) {
    alert(e.message || 'Could not save your details.');
  }
}

async function requestDetailChange(field) {
  const input = document.getElementById('det_req_' + field);
  const newValue = input ? input.value.trim() : '';
  if (!newValue) { alert('Please enter a value first.'); return; }
  try {
    await api('/details/change-request', { method: 'POST', body: { field, newValue } });
    render();
  } catch (e) {
    alert(e.message || 'Could not submit that request.');
  }
}

async function decideDetailChange(id, action) {
  try {
    await api(`/details/change-requests/${id}/${action}`, { method: 'POST' });
    render();
  } catch (e) {
    alert(e.message || 'Could not update that request.');
  }
}


async function addEmployee() {
  const id = document.getElementById('newEmpId').value.trim();
  const name = document.getElementById('newEmpName').value.trim();
  const email = document.getElementById('newEmpEmail').value.trim();
  const deptId = document.getElementById('newEmpDept').value || null;
  const title = document.getElementById('newEmpTitle').value.trim() || null;
  const role = document.getElementById('newEmpRole').value;
  const entitlement = document.getElementById('newEmpEnt').value;
  const hireDate = document.getElementById('newEmpHire').value || null;
  const contractMonths = document.getElementById('newEmpContract').value || null;
  if (!id || !name || !email) { alert('Employee ID, name and email are required.'); return; }
  try {
    await api('/admin/employees', { method: 'POST', body: { id, name, email, deptId, role, title, entitlement, hireDate, contractMonths } });
    render();
  } catch (e) {
    alert(e.message || 'Could not add that employee.');
  }
}

/* ---------------- Boot ---------------- */

(async function boot() {
  try {
    const result = await api('/auth/me');
    user = result.user;
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    render();
  } catch (e) {
try { const r = await api('/auth/roster'); roster = r.users || []; } catch (_) { roster = []; }
         renderLogin();
  }
})();
