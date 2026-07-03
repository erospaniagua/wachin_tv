import nodemailer from 'nodemailer';

const {
  SMTP_HOST,
  SMTP_PORT = '587',
  SMTP_USER,
  SMTP_PASS,
  MAIL_FROM = 'wachin.tv <no-reply@wachin.tv>',
} = process.env;

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error('SMTP is not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS).');
  }
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT, 10),
    secure: parseInt(SMTP_PORT, 10) === 465, // 465 = implicit TLS; 587 = STARTTLS
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

export async function sendMagicLink(to, name, link) {
  const html = `
    <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: auto;">
      <h2 style="margin-bottom: 0.25rem;">wachin<span style="color:#e11d48;">.tv</span></h2>
      <p>Hi ${escapeHtml(name)}, click below to sign in. This link expires shortly and can be used once.</p>
      <p style="margin: 1.5rem 0;">
        <a href="${link}"
           style="background:#e11d48;color:#fff;padding:0.7rem 1.2rem;border-radius:8px;text-decoration:none;">
          Sign in to wachin.tv
        </a>
      </p>
      <p style="color:#666;font-size:0.85rem;">If you didn't request this, you can ignore this email.</p>
    </div>`;

  await getTransporter().sendMail({
    from: MAIL_FROM,
    to,
    subject: 'Your wachin.tv sign-in link',
    text: `Hi ${name}, sign in to wachin.tv: ${link}`,
    html,
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}
