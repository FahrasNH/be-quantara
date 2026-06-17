const nodemailer = require('nodemailer');
const cfg = require('../config/env.js');

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  if (!cfg.EMAIL_HOST || !cfg.EMAIL_USER || !cfg.EMAIL_PASS) {
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
      pass: cfg.EMAIL_PASS,
    },
  });

  return _transporter;
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

module.exports = { sendPasswordReset };
