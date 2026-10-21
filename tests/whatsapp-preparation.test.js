import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-preparation-'));
process.env.CRM_DB_PATH = path.join(temp, 'db.sqlite');
for (const key of ['TURSO_DATABASE_URL','TURSO_AUTH_TOKEN','TURSO_HTTP_URL']) delete process.env[key];
const db = await import('../src/db.js');
const { contractorWhatsAppNumber } = await import('../src/whatsapp.js');
const { bridgeResult } = await import('../src/wa-bridge.js');
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
async function lead(city, index, fields = {}) {
  return db.createContractor({ business_name: `${city} ${index}`, city, state: 'NSW', mobile: '+614' + String(index).padStart(8,'0'), ...fields });
}
async function finish(job, status) {
  await db.finishWhatsAppPreparation(job.id, job.token, bridgeResult(job.number, { status }));
}
test('fills target by checking further contacts without filtering phone labels or permission', async () => {
  const a = await lead('Sydney', 1, { whatsapp_status: 'Advertises WhatsApp' });
  const b = await lead('Sydney', 2, { mobile: '', landline: '02 1234 5678', whatsapp_status: 'Landline only' });
  await lead('Sydney', 3, { whatsapp_status: 'Unknown' });
  const d = await lead('Sydney', 4, { whatsapp_status: 'WhatsApp - unverified' });
  await lead('Perth', 5, { state: 'WA' });
  const prep = await db.createWhatsAppPreparation({ city: 'Sydney', state: 'NSW', target: 2 });
  assert.equal(prep.total_candidates, 4);
  assert.equal((await db.createWhatsAppPreparation({ city: 'SYDNEY', state: 'NSW', target: 2 })).id, prep.id);
  const results = ['not_found','available','check_failed','available'];
  for (let i = 0; i < results.length; i++) {
    const claimed = await Promise.all([db.claimWhatsAppPreparation(), db.claimWhatsAppPreparation()]);
    assert.equal(claimed.filter(Boolean).length, 1);
    const job = claimed.find(Boolean);
    await finish(job, results[i]);
    await finish(job, results[i]); // acknowledgement retry
  }
  const ready = await db.getWhatsAppPreparation(prep.id);
  assert.equal(ready.status, 'ready'); assert.equal(ready.processed, 4);
  assert.deepEqual(ready.available.map(r => r.contractor_id), [b.id, d.id]);
  assert.equal(await db.claimWhatsAppPreparation(), null);
  assert.equal((await db.getContractor(a.id)).whatsapp_verification.status, 'not_found');
  assert.equal((await db.getContractor(b.id)).stage, 'New');
  assert.equal((await db.getContractor(b.id)).last_contacted, '');
  await db.recordWhatsAppReply({ session_id: 's', message_id: 'stop', number: ready.available[0].number, text: 'STOP', kind: 'stop', received_at: new Date().toISOString() });
  assert.equal((await db.getWhatsAppPreparation(prep.id)).status, 'exhausted');
  assert.equal((await db.getWhatsAppPreparation(prep.id)).available_count, 1);
});
test('skips duplicates, missing/invalid numbers and opt-outs, and honestly reports exhausted pool', async () => {
  const a = await lead('Test City', 10);
  await lead('Test City', 11, { mobile: '+61400000010' });
  await lead('Test City', 12, { mobile: '', landline: '' });
  await lead('Test City', 13, { stage: 'Do Not Contact' });
  const prep = await db.createWhatsAppPreparation({ city: 'Test City', target: 3 });
  const job = await db.claimWhatsAppPreparation();
  assert.equal(job.contractor_id, a.id); await finish(job, 'available');
  assert.equal(await db.claimWhatsAppPreparation(), null);
  const result = await db.getWhatsAppPreparation(prep.id);
  assert.equal(result.status, 'exhausted'); assert.equal(result.available_count, 1);
  assert.deepEqual(result.results.map(r => r.status), ['available','duplicate','invalid','skipped']);
});
test('edited phones reject stale results; read-only check lease can recover after a restart', async () => {
  const a = await lead('Lease City', 20);
  const prep = await db.createWhatsAppPreparation({ city: 'Lease City', target: 1 });
  const job = await db.claimWhatsAppPreparation();
  await db.updateContractor(a.id, { mobile: '+61499999999' });
  await finish(job, 'available');
  assert.equal((await db.getWhatsAppPreparation(prep.id)).available_count, 0);
  await lead('Restart City', 21);
  await db.createWhatsAppPreparation({ city: 'Restart City', target: 1 });
  const old = await db.claimWhatsAppPreparation();
  const replacement = await db.claimWhatsAppPreparation(Date.now() + 121000);
  assert.equal(old.id, replacement.id); assert.notEqual(old.token, replacement.token);
  await assert.rejects(() => finish(old, 'available'), /lease/);
  await finish(replacement, 'available');
  assert.equal(contractorWhatsAppNumber({ whatsapp_number: 'invalid', mobile: '+61412345678' }), '61412345678');
});
test('HTTP/MCP preparation uses registration bridge only and cannot send', async () => {
  process.env.WA_BRIDGE_SECRET = 'b'.repeat(40); process.env.JWT_SECRET = 'prep-test'; process.env.MCP_TOKEN = 'm'.repeat(40);
  const { default: handler } = await import('../src/app.js');
  const { signToken } = await import('../src/auth.js');
  const server = http.createServer(handler); await new Promise(r => server.listen(0,'127.0.0.1',r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, token, body) => fetch(base + url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type':'application/json' }, body: JSON.stringify(body) });
  try {
    await lead('HTTP City', 30);
    const auth = signToken({ email:'owner@example.test' });
    assert.equal((await post('/api/whatsapp/preparations','', { city:'HTTP City' })).status,401);
    const created = await (await post('/api/whatsapp/preparations', auth, { city:'HTTP City', target:1 })).json();
    const claimed = await (await post('/api/whatsapp/bridge/claim', process.env.WA_BRIDGE_SECRET, {})).json();
    assert(claimed.job.id.startsWith('prep:'));
    const result = await post('/api/whatsapp/bridge/result', process.env.WA_BRIDGE_SECRET, { ...claimed.job, status:'available' });
    assert.equal(result.status,200);
    assert.equal((await db.getWhatsAppPreparation(created.id)).status,'ready');
    const rpc = await (await post('/api/mcp',process.env.MCP_TOKEN,{jsonrpc:'2.0',id:1,method:'tools/list'})).json();
    assert(rpc.result.tools.some(t => t.name === 'prepare_whatsapp_list'));
    assert.equal((await db.listCampaigns()).length,0);
  } finally { await new Promise(r => server.close(r)); }
});
