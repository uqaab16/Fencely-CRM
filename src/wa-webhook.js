import { createHmac, timingSafeEqual } from 'node:crypto';

function reject(statusCode, message) {
  const e = new Error(message); e.statusCode = statusCode; throw e;
}

export async function readWebhookBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 262144) reject(413, 'Webhook too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export function verifyWebhook(raw, signature) {
  const secret = process.env.WA_WEBHOOK_SECRET || '';
  if (secret.length < 32 || !process.env.WA_WEBHOOK_SESSION_ID) reject(503, 'Webhook is not configured');
  if (typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) reject(401, 'Invalid webhook signature');
  const expected = createHmac('sha256', secret).update(raw).digest('hex');
  if (!timingSafeEqual(Buffer.from(signature.slice(7)), Buffer.from(expected))) reject(401, 'Invalid webhook signature');
}

export function replyKind(text) {
  const value = text.trim().toLowerCase();
  if (/^(?:please\s+)?(?:stop(?:\s+(?:messaging|contacting)(?:\s+me)?)?|unsubscribe|remove me|do not contact(?: me)?|not interested|no more messages)[.!]*$/.test(value)) return 'stop';
  return /^interested[.!]*$/.test(value) ? 'interested' : 'reply';
}

// WA-AKG signs the raw envelope and emits the chosen button ID as content.
// Never infer a telephone number from an unresolved @lid, group or sender name.
export function parseWebhook(raw, now = Date.now()) {
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { reject(400, 'Invalid webhook JSON'); }
  if (!payload || typeof payload !== 'object') reject(400, 'Invalid webhook envelope');
  const timestamp = Date.parse(payload.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > 86400000) reject(400, 'Webhook timestamp is stale or invalid');
  if (payload.event === 'test' && payload.sessionId === 'test') return { test: true };
  if (payload.sessionId !== process.env.WA_WEBHOOK_SESSION_ID) reject(403, 'Unexpected WhatsApp session');
  if (payload.event !== 'message.received') return null;
  const d = payload.data;
  if (!d || typeof d !== 'object') reject(400, 'Invalid received message');
  if (d.key?.fromMe !== false || d.isGroup !== false || d.chatType !== 'PERSONAL') return null;
  const from = d.from;
  if (typeof from !== 'string' || !/^[1-9]\d{7,14}@s\.whatsapp\.net$/.test(from)) return null;
  if (d.key?.remoteJid !== from) return null;
  const id = d.key?.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(id)) reject(400, 'Missing message ID');
  const text = typeof d.content === 'string' ? d.content.slice(0, 4000) : '';
  const textType = ['TEXT', 'BUTTON_RESPONSE', 'INTERACTIVE_RESPONSE'].includes(d.type);
  return {
    session_id: payload.sessionId, message_id: id, number: from.split('@')[0],
    text, kind: textType ? replyKind(text) : 'reply',
    received_at: new Date(timestamp).toISOString(),
  };
}
