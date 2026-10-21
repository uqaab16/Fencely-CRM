import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { verifyWebhook, parseWebhook, replyKind } from '../src/wa-webhook.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-inbox-'));
process.env.CRM_DB_PATH = path.join(temp, 'db.sqlite');
for (const k of ['TURSO_HTTP_URL', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN']) delete process.env[k];
process.env.WA_WEBHOOK_SECRET = 'webhook-test-only-'.repeat(4);
process.env.WA_WEBHOOK_SESSION_ID = 'test-session';
const db = await import('../src/db.js');
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

function payload(content = 'Hello', id = 'message-1', number = '61412345678', type = 'TEXT') {
  return { event: 'message.received', sessionId: 'test-session', timestamp: new Date().toISOString(), data: {
    key: { id, remoteJid: `${number}@s.whatsapp.net`, fromMe: false },
    from: `${number}@s.whatsapp.net`, isGroup: false, chatType: 'PERSONAL', content, type,
  } };
}
const raw = p => Buffer.from(JSON.stringify(p));
const event = (content, id, number, type) => parseWebhook(raw(payload(content, id, number, type)));
const signature = b => 'sha256=' + createHmac('sha256', process.env.WA_WEBHOOK_SECRET).update(b).digest('hex');

test('signature verifies exact bytes, fails closed, and binds to configured session', () => {
  const b = raw(payload());
  verifyWebhook(b, signature(b));
  assert.throws(() => verifyWebhook(Buffer.from(b.toString() + ' '), signature(b)), /signature/);
  assert.throws(() => verifyWebhook(b, undefined), /signature/);
  const secret = process.env.WA_WEBHOOK_SECRET;
  delete process.env.WA_WEBHOOK_SECRET;
  assert.throws(() => verifyWebhook(b, 'sha256=' + '0'.repeat(64)), /configured/);
  process.env.WA_WEBHOOK_SECRET = secret;
  assert.throws(() => parseWebhook(raw({ ...payload(), sessionId: 'other' })), /session/);
  assert.throws(() => parseWebhook(raw({ ...payload(), timestamp: '2020-01-01' })), /stale/);
  assert.equal(parseWebhook(raw({ event: 'test', sessionId: 'test', timestamp: new Date().toISOString() })).test, true);
});

test('only personal incoming messages are processed; STOP is exact, not a substring', () => {
  for (const patch of [{ isGroup: true }, { chatType: 'GROUP' }, { key: { ...payload().data.key, fromMe: true } }, { from: '123456789@lid' }]) {
    const p = payload(); Object.assign(p.data, patch);
    assert.equal(parseWebhook(raw(p)), null);
  }
  assert.equal(parseWebhook(raw({ ...payload(), event: 'message.sent' })), null);
  for (const text of ['STOP', 'unsubscribe', 'Please stop messaging me.', 'Not interested']) assert.equal(replyKind(text), 'stop');
  assert.equal(replyKind('Interested'), 'interested');
  for (const text of ['I am not sure if I am interested', 'Please stop by tomorrow', 'not interested in timber, tell me about aluminium']) assert.equal(replyKind(text), 'reply');
  assert.equal(event('stop', 'audio-1', '61412345678', 'AUDIO').kind, 'reply');
  assert.equal(event('stop', 'button-1', '61412345678', 'INTERACTIVE_RESPONSE').kind, 'stop');
});

test('reply updates all matching leads, pauses followups, and deduplicates the timeline', async () => {
  const first = await db.createContractor({ business_name: 'First test', mobile: '0412345678' });
  const second = await db.createContractor({ business_name: 'Second test', mobile: '+61412345678' });
  await db.logContact(first.id, { channel: 'whatsapp' });
  await db.createTask({ contractor_id: first.id, title: 'Review quote', due_date: '2026-10-21' });
  const e = event('Thanks, tell me more', 'reply-1');
  await Promise.all([db.recordWhatsAppReply(e), db.recordWhatsAppReply(e)]);
  for (const c of [first, second]) {
    const saved = await db.getContractor(c.id);
    assert.equal(saved.stage, 'Replied');
    assert.equal(saved.next_followup, '');
    assert.equal(saved.whatsapp_outreach.followup_paused, true);
    assert.equal(saved.activities.filter(a => a.type === 'whatsapp-reply').length, 1);
  }
  const saved = await db.getContractor(first.id);
  assert.equal(saved.tasks.find(t => t.title.startsWith('Follow up with ')).done, true);
  assert.equal(saved.tasks.find(t => t.title === 'Review quote').done, false);
  await db.recordWhatsAppReply(event('interested', 'interest-1', '61412345678', 'INTERACTIVE_RESPONSE'));
  assert.equal((await db.getContractor(first.id)).stage, 'Interested');
  await db.recordWhatsAppReply(event('Hello again', 'reply-2'));
  assert.equal((await db.getContractor(first.id)).stage, 'Interested');
  await db.updateContractor(second.id, { stage: 'Customer' });
  await db.recordWhatsAppReply(event('interested', 'interest-2'));
  assert.equal((await db.getContractor(second.id)).stage, 'Customer');
  await db.bulkDeleteContractors([first.id, second.id]);
});

test('STOP beats concurrent interest/reply, survives deletion and stage edits, and covers unknown numbers', async () => {
  const number = '61419999999';
  const c = await db.createContractor({ business_name: 'STOP test', mobile: '+61419999999' });
  await Promise.all([
    db.recordWhatsAppReply(event('Stop', 'stop-1', number, 'BUTTON_RESPONSE')),
    db.recordWhatsAppReply(event('Interested', 'interest-stop', number)),
    db.recordWhatsAppReply(event('hello', 'reply-stop', number)),
  ]);
  assert.equal((await db.getContractor(c.id)).stage, 'Do Not Contact');
  assert.equal((await db.getWhatsAppOutreachState(number)).suppressed, true);
  await db.updateContractor(c.id, { stage: 'New' });
  assert.equal((await db.getContractor(c.id)).whatsapp_outreach.suppressed, true);
  await db.deleteContractor(c.id);
  await db.recordWhatsAppReply(event('Stop', 'unknown-stop', '61418888888'));
  assert.equal((await db.getWhatsAppOutreachState('61418888888')).suppressed, true);
  assert.equal((await db.getWhatsAppOutreachState(number)).suppressed, true);
});

test('HTTP webhook rejects unsigned/tampered requests; signed reply logs no outbound contact', async () => {
  const { default: handler } = await import('../src/app.js');
  const app = http.createServer(handler);
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.address().port}/api/whatsapp/webhook`;
  const c = await db.createContractor({ business_name: 'HTTP inbox', mobile: '+61415555555' });
  const b = raw(payload('Interested', 'http-1', '61415555555', 'INTERACTIVE_RESPONSE'));
  const send = (body, sig) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(sig ? { 'x-webhook-signature': sig } : {}) }, body });
  try {
    assert.equal((await send(b)).status, 401);
    assert.equal((await send(Buffer.from(b.toString() + ' '), signature(b))).status, 401);
    assert.equal((await db.getContractor(c.id)).stage, 'New');
    assert.equal((await send(b, signature(b))).status, 200);
    assert.equal((await send(b, signature(b))).status, 200);
    const saved = await db.getContractor(c.id);
    assert.equal(saved.stage, 'Interested');
    assert.equal(saved.last_contacted, '');
    assert.equal(saved.activities.filter(a => a.type === 'whatsapp-interested').length, 1);
    assert.equal((await send(Buffer.alloc(262145), signature(Buffer.alloc(262145)))).status, 413);
  } finally {
    await db.deleteContractor(c.id);
    await new Promise(resolve => app.close(resolve));
  }
});

test('clear natural-language opt-outs are permanent; ambiguous conversation stays a reply', () => {
  for (const text of ['Stop texting me', 'Please stop texting me!', 'Stop contacting me, thanks.', 'Do not message me again.', "Don't text me again", 'Please remove me from your list', 'Unsubscribe me please', 'No more texts'])
    assert.equal(replyKind(text), 'stop', text);
  for (const text of ["Don't stop messaging me", 'Can you stop by tomorrow?', 'Please stop by our workshop', 'How do I unsubscribe?', 'Not interested in timber, show me steel'])
    assert.equal(replyKind(text), 'reply', text);
});
