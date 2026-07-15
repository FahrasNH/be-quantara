const nodemailer = require('nodemailer');
const cfg = require('../config/env.js');

let _transporter = null;

function isEmailConfigured() {
  return !!(cfg.EMAIL_HOST && cfg.EMAIL_USER && cfg.EMAIL_PASS);
}

function normalizedEmailPass() {
  return String(cfg.EMAIL_PASS || "").replace(/\s+/g, "");
}

function getTransporter() {
  if (_transporter) return _transporter;

  if (!isEmailConfigured()) {
    throw new Error(
      'Email service not configured. Set EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS in .env'
    );
  }

  _transporter = nodemailer.createTransport({
    host: cfg.EMAIL_HOST,
    port: cfg.EMAIL_PORT,
    secure: cfg.EMAIL_PORT === 465,
    auth: {
      user: cfg.EMAIL_USER,
      pass: normalizedEmailPass(),
    },
  });

  return _transporter;
}

/** Verify SMTP credentials at startup (best-effort). */
async function verifySmtpConnection() {
  if (!isEmailConfigured()) return false;
  try {
    const t = getTransporter();
    await t.verify();
    console.log('[EmailService] SMTP connection verified');
    return true;
  } catch (err) {
    console.error('[EmailService] SMTP verify failed:', err.message);
    return false;
  }
}

async function sendPasswordReset(toEmail, resetUrl) {
  const transporter = getTransporter();

  await transporter.sendMail({
    from: `"Quantara" <${cfg.EMAIL_USER}>`,
    to: toEmail,
    subject: 'Reset your Quantara password',
    text: [
      'You requested a password reset for your Quantara account.',
      '',
      'Click the link below to reset your password (valid for 30 minutes):',
      resetUrl,
      '',
      'If you did not request this, ignore this email — your password remains unchanged.',
      '',
      '— Quantara Security',
    ].join('\n'),
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;background:#f2f2fa;padding:32px">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#171430,#241a52);padding:32px;text-align:center">
      <div style="font-size:28px;font-weight:800;color:#fff;letter-spacing:-1px">⚡ Quantara</div>
      <div style="color:#a29bd4;margin-top:6px;font-size:13px">Personal Trading Bot</div>
    </div>
    <div style="padding:32px">
      <h2 style="margin:0 0 12px;color:#1a1040;font-size:20px">Reset your password</h2>
      <p style="color:#555;line-height:1.6;margin:0 0 24px">
        You requested a password reset for your Quantara account.
        Click the button below to choose a new password. The link expires in <strong>30 minutes</strong>.
      </p>
      <a href="${resetUrl}" style="display:inline-block;background:#6c5ce7;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;font-size:15px">Reset Password</a>
      <p style="color:#888;font-size:12px;margin:24px 0 0;line-height:1.6">
        If you didn't request this, ignore this email — your password remains unchanged.
        <br>If the button doesn't work, copy this link: <br>
        <a href="${resetUrl}" style="color:#6c5ce7;word-break:break-all">${resetUrl}</a>
      </p>
    </div>
  </div>
</body>
</html>`,
  });
}

async function sendEmailVerification(toEmail, verifyUrl) {
  const transporter = getTransporter();

  await transporter.sendMail({
    from: `"Quantara" <${cfg.EMAIL_USER}>`,
    to: toEmail,
    subject: 'Verifikasi email akun Quantara kamu',
    text: [
      'Terima kasih sudah mendaftar di Quantara!',
      '',
      'Klik link berikut untuk memverifikasi email kamu (berlaku 24 jam):',
      verifyUrl,
      '',
      'Jika kamu tidak mendaftar, abaikan email ini.',
      '',
      '— Tim Quantara',
    ].join('\n'),
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;background:#f2f2fa;padding:32px">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#171430,#241a52);padding:32px;text-align:center">
      <div style="font-size:28px;font-weight:800;color:#fff;letter-spacing:-1px">⚡ Quantara</div>
      <div style="color:#a29bd4;margin-top:6px;font-size:13px">Personal Trading Bot</div>
    </div>
    <div style="padding:32px">
      <h2 style="margin:0 0 12px;color:#1a1040;font-size:20px">Verifikasi email kamu</h2>
      <p style="color:#555;line-height:1.6;margin:0 0 24px">
        Terima kasih sudah mendaftar di Quantara! Klik tombol di bawah untuk mengaktifkan akun kamu.
        Link ini berlaku selama <strong>24 jam</strong>.
      </p>
      <a href="${verifyUrl}" style="display:inline-block;background:#6c5ce7;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;font-size:15px">Verifikasi Email</a>
      <p style="color:#888;font-size:12px;margin:24px 0 0;line-height:1.6">
        Jika kamu tidak mendaftar, abaikan email ini.
        <br>Jika tombol tidak berfungsi, salin link ini: <br>
        <a href="${verifyUrl}" style="color:#6c5ce7;word-break:break-all">${verifyUrl}</a>
      </p>
    </div>
  </div>
</body>
</html>`,
  });
}

/**
 * Subscription-activated receipt (Sprint 5 / PAY-04). Best-effort — the caller
 * wraps this in try/catch so a mail failure never blocks the payment webhook.
 * @param {string} toEmail
 * @param {{ username, tier, billingCycle, endDate, finalAmount }} info
 */
async function sendSubscriptionActivated(toEmail, info) {
  const transporter = getTransporter();
  const fmtIDR = (n) => "Rp" + Number(n || 0).toLocaleString("id-ID");
  const endStr = info.endDate ? new Date(info.endDate).toLocaleDateString("id-ID", { year: "numeric", month: "long", day: "numeric" }) : "-";
  const cycle = String(info.billingCycle || "MONTHLY").toLowerCase();

  await transporter.sendMail({
    from: `"Quantara" <${cfg.EMAIL_USER}>`,
    to: toEmail,
    subject: `Langganan Quantara ${info.tier} kamu aktif 🎉`,
    text: [
      `Hai ${info.username || "Trader"},`,
      '',
      `Pembayaran kamu berhasil dan langganan tier ${info.tier} (${cycle}) sudah aktif.`,
      `Total dibayar: ${fmtIDR(info.finalAmount)}`,
      `Berlaku sampai: ${endStr}`,
      '',
      'Selamat trading!',
      '— Tim Quantara',
    ].join('\n'),
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;background:#f2f2fa;padding:32px">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#171430,#241a52);padding:32px;text-align:center">
      <div style="font-size:28px;font-weight:800;color:#fff;letter-spacing:-1px">⚡ Quantara</div>
      <div style="color:#a29bd4;margin-top:6px;font-size:13px">Personal Trading Bot</div>
    </div>
    <div style="padding:32px">
      <h2 style="margin:0 0 12px;color:#1a1040;font-size:20px">Langganan ${info.tier} aktif 🎉</h2>
      <p style="color:#555;line-height:1.6;margin:0 0 24px">
        Hai <strong>${info.username || "Trader"}</strong>, pembayaran kamu berhasil dan
        tier <strong>${info.tier}</strong> (${cycle}) sudah aktif.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:0 0 24px;font-size:14px;color:#333">
        <tr><td style="padding:8px 0;color:#888">Total dibayar</td><td style="padding:8px 0;text-align:right;font-weight:600">${fmtIDR(info.finalAmount)}</td></tr>
        <tr><td style="padding:8px 0;color:#888">Berlaku sampai</td><td style="padding:8px 0;text-align:right;font-weight:600">${endStr}</td></tr>
      </table>
      <a href="${cfg.APP_URL}" style="display:inline-block;background:#6c5ce7;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;font-size:15px">Buka Dashboard</a>
    </div>
  </div>
</body>
</html>`,
  });
}

module.exports = { isEmailConfigured, verifySmtpConnection, sendPasswordReset, sendEmailVerification, sendSubscriptionActivated };
