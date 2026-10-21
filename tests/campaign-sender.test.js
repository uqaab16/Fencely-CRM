import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-sender-'));
process.env.CRM_DB_PATH = path.join(temp, 'db.sqlite');
for (const key of ['TURSO_DATABASE_URL','TURSO_AUTH_TOKEN','TURSO_HTTP_URL']) delete process.env[key];
const db = await import('../src/db.js');
const { senderAuthorized } = await import('../src/wa-sender-auth.js');
const T = Date.parse('2026-10-20T00:00:00Z'), GAP = 2160000;
let serial = 0;
async function batch(count = 1, schedule = {}) {
  const drafts = [];
  for (let i = 0; i < count; i++) {
    const lead = await db.createContractor({ business_name: `Test ${++serial}`, mobile: '+614' + String(serial).padStart(8, '0') });
    drafts.push({ contractor_id: lead.id, message: `Reviewed ${serial}` });
  }
  return db.saveCampaignDrafts({ name: `Batch ${serial}`, schedule: { timeZone: 'Australia/Perth', ...schedule }, drafts });
}
async function start(c) { return db.startCampaign(c.id, c.revision, true); }
async function permit(job, now) { return db.authorizeDispatch({ ...job, registration: 'available' }, now); }
async function receipt(job, now, status = 'sent') {
  return db.finishDispatch({ ...job, status, ...(status === 'sent' ? { message_id: 'gateway-' + now } : {}) }, now);
}
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

test('sender is disabled by default; worker secrets remain separate', async () => {
  delete process.env.WA_SEND_MODE; delete process.env.WA_SENDER_SECRET;
  assert.equal(await db.claimDispatch(T), null);
  assert.equal(senderAuthorized({ headers: {} }), false);
  process.env.WA_SENDER_SECRET = 's'.repeat(40); process.env.WA_BRIDGE_SECRET = 'b'.repeat(40);
  assert.equal(senderAuthorized({ headers: { authorization: 'Bearer ' + process.env.WA_BRIDGE_SECRET } }), false);
  assert.equal(senderAuthorized({ headers: { authorization: 'Bearer ' + process.env.WA_SENDER_SECRET } }), true);
  process.env.WA_SEND_MODE = 'test';
  const c = await batch();
  await assert.rejects(start(c), /only your/);
  process.env.WA_SEND_MODE = 'live';
  await assert.rejects(() => db.startCampaign(c.id, c.revision, false), /permission/);
});

test('atomic claims, pause before permit, and exact once receipts preserve replies', async () => {
  const c = await start(await batch(2));
  const claims = await Promise.all([db.claimDispatch(T), db.claimDispatch(T)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const job = claims.find(Boolean);
  await db.pauseCampaign(c.id);
  assert.equal((await permit(job, T)).send, false);
  await start(await db.getCampaign(c.id));
  const next = await db.claimDispatch(T);
  const p = await permit(next, T);
  assert.equal(p.send, true); assert.equal(p.expires_at, T + 10000);
  await assert.rejects(() => permit(next, T), /consumed/);
  assert.equal(await db.claimDispatch(T + GAP), null); // awaiting receipt blocks globally
  await db.recordWhatsAppReply({ session_id: 'test', message_id: 'reply', number: next.number, text: 'Hello', kind: 'reply', received_at: new Date(T).toISOString() });
  await receipt(next, T);
  await receipt(next, T);
  const campaign = await db.getCampaign(c.id);
  const lead = await db.getContractor(campaign.deliveries.find(d => d.state === 'sent').contractor_id);
  assert.equal(lead.stage, 'Replied');
  assert.equal(lead.activities.filter(a => a.type === 'whatsapp-sent').length, 1);
  assert.equal(await db.claimDispatch(T + GAP - 1), null);
});

test('phone edits, STOP during check and failed registration do not authorize sends', async () => {
  const c = await start(await batch(3));
  let job = await db.claimDispatch(T + GAP);
  const d = (await db.getCampaign(c.id)).deliveries.find(d => d.id === job.id);
  await db.updateContractor(d.contractor_id, { mobile: '+61499999999' });
  assert.equal((await permit(job, T + GAP)).send, false);
  job = await db.claimDispatch(T + GAP);
  await db.recordWhatsAppReply({ session_id: 'test', message_id: 'stop', number: job.number, text: 'Stop', kind: 'stop', received_at: new Date(T).toISOString() });
  assert.equal((await permit(job, T + GAP)).send, false);
  job = await db.claimDispatch(T + GAP);
  assert.equal((await db.authorizeDispatch({ ...job, registration: 'check_failed' }, T + GAP)).send, false);
  assert.equal((await db.getCampaign(c.id)).deliveries.filter(d => d.state === 'sent').length, 0);
});

test('checking leases can recover; uncertain sends never requeue and pause the campaign', async () => {
  const c = await start(await batch(2));
  const job = await db.claimDispatch(T + GAP);
  const replacement = await db.claimDispatch(T + GAP + 121000);
  assert.equal(replacement.id, job.id); assert.notEqual(replacement.token, job.token);
  await assert.rejects(() => permit(job, T + GAP + 121000), /expired/);
  await permit(replacement, T + GAP + 121000);
  await receipt(replacement, T + GAP + 121000, 'uncertain');
  assert.equal((await db.getCampaign(c.id)).state, 'paused');
  await receipt(replacement, T + GAP + 121000, 'uncertain');
  await start(await db.getCampaign(c.id));
  const next = await db.claimDispatch(T + GAP * 2 + 121000);
  assert.notEqual(next.id, replacement.id);
  await db.authorizeDispatch({ ...next, registration: 'not_found' }, T + GAP * 2 + 121000);
});

test('global rolling cap is shared across batches and weekends never claim', async () => {
  const c = await start(await batch(20));
  // Prior tests consumed two attempts. New batch cannot exceed the remaining 18.
  const first = T + GAP * 2 + 121000;
  let attempts = 0;
  for (let i = 0; i < 20; i++) {
    const now = first + GAP * i;
    const job = await db.claimDispatch(now);
    if (job) { await permit(job, now); await receipt(job, now); attempts++; }
  }
  assert.equal(attempts, 18);
  assert.equal(await db.claimDispatch(Date.parse('2026-10-24T00:00:00Z')), null);
  await db.pauseCampaign(c.id);
});

test('HTTP dispatch endpoints reject login, MCP and registration bridge credentials', async () => {
  const { default: handler } = await import('../src/app.js');
  const server = http.createServer(handler); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ['/api/whatsapp/sender/claim','/api/whatsapp/sender/authorize','/api/whatsapp/sender/result']) {
      const r = await fetch(base + path, { method: 'POST', headers: { authorization: 'Bearer ' + process.env.WA_BRIDGE_SECRET }, body: '{}' });
      assert.equal(r.status, 401);
    }
  } finally { await new Promise(r => server.close(r)); }
});

test('HTTP draft review and Start require login; MCP can save drafts but cannot start', async () => {
  process.env.JWT_SECRET = 'campaign-http-test'; process.env.MCP_TOKEN = 'm'.repeat(40);
  const { signToken } = await import('../src/auth.js');
  const { default: handler } = await import('../src/app.js');
  const server = http.createServer(handler); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`, login = signToken({ email: 'owner@example.test' });
  const call = (url, token, body) => fetch(base + url, { method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    const c = await batch();
    assert.equal((await call('/api/campaigns', '')).status, 401);
    assert.equal((await call(`/api/campaigns/${c.id}`, login)).status, 200);
    assert.equal((await call(`/api/campaigns/${c.id}/start`, process.env.MCP_TOKEN, { revision: c.revision, consent_confirmed: true })).status, 401);
    const tools = await (await call('/api/mcp', process.env.MCP_TOKEN, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json();
    const names = tools.result.tools.map(t => t.name);
    assert(names.includes('save_campaign_drafts')); assert(!names.includes('start_campaign'));
    process.env.WA_SEND_MODE = 'disabled';
    assert.equal((await call(`/api/campaigns/${c.id}/start`, login, { revision: c.revision, consent_confirmed: true })).status, 503);
    process.env.WA_SEND_MODE = 'live';
    assert.equal((await call(`/api/campaigns/${c.id}/start`, login, { revision: c.revision, consent_confirmed: true })).status, 200);
    assert.equal((await call(`/api/campaigns/${c.id}/pause`, login, {})).status, 200);
  } finally { await new Promise(r => server.close(r)); }
});
