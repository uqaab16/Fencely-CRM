// Shared by the API and preview UI. Do not infer a person's identity or permission.
export function normaliseSender(input = {}) {
  const field = (key, max) => {
    const value = typeof input[key] === 'string' ? input[key].trim() : '';
    if (value.length > max || /[\r\n\x00-\x1f]/.test(value)) throw new Error(`Invalid sender ${key}.`);
    return value;
  };
  return { name: field('name', 100), business: field('business', 100), contact: field('contact', 200) };
}
export function campaignMessage(draft) {
  const s = normaliseSender(draft.sender);
  const identity = [s.name, s.business, s.contact].filter(Boolean).join(' · ');
  return `${draft.message.trim()}${identity ? '\n\n' + identity : ''}\nReply STOP to opt out.`;
}
export function assertCampaignContent(draft, mode) {
  const s = normaliseSender(draft.sender);
  if (!s.name || !s.business || !s.contact) throw new Error('Add sender name, business and contact details before starting.');
  if (!(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.contact) || /^\+?[1-9][\d ().-]{7,24}$/.test(s.contact) || /^https:\/\/[^\s/]+\.[^\s/]+(?:\/[^\s]*)?$/.test(s.contact)))
    throw new Error('Sender contact must be an email, international phone number or HTTPS contact URL.');
  const p = draft.permission || {};
  if (!['express', 'inferred', 'test'].includes(p.basis) || typeof p.note !== 'string' || !p.note.trim())
    throw new Error('Record the permission basis and supporting details for each recipient.');
  if (mode === 'live' && p.basis === 'test') throw new Error('Own-number test permission cannot be used for live outreach.');
  const message = campaignMessage(draft);
  if (message.length > 4000) throw new Error('Message including identity and STOP text must be at most 4000 characters.');
  return message;
}
