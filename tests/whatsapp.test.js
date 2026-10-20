import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { normaliseWhatsAppNumber, checkWhatsAppRegistration } from '../src/whatsapp.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-wa-'));
process.env.CRM_DB_PATH = path.join(temp, 'test.sqlite');
delete process.env.TURSO_HTTP_URL;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
const db = await import('../src/db.js');
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

test('normalises Australian mobile/landline and explicit international numbers; rejects guesses', () => {
  assert.equal(normaliseWhatsAppNumber('0412 345 678'), '61412345678');
  assert.equal(normaliseWhatsAppNumber('+61 (2) 1234 5678'), '61212345678');
  assert.equal(normaliseWhatsAppNumber('0092 300 1234567'), '923001234567');
  for (const raw of ['412345678', '1300123456', '0400abc111222', '+610412345678', '', '123']) {
    assert.equal(normaliseWhatsAppNumber(raw), null, raw);
  }
});

test('unconfigured gateway fails closed without making a network request', async () => {
  delete process.env.WA_AKG_URL;
  await assert.rejects(checkWhatsAppRegistration({ mobile: '0412345678' }, () => assert.fail('Unexpected fetch')), /not connected/);
  const invalid = await checkWhatsAppRegistration({ mobile: 'bad' }, () => assert.fail('Unexpected fetch'));
  assert.equal(invalid.status, 'invalid');
});

test('matches gateway results to requested number; errors never become unavailable', async () => {
  process.env.WA_AKG_URL = 'https://gateway.example.test';
  process.env.WA_AKG_API_KEY = 'test-key';
  process.env.WA_AKG_SESSION_ID = 'crm/session';
  const c = { mobile: '0412345678' };
  const number = '61412345678';
  const payload = result => ({ ok: true, json: async () => ({ status: true, data: { results: [result] } }) });
  const available = await checkWhatsAppRegistration(c, async (url, options) => {
    assert.equal(url.pathname, '/api/chat/crm%2Fsession/check');
    assert.equal(options.headers['X-API-Key'], 'test-key');
    assert.deepEqual(JSON.parse(options.body), { numbers: [number] });
    return payload({ number, exists: true, jid: `${number}@s.whatsapp.net` });
  });
  assert.equal(available.status, 'available');
  assert.equal((await checkWhatsAppRegistration(c, async () => payload({ number, exists: false }))).status, 'not_found');
  for (const result of [{ number, exists: false, error: 'failed' }, { number: 'other', exists: true }, { number }]) {
    assert.equal((await checkWhatsAppRegistration(c, async () => payload(result))).status, 'check_failed');
  }
  assert.equal((await checkWhatsAppRegistration(c, async () => ({ ok: false, status: 503 }))).status, 'check_failed');
  assert.equal((await checkWhatsAppRegistration(c, async () => { throw new Error('secret upstream data'); })).status, 'check_failed');
});

test('verification persists separately, cannot be forged through normal updates, and invalidates on phone edit', async () => {
  const c = await db.createContractor({ business_name: 'WA Test', mobile: '0412345678', whatsapp_status: 'Unknown' });
  const result = { number: '61412345678', status: 'available', checked_at: new Date().toISOString(), detail: 'Found', jid: '' };
  const checked = await db.saveWhatsAppCheck(c.id, result);
  assert.equal(checked.whatsapp_verification.status, 'available');
  assert.equal(checked.whatsapp_status, 'Unknown');
  assert.ok(checked.activities.some(a => a.type === 'whatsapp-check'));
  assert.equal((await db.listContractors({ whatsapp_verification: 'available' })).length, 1);
  const changed = await db.updateContractor(c.id, { mobile: '0412999999', wa_check_status: 'available' });
  assert.equal(changed.whatsapp_verification.status, 'not_checked');
  await assert.rejects(db.saveWhatsAppCheck(c.id, result), /changed/);
  await db.deleteContractor(c.id);
  assert.equal(await db.getContractor(c.id), null);
});

test('HTTP check requires login and saves gateway results without logging an outbound contact', async () => {
  process.env.JWT_SECRET = 'local-test-secret';
  const { default: handler } = await import('../src/app.js');
  const { signToken } = await import('../src/auth.js');
  let gatewayCalls = 0;
  const gateway = http.createServer(async (req, res) => {
    gatewayCalls++;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const number = JSON.parse(raw).numbers[0];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: true, data: { results: [{ number, exists: true }] } }));
  });
  const app = http.createServer(handler);
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  try {
    process.env.WA_AKG_URL = `http://127.0.0.1:${gateway.address().port}`;
    const base = `http://127.0.0.1:${app.address().port}`;
    const c = await db.createContractor({ business_name: 'HTTP Test', mobile: '0412345678' });
    const endpoint = `${base}/api/contractors/${c.id}/whatsapp-check`;
    assert.equal((await fetch(endpoint, { method: 'POST' })).status, 401);
    assert.equal(gatewayCalls, 0);
    const headers = { authorization: `Bearer ${signToken({ email: 'test@example.test' })}` };
    const result = await fetch(endpoint, { method: 'POST', headers });
    assert.equal(result.status, 200);
    const checked = await result.json();
    assert.equal(checked.whatsapp_verification.status, 'available');
    assert.equal(checked.last_contacted, '');
    assert.equal(checked.stage, 'New');
    assert.equal(checked.tasks.length, 0);
    assert.equal(gatewayCalls, 1);
    delete process.env.WA_AKG_URL;
    assert.equal((await fetch(endpoint, { method: 'POST', headers })).status, 503);
    assert.equal((await db.getContractor(c.id)).whatsapp_verification.status, 'available');
  } finally {
    await Promise.all([new Promise(resolve => app.close(resolve)), new Promise(resolve => gateway.close(resolve))]);
  }
});
