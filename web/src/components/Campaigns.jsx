import { useEffect, useState } from 'react';
import { api } from '../api';
import { campaignMessage } from '../../../src/campaign-content.js';
const ZONES = ['Australia/Perth', 'Australia/Melbourne', 'Australia/Sydney', 'Australia/Brisbane', 'Australia/Adelaide', 'Australia/Darwin', 'Australia/Hobart'];
export default function Campaigns({ toast }) {
  const [rows, setRows] = useState([]), [campaign, setCampaign] = useState(null);
  const [busy, setBusy] = useState(false), [mode, setMode] = useState('disabled');
  const [health, setHealth] = useState(null);
  const [consent, setConsent] = useState(false);
  async function reload() {
    try { const [r, config] = await Promise.all([api.campaigns(), api.campaignConfig()]); setRows(r); setMode(config.mode); setHealth(config.health); }
    catch (e) { toast('error', e.message); }
  }
  useEffect(() => {
    reload();
    const timer = setInterval(() => { api.campaignConfig().then(c => { setHealth(c.health); setMode(c.mode); }).catch(() => setHealth({ alerts: ['Cannot reach CRM to check sender status.'], ready: false })); }, 30000);
    return () => clearInterval(timer);
  }, []);
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
    <div role="status" aria-live="polite" style={{ border: '1px solid #d5ded8', padding: 12, margin: '12px 0' }}>
      <p>Sender: {health?.fresh ? 'reporting' : 'not reporting'} · WhatsApp: {health?.gateway || 'unknown'}</p>
      {health?.reported_at && <p>Last report: {new Date(health.reported_at).toLocaleString()}</p>}
      {(health?.alerts || []).map(alert => <p key={alert} style={{ color: '#9b3419' }}>{alert}</p>)}
      <p>Status updates every 30 seconds while this page is open. Disconnected does not establish that a number is banned.</p>
    </div>
    <button className="btn" disabled={busy} onClick={reload}>Refresh campaigns</button>
    {!rows.length && <p>No campaigns saved yet.</p>}
    {rows.map(row => <p key={row.id}><button className="btn" disabled={busy} onClick={() => open(row.id)}>{row.name}</button> · {row.state}</p>)}
    {campaign && <div>
      <h3>{campaign.name} · {campaign.state}</h3>
      <p>Monday–Friday · maximum {campaign.schedule.dailyLimit}/day · 12-hour window</p>
      <label>Earliest sending date <input type="date" disabled={!editable || busy} value={campaign.schedule.startDate || ''}
        onChange={e => setCampaign(c => ({ ...c, schedule: { ...c.schedule, startDate: e.target.value } }))} /></label>
      <p>{campaign.schedule.startDate ? `No sends before ${campaign.schedule.startDate} in ${campaign.schedule.timeZone}. Weekdays and the selected daily window still apply.` : 'No date restriction: Start permits sending during the next eligible window.'}</p>
      <label>Recipient time zone <select disabled={!editable || busy} value={campaign.schedule.timeZone}
        onChange={e => setCampaign(c => ({ ...c, schedule: { ...c.schedule, timeZone: e.target.value } }))}>
        {[...new Set([...ZONES, campaign.schedule.timeZone])].map(zone => <option key={zone}>{zone}</option>)}
      </select></label>{' '}
      <label>Start hour <select disabled={!editable || busy} value={campaign.schedule.startHour}
        onChange={e => setCampaign(c => ({ ...c, schedule: { ...c.schedule, startHour: Number(e.target.value) } }))}>
        {Array.from({ length: 13 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00–{String(h + 12).padStart(2, '0')}:00</option>)}
      </select></label>
      <fieldset disabled={!editable || busy} style={{ margin: '16px 0', padding: 12 }}>
        <legend>Sender details included in every message</legend>
        {[['name','Your name'], ['business','Business name'], ['contact','Contact email, phone or HTTPS URL']].map(([key, label]) => <label key={key} style={{ display: 'block', marginBottom: 8 }}>{label}
          <input value={campaign.sender?.[key] || ''} maxLength={key === 'contact' ? 200 : 100} style={{ display: 'block', width: '100%' }}
            onChange={e => setCampaign(c => ({ ...c, sender: { ...c.sender, [key]: e.target.value } }))} />
        </label>)}
      </fieldset>
      {campaign.drafts.map((draft, index) => {
        const preview = campaignMessage({ ...draft, sender: campaign.sender });
        const delivery = campaign.deliveries?.find(d => d.contractor_id === draft.contractor_id);
        return <div key={draft.contractor_id} style={{ margin: '20px 0' }}>
          <label htmlFor={`draft-${index}`}>{index + 1}. {draft.business_name} · +{draft.number} · {delivery?.state || 'draft'}</label>
          {delivery?.detail && <p>{delivery.detail}</p>}
          <textarea id={`draft-${index}`} rows={4} maxLength={4000} value={draft.message} disabled={!editable || busy}
            style={{ display: 'block', width: '100%', marginTop: 8 }}
            onChange={e => setCampaign(c => ({ ...c, drafts: c.drafts.map((d, i) => i === index ? { ...d, message: e.target.value } : d) }))} />
          <fieldset disabled={!editable || busy} style={{ marginTop: 12, padding: 12 }}>
            <legend>Recipient permission record</legend>
            <label>Basis <select value={draft.permission?.basis || ''} onChange={e => setCampaign(c => ({ ...c, drafts: c.drafts.map((d, i) => i === index ? { ...d, permission: { ...d.permission, basis: e.target.value } } : d) }))}>
              <option value="">Choose a basis</option><option value="test">My own test number</option><option value="express">Express permission</option><option value="inferred">Inferred permission — explain basis</option>
            </select></label>
            <label style={{ display: 'block', marginTop: 8 }}>Evidence/source and date
              <textarea rows={2} maxLength={1000} value={draft.permission?.note || ''} style={{ display: 'block', width: '100%' }}
                onChange={e => setCampaign(c => ({ ...c, drafts: c.drafts.map((d, i) => i === index ? { ...d, permission: { ...d.permission, note: e.target.value } } : d) }))} />
            </label>
            <p>A public number or WhatsApp registration alone is not permission. This records your basis; it does not verify it.</p>
          </fieldset>
          <p>Message preview{!editable ? ' (signature from the saved batch)' : ''}</p>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', border: '1px solid #d5ded8', padding: 12 }}>{!editable && !draft.sender ? draft.message : preview}</pre>
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
