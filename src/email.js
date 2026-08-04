// Sends the one-time login code by email — the channel Craig chose because it's free (everyone
// already has a company inbox) and needs no extra service. Configure real SMTP via the SMTP_*
// env vars for production. If SMTP isn't configured, falls back to logging the code to the
// server console and returning it in the API response, clearly labelled as a dev-only shortcut —
// this fallback refuses to run at all if NODE_ENV=production, so a live deployment can never
// accidentally skip sending a real email.

const nodemailer = require('nodemailer');

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

async function sendOtpEmail(toEmail, code) {
  const t = getTransporter();
  const subject = 'Your Phoenix Leave Portal login code';
  const text = `Your one-time login code is ${code}. It expires in 10 minutes. If you didn't request this, you can ignore this email.`;
  if (!t) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SMTP is not configured. Set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS before going live.');
    }
    console.log(`[DEV EMAIL FALLBACK] To: ${toEmail} — Subject: ${subject} — Code: ${code}`);
    return { devMode: true };
  }
  await t.sendMail({
    from: process.env.FROM_EMAIL || 'Phoenix Leave Portal <no-reply@phoenixintl.co.za>',
    to: toEmail,
    subject,
    text,
  });
  return { devMode: false };
}

async function sendNotificationEmail(toEmail, subject, text) {
  const t = getTransporter();
  if (!t) {
    console.log(`[DEV EMAIL FALLBACK] To: ${toEmail} — Subject: ${subject} — ${text}`);
    return { devMode: true };
  }
  await t.sendMail({
    from: process.env.FROM_EMAIL || 'Phoenix Leave Portal <no-reply@phoenixintl.co.za>',
    to: toEmail,
    subject,
    text,
  });
  return { devMode: false };
}

// Sends the approved-leave certificate as a proper HTML email (the plain-text notification sent
// alongside this one is enough to alert someone; this is the keepsake copy). Falls back to the
// same dev-console logging as the other senders when SMTP isn't configured, so local/dev testing
// never silently drops the certificate — it just prints a marker instead of the full HTML.
async function sendCertificateEmail(toEmail, employeeName, subject, html, text) {
  const t = getTransporter();
  if (!t) {
    console.log(`[DEV EMAIL FALLBACK] To: ${toEmail} — Subject: ${subject} — (certificate HTML email, ${html.length} chars)`);
    return { devMode: true };
  }
  await t.sendMail({
    from: process.env.FROM_EMAIL || 'Phoenix Leave Portal <no-reply@phoenixintl.co.za>',
    to: toEmail,
    subject,
    text,
    html,
  });
  return { devMode: false };
}

module.exports = { sendOtpEmail, sendNotificationEmail, sendCertificateEmail };
