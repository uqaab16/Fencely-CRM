import { useEffect, useState } from 'react';
import { api } from '../api';
const ZONES = ['Australia/Perth', 'Australia/Melbourne', 'Australia/Sydney', 'Australia/Brisbane', 'Australia/Adelaide', 'Australia/Darwin', 'Australia/Hobart'];
export default function Campaigns({ toast }) {
  const [rows, setRows] = useState([]), [campaign, setCampaign] = useState(null);
  const [busy, setBusy] = useState(false), [mode, setMode] = useState('disabled');
  const [consent, setConsent] = useState(false);
  async function reload() {
    try { const [r, config] = await Promise.all([api.campaigns(), api.campaignConfig()]); setRows(r); setMode(config.mode); }
    catch (e) { toast('error', e.message); }
  }
  useEffect(() => { reload(); }, []);
  async function open(id) {
    try { setCampaign(await api.campaign(id)); setConsent(false); } catch (e) { toast('error', e.message); }
  }
  async function action(kind) {
    setBusy(true);
    try {
      let current = campaign;
      if ((kind === 'save' || kind === 'start') && current.state === 'draft') current = await api.saveCampaign(current);
      if (kind === 'start') current = await api.startCampaign(current.id, current.revision, consent);
      if (kind === 'pause') current = await api.pauseCampaign(current.id);
      setCampaign(current);
      toast('success', kind === 'start' ? 'Campaign started. Messages send during its selected window.' : kind === 'pause' ? 'Campaign paused. An already authorized send may still finish.' : 'Draft edits saved.');
      await reload();
    } catch (e) { toast('error', e.message); }
    finally { setBusy(false); }
  }
  const editable = campaign?.state === 'draft';
  return <section className="card" style={{ padding: 24 }}>
    <h2>WhatsApp campaigns</h2>
    <p>Review messages with Claude, then ask Claude to add the approved batch to CRM. Review the batch here before starting.</p>
    <p>{mode === 'disabled' ? 'Sender setup is not enabled yet.' : mode === 'test' ? 'Test mode: only your configured test numbers can receive messages.' : 'Sending enabled. The VPS sender must be running.'}</p>
    <button className="btn" disabled={busy} onClick={reload}>Refresh campaigns</button>
    {!rows.length && <p>No campaigns saved yet.</p>}
    {rows.map(row => <p key={row.id}><button className="btn" disabled={busy} onClick={() => open(row.id)}>{row.name}</button> · {row.state}</p>)}
    {campaign && <div>
      <h3>{campaign.name} · {campaign.state}</h3>
      <p>Monday–Friday · maximum {campaign.schedule.dailyLimit}/day · 12-hour window</p>
      <label>Recipient time zone <select disabled={!editable || busy} value={campaign.schedule.timeZone}
        onChange={e => setCampaign(c => ({ ...c, schedule: { ...c.schedule, timeZone: e.target.value } }))}>
        {[...new Set([...ZONES, campaign.schedule.timeZone])].map(zone => <option key={zone}>{zone}</option>)}
      </select></label>{' '}
      <label>Start hour <select disabled={!editable || busy} value={campaign.schedule.startHour}
        onChange={e => setCampaign(c => ({ ...c, schedule: { ...c.schedule, startHour: Number(e.target.value) } }))}>
        {Array.from({ length: 13 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00–{String(h + 12).padStart(2, '0')}:00</option>)}
      </select></label>
      {campaign.drafts.map((draft, index) => {
        const delivery = campaign.deliveries?.find(d => d.contractor_id === draft.contractor_id);
        return <div key={draft.contractor_id} style={{ margin: '20px 0' }}>
          <label htmlFor={`draft-${index}`}>{index + 1}. {draft.business_name} · +{draft.number} · {delivery?.state || 'draft'}</label>
          {delivery?.detail && <p>{delivery.detail}</p>}
          <textarea id={`draft-${index}`} rows={4} maxLength={4000} value={draft.message} disabled={!editable || busy}
            style={{ display: 'block', width: '100%', marginTop: 8 }}
            onChange={e => setCampaign(c => ({ ...c, drafts: c.drafts.map((d, i) => i === index ? { ...d, message: e.target.value } : d) }))} />
        </div>;
      })}
      {editable && <button className="btn" disabled={busy} onClick={() => action('save')}>Save draft edits</button>}
      {['draft', 'paused'].includes(campaign.state) && <>
        <p><label><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} /> I have permission to message these recipients and approve these messages.</label></p>
        <button className="btn btn-primary" disabled={busy || !consent || mode === 'disabled'} onClick={() => action('start')}>{campaign.state === 'paused' ? 'Resume' : 'Start'}</button>
      </>}
      {['running', 'starting'].includes(campaign.state) && <button className="btn" disabled={busy} onClick={() => action('pause')}>Pause</button>}
      <button className="btn" disabled={busy} onClick={() => open(campaign.id)}>Reload status</button>
      <p>Saving never sends. Started batches are locked against editing. Unknown send outcomes are never retried automatically. Sent means the gateway accepted the message; it does not confirm delivery or reading.</p>
    </div>}
  </section>;
}
