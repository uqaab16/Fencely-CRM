import test from 'node:test';
import assert from 'node:assert/strict';
import { campaignMessage, assertCampaignContent } from '../src/campaign-content.js';
const draft = { message: 'Reviewed message', sender: { name: 'Actual Sender', business: 'Example', contact: 'sender@example.test' }, permission: { basis: 'express', note: 'Permission by phone, 2026-10-21' } };
test('preview and sending share a plain-text identity/contact/STOP signature', () => {
  const message = assertCampaignContent(draft, 'live');
  assert.equal(message, campaignMessage(draft));
  assert.equal(message, 'Reviewed message\n\nActual Sender · Example · sender@example.test\nReply STOP to opt out.');
});
test('identity, contact, length and permission are enforced before delivery', () => {
  for (const patch of [{ sender: {} }, { sender: { ...draft.sender, contact: 'not a contact' } }, { permission: {} }, { permission: { basis: 'express', note: '' } }, { message: 'x'.repeat(3999) }])
    assert.throws(() => assertCampaignContent({ ...draft, ...patch }, 'live'));
  const own = { ...draft, permission: { basis: 'test', note: 'My own number' } };
  assert.doesNotThrow(() => assertCampaignContent(own, 'test'));
  assert.throws(() => assertCampaignContent(own, 'live'), /test permission/);
});
