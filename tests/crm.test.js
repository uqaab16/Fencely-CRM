import test from 'node:test';
import assert from 'node:assert';

process.env.CRM_DB_PATH = '/tmp/fencely-crm-test.sqlite';
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.TURSO_HTTP_URL;
import fs from 'node:fs';
try { fs.unlinkSync('/tmp/fencely-crm-test.sqlite'); } catch {}
try { fs.unlinkSync('/tmp/fencely-crm-test.sqlite-wal'); } catch {}
try { fs.unlinkSync('/tmp/fencely-crm-test.sqlite-shm'); } catch {}

const db = await import('../src/db.js');
const { parseCsv, toCsv } = await import('../src/csv.js');
await db.init();

test('scoreLead rewards WhatsApp + email + fit niche', () => {
  const s = db.scoreLead({ whatsapp_status: 'Advertises WhatsApp', mobile: '0400', email: 'a@b.co', website: 'https://x', niches: ['Colorbond'] });
  assert.ok(s.score >= 60, `score ${s.score}`);
  assert.ok(s.reasons.length >= 4);
});

test('create + dedupe + update + stage', async () => {
  const c = await db.createContractor({ business_name: 'Test Fencing', state: 'nsw', city: 'Sydney', mobile: '0400 111 222', email: 't@example.com', niches: ['Timber'] });
  assert.ok(c.id); assert.equal(c.state, 'NSW');
  const dupes = await db.findDuplicates({ business_name: 'Other', mobile: '0400111222' });
  assert.equal(dupes.length, 1);
  const u = await db.updateContractor(c.id, { stage: 'Contacted' });
  assert.equal(u.stage, 'Contacted');
  assert.ok(u.activities.some(a => a.type === 'stage'));
});

test('tasks + followups due', async () => {
  const c = (await db.listContractors())[0];
  await db.createTask({ contractor_id: c.id, title: 'Follow up', due_date: '2000-01-01' });
  assert.ok((await db.listTasks({ dueToday: true })).length >= 1);
});

test('csv round trip', async () => {
  const out = toCsv(await db.listContractors());
  assert.ok(out.includes('business_name'));
  const parsed = parseCsv(out);
  assert.ok(parsed.length >= 1);
  assert.ok(parsed[0].business_name);
});

test('legacy "Mobile - unverified" is renamed to "WhatsApp - unverified"', async () => {
  const c = await db.createContractor({ business_name: 'Legacy WA Fencing', mobile: '0400 777 888', whatsapp_status: 'Mobile - unverified' });
  assert.equal(c.whatsapp_status, 'WhatsApp - unverified');
});

test('logContact: stage transition + last_contacted + follow-up task only once', async () => {
  const c = await db.createContractor({ business_name: 'Log Contact Fencing', state: 'VIC', city: 'Geelong', mobile: '0400 555 666', niches: ['Colorbond'] });
  assert.equal(c.stage, 'New');
  const today = new Date().toISOString().slice(0, 10);
  const expectedDue = new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10);

  const after1 = await db.logContact(c.id, { channel: 'whatsapp', note: 'Intro message', outcome: 'No reply yet' });
  assert.equal(after1.stage, 'Contacted');
  assert.equal(after1.last_contacted, today);
  assert.equal(after1.outcome, 'No reply yet');
  assert.ok(after1.activities.some(a => a.type === 'contact' && a.body.includes('WhatsApp message sent')));
  const open1 = after1.tasks.filter(t => !t.done);
  assert.equal(open1.length, 1);
  assert.equal(open1[0].title, 'Follow up with Log Contact Fencing');
  assert.equal(open1[0].due_date, expectedDue);

  const after2 = await db.logContact(c.id, { channel: 'call' });
  assert.equal(after2.stage, 'Follow-up Due');
  assert.equal(after2.last_contacted, today);
  assert.ok(after2.activities.some(a => a.type === 'contact' && a.body.includes('Call made')));
  assert.equal(after2.tasks.filter(t => !t.done).length, 1, 'second contact must not create a duplicate follow-up task');
});

test('bulkCreateContractors inserts rows fast with timeline entries', async () => {
  const n = await db.bulkCreateContractors([
    { business_name: 'Bulk A Fencing', state: 'NSW', city: 'Sydney', mobile: '0400 900 001' },
    { business_name: 'Bulk B Fencing', state: 'VIC', city: 'Melbourne', email: 'b@example.com' },
    { business_name: 'Bulk C Fencing', state: 'QLD', city: 'Brisbane', landline: '07 3000 0003' },
  ]);
  assert.equal(n, 3);
  const rows = (await db.listContractors()).filter((c) => c.business_name.startsWith('Bulk '));
  assert.equal(rows.length, 3);
  for (const r of rows) {
    const full = await db.getContractor(r.id);
    assert.ok(full.activities.some((a) => a.type === 'created'), `created activity for ${r.business_name}`);
  }
});

test('bulkSetStage moves many + rejects bad stage', async () => {
  const rows = (await db.listContractors()).filter((c) => c.business_name.startsWith('Bulk '));
  const ids = rows.map((r) => r.id);
  const updated = await db.bulkSetStage(ids, 'Contacted');
  assert.equal(updated, 3);
  const one1 = await db.getContractor(ids[0]);
  assert.equal(one1.stage, 'Contacted');
  await assert.rejects(db.bulkSetStage(ids, 'Nope'), /Invalid stage/);
});

test('bulkDeleteContractors removes rows + their activities/tasks', async () => {
  const rows = (await db.listContractors()).filter((c) => c.business_name.startsWith('Bulk '));
  const ids = rows.map((r) => r.id);
  await db.createTask({ contractor_id: ids[0], title: 'bulk task', due_date: '2000-01-01' });
  const deleted = await db.bulkDeleteContractors(ids);
  assert.equal(deleted, 3);
  assert.equal((await db.listContractors()).filter((c) => c.business_name.startsWith('Bulk ')).length, 0);
  assert.equal(await db.bulkDeleteContractors([]), 0);
});

test('seedIfEmpty is opt-in (no auto seed without SEED_SAMPLE_DATA=1)', async () => {
  delete process.env.SEED_SAMPLE_DATA;
  assert.equal(await db.seedIfEmpty(), 0);
});
