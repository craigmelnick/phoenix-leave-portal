// Email delivery for the Phoenix Leave Portal.
//
// Primary channel is the Microsoft Graph API using OAuth client credentials. Graph is used in
// preference to SMTP because the Phoenix tenant refuses password-based SMTP by policy - Microsoft
// returns "535 5.7.139 Authentication unsuccessful, the request did not meet the criteria to be
// authenticated" - which is the correct modern posture rather than something to work around.
// Graph needs no mailbox password, no legacy authentication, and no Security Defaults exemption,
// so nothing has to be weakened tenant-wide to make leave emails work.
//
// It also fixes the original delivery failure. The previous Brevo setup sent from a shared IP
// (77.32.148.23) that is listed on SpamCop, and Mimecast rejected every message outright with
// "550 spamcop.mimecast.org Blocked". Graph mail leaves from Microsoft's own infrastructure as a
// genuine internal message, so it never meets that blocklist at all.
//
// Falls back to SMTP (the SMTP_* vars) when Graph isn't configured, and to console logging when
// neither is. That console fallback refuses to run when NODE_ENV=production, so a live deployment
// can never silently skip sending a real email.

const nodemailer = require('nodemailer');

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

function graphConfigured() {
  return Boolean(
    process.env.GRAPH_TENANT_ID &&
    process.env.GRAPH_CLIENT_ID &&
    process.env.GRAPH_CLIENT_SECRET &&
    process.env.GRAPH_SENDER
  );
}

// Microsoft's client-credential tokens last about an hour. Cache and reuse rather than paying a
// token round-trip on every single email, refreshing a minute early so a slow request can never
// race the expiry.
let cachedToken = null;
let cachedTokenExpiry = 0;

async function getGraphToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;

  const url = `https://login.microsoftonline.com/${encodeURIComponent(process.env.GRAPH_TENANT_ID)}/oauth2/v2.0/token`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GRAPH_CLIENT_ID,
      client_secret: process.env.GRAPH_CLIENT_SECRET,
      scope: GRAPH_SCOPE,
      grant_type: 'client_credentials',
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Graph token request failed (${res.status}): ${data.error_description || data.error || 'unknown error'}`);
  }

  cachedToken = data.access_token;
  cachedTokenExpiry = Date.now() + Math.max(0, (Number(data.expires_in) || 3600) - 60) * 1000;
  return cachedToken;
}

async function sendViaGraph(toEmail, subject, text, html) {
  const token = await getGraphToken();
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(process.env.GRAPH_SENDER)}/sendMail`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject,
        body: html ? { contentType: 'HTML', content: html } : { contentType: 'Text', content: text },
        toRecipients: [{ emailAddress: { address: toEmail } }],
      },
      // These are transactional notifications, not correspondence anyone needs to keep a copy of,
      // so don't fill the shared mailbox's Sent Items with thousands of login codes.
      saveToSentItems: false,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // A token that expired early is the one failure worth clearing so the next send retries clean.
    if (res.status === 401) { cachedToken = null; cachedTokenExpiry = 0; }
    throw new Error(`Graph sendMail failed (${res.status}): ${detail.slice(0, 400)}`);
  }

  return { devMode: false };
}

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) return null;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return transporter;
}

// Single delivery path for every kind of message the portal sends, so the Graph/SMTP/dev-console
// precedence is defined in exactly one place and can't drift between senders.
async function deliver(toEmail, subject, text, html, devDetail) {
  if (graphConfigured()) return sendViaGraph(toEmail, subject, text, html);

  const t = getTransporter();
  if (t) {
    await t.sendMail({
      from: process.env.FROM_EMAIL || 'Phoenix Leave Portal <no-reply@phoenixintl.co.za>',
      to: toEmail,
      subject,
      text,
      ...(html ? { html } : {}),
    });
    return { devMode: false };
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('No email transport is configured. Set the GRAPH_* variables (preferred) or the SMTP_* variables before going live.');
  }
  console.log(`[DEV EMAIL FALLBACK] To: ${toEmail} - Subject: ${subject} - ${devDetail}`);
  return { devMode: true };
}

async function sendOtpEmail(toEmail, code) {
  const subject = 'Your Phoenix Leave Portal login code';
  const text = `Your one-time login code is ${code}. It expires in 10 minutes. If you didn't request this, you can ignore this email.`;
  return deliver(toEmail, subject, text, null, `Code: ${code}`);
}

async function sendNotificationEmail(toEmail, subject, text) {
  return deliver(toEmail, subject, text, null, text);
}

// Sends the approved-leave certificate as a proper HTML email (the plain-text notification sent
// alongside this one is enough to alert someone; this is the keepsake copy).
async function sendCertificateEmail(toEmail, employeeName, subject, html, text) {
  return deliver(toEmail, subject, text, html, `(certificate HTML email, ${html.length} chars)`);
}

module.exports = { sendOtpEmail, sendNotificationEmail, sendCertificateEmail };
