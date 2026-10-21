import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-full-'));
process.env.CRM_DB_PATH = path.join(temp,'db.sqlite');
for (const k of ['TURSO_DATABASE_URL','TURSO_AUTH_TOKEN','TURSO_HTTP_URL']) delete process.env[k];
const db = await import('../src/db.js');
const { bridgeResult } = await import('../src/wa-bridge.js');
test.after(() => fs.rmSync(temp,{recursive:true,force:true}));
test('whole CRM scan crosses cities, reuses recent checks, checks stale/error results and preserves state', async () => {
  const leads=[];
  for(let i=1;i<=25;i++) leads.push(await db.createContractor({business_name:'Lead '+i,city:i%2?'Sydney':'Perth',state:i%2?'NSW':'WA',mobile:'+614'+String(i).padStart(8,'0')}));
  for(const [i,status,days] of [[0,'available',0],[1,'not_found',0],[2,'check_failed',0],[3,'available',8]]) {
    const number=leads[i].mobile.replace('+','');
    await db.saveWhatsAppCheck(leads[i].id,{number,status,checked_at:new Date(Date.now()-days*86400000).toISOString(),detail:'fixture'});
  }
  const scan=await db.createWhatsAppPreparation({scope:'all'});
  assert.equal(scan.total_candidates,25);
  assert.equal((await db.createWhatsAppPreparation({scope:'all'})).id,scan.id);
  const checked=[];
  for(let i=0;i<40;i++) {
    const job=await db.claimWhatsAppPreparation();
    if(job) {checked.push(job.contractor_id);await db.finishWhatsAppPreparation(job.id,job.token,bridgeResult(job.number,{status:'available'}));}
    if((await db.getWhatsAppPreparation(scan.id)).status==='exhausted') break;
  }
  const result=await db.getWhatsAppPreparation(scan.id);
  assert.equal(result.processed,25); assert.equal(result.available_count,24); assert.equal(result.status,'exhausted');
  assert(!checked.includes(leads[0].id));assert(!checked.includes(leads[1].id));
  assert(checked.includes(leads[2].id));assert(checked.includes(leads[3].id));
  assert(result.available.some(r=>r.city==='Perth'&&r.state==='WA'));
  assert.equal((await db.listCampaigns()).length,0);
  assert.equal((await db.getContractor(leads[0].id)).stage,'New');
  const city=await db.createWhatsAppPreparation({city:'Sydney',target:2});
  assert.equal(await db.claimWhatsAppPreparation(),null);
  assert.equal((await db.getWhatsAppPreparation(city.id)).available_count,2);
  const changed=leads[0];await db.updateContractor(changed.id,{mobile:'+61499999999'});
  assert.equal((await db.getContractor(changed.id)).whatsapp_verification.status,'not_checked');
});
