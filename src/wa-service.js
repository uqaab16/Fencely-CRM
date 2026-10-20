import * as db from './db.js';
import { checkWhatsAppRegistration, contractorWhatsAppNumber } from './whatsapp.js';

export function bridgeConfigured() { return (process.env.WA_BRIDGE_SECRET || '').length >= 32; }

export async function requestWhatsAppCheck(c) {
  if (bridgeConfigured() && contractorWhatsAppNumber(c)) {
    await db.queueWhatsAppCheck(c);
    return { ...c, whatsapp_check_queued: true };
  }
  return db.saveWhatsAppCheck(c.id, await checkWhatsAppRegistration(c));
}
