import { useEffect, useState } from 'react';
import { api } from '../api';
export default function Campaigns({ toast }) {
  const [rows, setRows] = useState([]), [campaign, setCampaign] = useState(null);
  const [busy, setBusy] = useState(false);
  async function reload() {
    try { setRows(await api.campaigns()); } catch (e) { toast('error', e.message); }
  }
  useEffect(() => { reload(); }, []);
  async function open(id) {
    try { setCampaign(await api.campaign(id)); } catch (e) { toast('error', e.message); }
  }
  async function save() {
    setBusy(true);
    try {
      setCampaign(await api.saveCampaign(campaign));
      toast('success', 'Draft edits saved.'); await reload();
    } catch (e) { toast('error', e.message); }
    finally { setBusy(false); }
  }
  return <section className="card" style={{ padding: 24 }}>
    <h2>WhatsApp campaigns</h2>
    <p>Review all messages with Claude first. Ask Claude to add the approved batch to your CRM, then review or edit it here.</p>
    <button className="btn" onClick={reload}>Refresh campaigns</button>
    {!rows.length && <p>No campaigns saved yet.</p>}
    {rows.map(row => <p key={row.id}><button className="btn" onClick={() => open(row.id)}>{row.name}</button> · {row.state}</p>)}
    {campaign && <div>
      <h3>{campaign.name}</h3>
      <p>Monday–Friday · maximum {campaign.schedule.dailyLimit}/day · {campaign.schedule.startHour}:00–{campaign.schedule.startHour + 12}:00 · {campaign.schedule.timeZone}</p>
      {campaign.drafts.map((draft, index) => <div key={draft.contractor_id} style={{ margin: '20px 0' }}>
        <label htmlFor={`draft-${index}`}>{index + 1}. {draft.business_name} · +{draft.number}</label>
        <textarea id={`draft-${index}`} rows={4} maxLength={4000} value={draft.message}
          style={{ display: 'block', width: '100%', marginTop: 8 }}
          onChange={e => setCampaign(current => ({ ...current, drafts: current.drafts.map((d, i) => i === index ? { ...d, message: e.target.value } : d) }))} />
      </div>)}
      <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save draft edits'}</button>
      <p>Sending setup is still in progress. These drafts cannot send yet.</p>
    </div>}
  </section>;
}
