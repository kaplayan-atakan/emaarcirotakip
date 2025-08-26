const nodemailer = require('nodemailer');
const crypto = require('crypto');

// Centralized alerting & notification helper
// Features:
// - Single transporter reuse
// - Rate limiting / dedup (same error+source within window)
// - Severity tagging (INFO|WARN|ERROR|CRITICAL)
// - Multi-recipient & CC support
// - Context attachment (JSON truncated)
// - Graceful fallback logging

const DEFAULT_RECIPIENTS = [
  'atakan.kaplayan@apazgroup.com'
];
const DEFAULT_CC = [];
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CONTEXT_CHARS = 4000; // safety limit

let transport; // lazy init
let lastSendMap = new Map(); // key -> timestamp

function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: 'smtp.office365.com',
      port: 25,
      secure: false,
      auth: { user: 'alert@apazgroup.com', pass: 'dxvybfdrbtfpfbfl' }
    });
  }
  return transport;
}

function buildKey({ source, errorMessage, severity }) {
  const base = `${source || 'UNKNOWN'}|${severity || 'ERROR'}|${(errorMessage || '').slice(0,140)}`;
  return crypto.createHash('sha1').update(base).digest('hex');
}

function shouldRateLimit(key) {
  const now = Date.now();
  const prev = lastSendMap.get(key) || 0;
  if (now - prev < RATE_LIMIT_WINDOW_MS) return true;
  lastSendMap.set(key, now);
  // periodic cleanup
  if (lastSendMap.size > 500) {
    for (const [k,t] of lastSendMap.entries()) {
      if (now - t > RATE_LIMIT_WINDOW_MS * 6) lastSendMap.delete(k);
    }
  }
  return false;
}

function severityMeta(sev = 'ERROR') {
  const S = sev.toUpperCase();
  switch (S) {
    case 'INFO': return { icon: 'ℹ️', color: '#0d6efd' };
    case 'WARN': return { icon: '⚠️', color: '#fd7e14' };
    case 'ERROR': return { icon: '🚨', color: '#dc3545' };
    case 'CRITICAL': return { icon: '🛑', color: '#721c24' };
    default: return { icon: '🚨', color: '#dc3545' };
  }
}

async function sendErrorEmail({
  ciro = null,
  kisi = null,
  tarih = null,
  kullanici = 'SYSTEM',
  source = 'UNKNOWN',
  errorMessage = 'Bilinmeyen hata',
  errorStack = '',
  context = null,
  severity = 'ERROR',
  recipients = DEFAULT_RECIPIENTS,
  cc = DEFAULT_CC,
  rateLimit = true
} = {}) {
  try {
    const key = buildKey({ source, errorMessage, severity });
    if (rateLimit && shouldRateLimit(key)) {
      console.log(`⏱️ [ALERT-RATE-LIMIT] Skipping duplicate error mail: ${source}`);
      return { skipped: true, reason: 'rate_limited' };
    }

    const meta = severityMeta(severity);
    let contextSection = '';
    if (context) {
      try {
        let json = JSON.stringify(context, null, 2);
        if (json.length > MAX_CONTEXT_CHARS) {
          json = json.slice(0, MAX_CONTEXT_CHARS) + '\n... (truncated)';
        }
        contextSection = `<details style="margin-top:10px"><summary style="cursor:pointer;color:#444">Ek Bağlam</summary><pre style="background:#272822;color:#f8f8f2;padding:12px;border-radius:6px;overflow:auto;font-size:12px;max-height:400px">${json.replace(/</g,'&lt;')}</pre></details>`;
      } catch (_) {}
    }

    const stackHtml = errorStack ? `<details style=\"margin-top:10px\"><summary style=\"cursor:pointer;color:#555\">Stack Trace</summary><pre style=\"background:#272822;color:#f8f8f2;padding:12px;border-radius:6px;overflow:auto;font-size:12px;max-height:400px\">${errorStack.replace(/</g,'&lt;')}</pre></details>` : '';

    const html = `
      <div style="font-family:Segoe UI,Arial,sans-serif;max-width:680px;margin:0 auto;background:#fff;border:1px solid #eee;border-radius:10px;overflow:hidden">
        <div style="background:${meta.color};color:#fff;padding:16px 24px">
          <h2 style="margin:0;font-size:18px">${meta.icon} ${severity} - Emaar Gönderim Hatası</h2>
        </div>
        <div style="padding:22px;color:#222;font-size:14px;line-height:1.55">
          <p style="margin:0 0 6px 0"><strong>Kaynak:</strong> ${source}</p>
          ${tarih ? `<p style=\"margin:0 0 6px 0\"><strong>Tarih:</strong> ${tarih}</p>` : ''}
          ${ciro !== null ? `<p style=\"margin:0 0 6px 0\"><strong>Ciro:</strong> ${ciro}</p>` : ''}
          ${kisi !== null ? `<p style=\"margin:0 0 6px 0\"><strong>Kişi:</strong> ${kisi}</p>` : ''}
          <p style="margin:0 0 6px 0"><strong>Kullanıcı / Process:</strong> ${kullanici}</p>
          <p style="margin:12px 0 0 0"><strong>Hata Mesajı:</strong><br><code style="background:#f8f9fa;padding:6px 8px;border-radius:4px;display:inline-block;white-space:pre-wrap;max-width:100%">${errorMessage}</code></p>
          ${stackHtml}
          ${contextSection}
          <p style="margin-top:18px;font-size:11px;color:#666">Bu e-posta otomatik oluşturulmuştur.</p>
        </div>
      </div>`;

    const transport = getTransport();
    const mailOptions = {
      from: 'alert@apazgroup.com',
      to: recipients.join(','),
      cc: cc.length ? cc.join(',') : undefined,
      subject: `${severityMeta(severity).icon} ${severity} - ${source} - ${tarih || 'Tarih Yok'}`,
      html
    };

    await transport.sendMail(mailOptions);
    console.log(`📧 ALERT sent (severity=${severity}, source=${source})`);
    return { sent: true };
  } catch (err) {
    console.error('📧❌ Alert send failed:', err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = {
  sendErrorEmail
};
