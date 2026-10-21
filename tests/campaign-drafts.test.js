import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dir = mkdtempSync(path.join(tmpdir(), 'campaign-drafts-'));
process.env.CRM_DB_PATH = path.join(dir, 'test.sqlite');
delete process.env.TURSO_DATABASE_URL; delete process.env.TURSO_AUTH_TOKEN; delete process.env.TURSO_HTTP_URL;
const db = await import('../src/db.js');
test('reviewed batches save atomically, edit with revision, reject suppression and duplicates', async () => {
  const a = await db.createContractor({ business_name: 'A', mobile: '0412345678' });
  const b = await db.createContractor({ business_name: 'B', mobile: '0412345679' });
  const input = { name: 'Reviewed batch', schedule: { timeZone: 'Australia/Perth' },
    drafts: [{ contractor_id: a.id, message: 'Hello A' }, { contractor_id: b.id, message: 'Hello B' }] };
  const saved = await db.saveCampaignDrafts(input);
  assert.equal(saved.state, 'draft'); assert.equal(saved.drafts.length, 2);
  const edited = await db.saveCampaignDrafts({ ...saved, drafts: saved.drafts.map(d => ({ ...d, message: 'Updated' })) });
  assert.equal(edited.revision, 2);
  await assert.rejects(() => db.saveCampaignDrafts(saved), /changed/);
  await assert.rejects(() => db.saveCampaignDrafts({ ...input, drafts: [input.drafts[0], input.drafts[0]] }), /different/);
  await db.updateContractor(b.id, { stage: 'Do Not Contact' });
  await assert.rejects(() => db.saveCampaignDrafts(input), /opted out/);
  assert.equal((await db.listCampaigns()).length, 1);
  assert.equal((await db.getCampaign(saved.id)).drafts[0].message, 'Updated');
});
test.after(() => rmSync(dir, { recursive: true, force: true }));
