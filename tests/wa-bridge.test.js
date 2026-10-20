import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-bridge-'));
process.env.CRM_DB_PATH = path.join(temp, 'db.sqlite');
for (const k of ['TURSO_HTTP_URL', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN']) delete process.env[k];
const db = await import('../src/db.js');
const { bridgeAuthorized, bridgeResult } = await import('../src/wa-bridge.js');
const { requestWhatsAppCheck } = await import('../src/wa-service.js');
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

test('bridge credential fails closed; rejects other credentials and unsafe results', () => {
  delete process.env.WA_BRIDGE_SECRET;
  assert.equal(bridgeAuthorized({ headers: {} }), false);
  process.env.WA_BRIDGE_SECRET = 'x'.repeat(48);
  assert.equal(bridgeAuthorized({ headers: { authorization: 'Bearer wrong' } }), false);
  assert.equal(bridgeAuthorized({ headers: { authorization: `Bearer ${process.env.WA_BRIDGE_SECRET}` } }), true);
  assert.throws(() => bridgeResult('61412345678', { status: 'sent' }), /Invalid/);
  assert.throws(() => bridgeResult('61412345678', { status: 'toString' }), /Invalid/);
  assert.equal(bridgeResult('61412345678', { status: 'not_found', detail: 'secret', jid: 'secret' }).jid, '');
});

test('queue coalesces clicks, leases atomically, expires safely and saves once', async () => {
  const c = await db.createContractor({ business_name: 'Private bridge test', mobile: '0412345678' });
  const queued = await requestWhatsAppCheck(c);
  assert.equal(queued.whatsapp_check_queued, true);
  await requestWhatsAppCheck(c);
  const jobs = await Promise.all([db.claimWhatsAppCheck(), db.claimWhatsAppCheck()]);
  const job = jobs.find(Boolean);
  assert.equal(jobs.filter(Boolean).length, 1);
  await assert.rejects(db.finishWhatsAppCheck(job.id, 'wrong', bridgeResult(job.number, { status: 'available' })), /lease/);
  const replacement = await db.claimWhatsAppCheck(Date.now() + 121000);
  assert.notEqual(replacement.token, job.token);
  await assert.rejects(db.finishWhatsAppCheck(job.id, job.token, bridgeResult(job.number, { status: 'available' })), /lease/);
  await db.finishWhatsAppCheck(replacement.id, replacement.token, bridgeResult(replacement.number, { status: 'available' }));
  await db.finishWhatsAppCheck(replacement.id, replacement.token, bridgeResult(replacement.number, { status: 'available' }));
  const saved = await db.getContractor(c.id);
  assert.equal(saved.whatsapp_verification.status, 'available');
  assert.equal(saved.activities.filter(a => a.type === 'whatsapp-check').length, 1);
  assert.equal(saved.last_contacted, '');
  assert.equal(saved.stage, 'New');
  await db.deleteContractor(c.id);
});

test('edited numbers reject in-flight results; deletion removes pending jobs', async () => {
  const c = await db.createContractor({ business_name: 'Phone edit', mobile: '0412345678' });
  await requestWhatsAppCheck(c);
  const job = await db.claimWhatsAppCheck();
  const changed = await db.updateContractor(c.id, { mobile: '0412999999' });
  await assert.rejects(db.finishWhatsAppCheck(job.id, job.token, bridgeResult(job.number, { status: 'available' })), /changed/);
  assert.equal((await db.getContractor(c.id)).whatsapp_verification.status, 'not_checked');
  await requestWhatsAppCheck(changed);
  await db.bulkDeleteContractors([c.id]);
  assert.equal(await db.claimWhatsAppCheck(), null);
});

test('HTTP bridge uses separate auth and cannot submit stage/contact changes', async () => {
  process.env.JWT_SECRET = 'test-login-secret';
  const { default: handler } = await import('../src/app.js');
  const { signToken } = await import('../src/auth.js');
  const app = http.createServer(handler);
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const call = (endpoint, token, body = {}) => fetch(base + endpoint, { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json',
  }, body: JSON.stringify(body) });
  try {
    const login = signToken({ email: 'test@example.test' });
    const secret = process.env.WA_BRIDGE_SECRET;
    assert.equal((await call('/api/whatsapp/bridge/claim', login)).status, 401);
    assert.equal((await call('/api/contractors', secret, { business_name: 'forged' })).status, 401);
    const c = await db.createContractor({ business_name: 'HTTP bridge', mobile: '0412345678' });
    const res = await call(`/api/contractors/${c.id}/whatsapp-check`, login);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).whatsapp_check_queued, true);
    const job = (await (await call('/api/whatsapp/bridge/claim', secret)).json()).job;
    assert.equal((await call('/api/whatsapp/bridge/result', secret, { ...job, status: 'sent' })).status, 400);
    const completed = await call('/api/whatsapp/bridge/result', secret, { ...job, status: 'not_found', stage: 'Customer', last_contacted: '2026-10-20' });
    assert.equal(completed.status, 200);
    const saved = await db.getContractor(c.id);
    assert.equal(saved.stage, 'New');
    assert.equal(saved.last_contacted, '');
    assert.equal(saved.whatsapp_verification.status, 'not_found');
    await db.deleteContractor(c.id);
  } finally { await new Promise(resolve => app.close(resolve)); }
});
