import test from 'node:test';
import assert from 'node:assert/strict';
import { campaignSlotAt, validateCampaignSchedule } from '../src/campaign-schedule.js';
const perth = { timeZone: 'Australia/Perth' };
test('weekday window boundaries and spaced slots', () => {
  assert.equal(campaignSlotAt('2026-10-19T23:59:59Z', perth), null);
  assert.equal(campaignSlotAt('2026-10-20T00:00:00Z', perth).slot, 0);
  assert.equal(campaignSlotAt('2026-10-20T00:35:59Z', perth).slot, 0);
  assert.equal(campaignSlotAt('2026-10-20T00:36:00Z', perth).slot, 1);
  assert.equal(campaignSlotAt('2026-10-20T11:59:59Z', perth).slot, 19);
  assert.equal(campaignSlotAt('2026-10-20T12:00:00Z', perth), null);
  assert.equal(campaignSlotAt('2026-10-24T00:00:00Z', perth), null);
  assert.equal(campaignSlotAt('2026-10-25T00:00:00Z', perth), null);
});
test('Melbourne daylight saving is applied by date', () => {
  const melbourne = { timeZone: 'Australia/Melbourne' };
  assert.equal(campaignSlotAt('2026-07-20T22:00:00Z', melbourne).slot, 0);
  assert.equal(campaignSlotAt('2026-10-19T21:00:00Z', melbourne).slot, 0);
  assert.equal(campaignSlotAt('2026-10-19T20:59:59Z', melbourne), null);
});
test('rejects invalid limits, weekend days, zones and overnight windows', () => {
  for (const change of [{ dailyLimit: 21 }, { dailyLimit: 0 }, { weekdays: [6] },
    { weekdays: [] }, { startHour: 13 }, { windowHours: 13 }, { timeZone: 'UTC' }])
    assert.throws(() => validateCampaignSchedule({ ...perth, ...change }));
});
