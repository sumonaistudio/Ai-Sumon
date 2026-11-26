// ============================================================
// Email sender — Resend (free tier: 3,000/month, max 100/day).
// Server-side only. If RESEND_API_KEY is not set, sendMail returns
// { sent: false, reason: 'EMAIL_NOT_CONFIGURED' } — the caller must
// surface that honestly instead of pretending an email was sent.
// No secrets are ever logged. Uses built-in fetch (Node 20+).
// ============================================================

function isConfigured() {
  return Boolean((process.env.RESEND_API_KEY || '').trim());
}

// Send one email. Returns { sent: true } or { sent: false, reason }.
async function sendMail({ to, subject, html }) {
  if (!isConfigured()) return { sent: false, reason: 'EMAIL_NOT_CONFIGURED' };
  if (!to || !subject || !html) return { sent: false, reason: 'INVALID_EMAIL_PARAMS' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'Suman AI Studio <noreply@sumanaistudio.example>',
        to: [to],
        subject,
        html,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[mail] Resend error:', res.status, text.slice(0, 200));
      return { sent: false, reason: 'EMAIL_PROVIDER_ERROR' };
    }
    return { sent: true };
  } catch (err) {
    console.error('[mail] send failed:', err.message);
    return { sent: false, reason: 'EMAIL_PROVIDER_ERROR' };
  }
}

module.exports = { isConfigured, sendMail };
