// Registration checks only. This module never sends a message.
// WA-AKG main at 2026-10-20: POST /api/chat/{sessionId}/check.
export const VERIFICATION_LABELS = {
  not_checked: 'Not checked',
  available: 'WhatsApp available',
  not_found: 'WhatsApp not found — unconfirmed',
  invalid: 'Invalid or missing number',
  check_failed: 'Check failed — retry later',
};

// CRM records are Australian. Never guess a country for an ambiguous number.
export function normaliseWhatsAppNumber(value) {
  const raw = String(value || '').trim();
  if (!raw || !/^[+\d\s().-]+$/.test(raw)) return null;
  let n = raw.replace(/\D/g, '');
  if (n.startsWith('00')) n = n.slice(2);
  if (/^0[23478]\d{8}$/.test(n)) n = `61${n.slice(1)}`;
  if (n.startsWith('61')) return /^61[23478]\d{8}$/.test(n) ? n : null;
  return (raw.startsWith('+') || raw.startsWith('00')) && /^[1-9]\d{7,14}$/.test(n) ? n : null;
}

export function contractorWhatsAppNumber(c) {
  return [c.whatsapp_number, c.mobile, c.landline].map(normaliseWhatsAppNumber).find(Boolean) || null;
}

export function gatewayConfigured() {
  return !!(process.env.WA_AKG_URL && process.env.WA_AKG_API_KEY && process.env.WA_AKG_SESSION_ID);
}

export async function checkWhatsAppRegistration(contractor, fetcher = fetch) {
  const number = contractorWhatsAppNumber(contractor);
  const base = { number: number || '', checked_at: new Date().toISOString(), jid: '' };
  const verdict = (status, detail) => ({ ...base, status, detail });
  if (!number) return verdict('invalid', 'Correct the phone number before checking again.');
  if (!gatewayConfigured()) {
    const error = new Error('WhatsApp gateway is not connected. Configure WA_AKG_URL, WA_AKG_API_KEY and WA_AKG_SESSION_ID on the server.');
    error.statusCode = 503;
    throw error;
  }
  let url;
  try {
    url = new URL(process.env.WA_AKG_URL);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    url.pathname = `${url.pathname.replace(/\/$/, '')}/api/chat/${encodeURIComponent(process.env.WA_AKG_SESSION_ID)}/check`;
  } catch {
    const error = new Error('Invalid WhatsApp gateway URL.');
    error.statusCode = 503;
    throw error;
  }
  try {
    const response = await fetcher(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: { 'content-type': 'application/json', 'X-API-Key': process.env.WA_AKG_API_KEY },
      body: JSON.stringify({ numbers: [number] }),
    });
    if (!response.ok) return verdict('check_failed', `Gateway returned HTTP ${response.status}. Registration is unknown.`);
    const body = await response.json();
    const results = body?.data?.results;
    const result = Array.isArray(results) ? results.find(r => r.number === number) : null;
    if (body.status !== true || !result || result.error || typeof result.exists !== 'boolean') {
      return verdict('check_failed', 'Gateway could not confirm registration. Retry later.');
    }
    if (result.exists) return { ...verdict('available', 'Registration found at the time of this check. This is not marketing consent or a delivery guarantee.'), jid: String(result.jid || '') };
    // Upstream maps BOTH an empty Baileys result and an explicit false to
    // exists:false. Do not claim that this proves permanent non-registration.
    return verdict('not_found', 'Gateway did not find WhatsApp. Skip sending; recheck or confirm manually before marking unavailable.');
  } catch {
    // Never expose gateway response bodies, session credentials or URLs.
    return verdict('check_failed', 'Gateway connection failed or timed out. Registration is unknown.');
  }
}
