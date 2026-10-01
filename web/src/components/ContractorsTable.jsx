import { useState } from 'react';
import ScoreBadge from './ScoreBadge';

function waClass(status) {
  if (status === 'Advertises WhatsApp') return 'wa-ok';
  if (status === 'Mobile - unverified') return 'wa-mid';
  return 'wa-no';
}

const LOG_BUTTONS = [
  { channel: 'call', icon: '📞', title: 'Log: called this contractor' },
  { channel: 'whatsapp', icon: '💬', title: 'Log: WhatsApp message sent' },
  { channel: 'email', icon: '✉️', title: 'Log: emailed this contractor' },
];

// Contractors grid. Row click opens the detail drawer; the Stage cell is a
// dropdown for one-click pipeline moves (PUT /api/contractors/:id {stage}),
// and each row carries compact quick-log buttons (📞 💬 ✉️) that record
// outside-CRM contact in one tap (POST /api/contractors/:id/log-contact).
export default function ContractorsTable({ contractors, meta, loading, total, onOpen, onMoveStage, onLogContact }) {
  const [logging, setLogging] = useState(null); // { id, channel } while a log call is in flight

  async function log(c, channel) {
    setLogging({ id: c.id, channel });
    try {
      await onLogContact(c, channel);
    } catch {
      // Error toast already shown by the parent handler.
    } finally {
      setLogging(null);
    }
  }

  if (loading) {
    return (
      <div className="panel empty">
        <div className="spinner" /> Loading contractors…
      </div>
    );
  }
  if (!contractors.length) {
    return (
      <div className="panel empty">
        <p className="empty-title">No contractors match</p>
        <p className="empty-sub">
          {total === 0
            ? 'Your CRM is empty — add a contractor or import a CSV to get started.'
            : 'Try loosening the search or filters above.'}
        </p>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="grid">
        <thead>
          <tr>
            <th>Business</th>
            <th>State/City</th>
            <th>Niches</th>
            <th>Landline</th>
            <th>Mobile</th>
            <th>WhatsApp</th>
            <th>Email</th>
            <th>Stage</th>
            <th>Quick log</th>
            <th>Score</th>
            <th>Next follow-up</th>
          </tr>
        </thead>
        <tbody>
          {contractors.map((c) => (
            <tr key={c.id} onClick={() => onOpen(c.id)}>
              <td>
                <b>{c.business_name}</b>
                {c.contact_name ? (
                  <>
                    <br />
                    <small className="muted">{c.contact_name}</small>
                  </>
                ) : null}
              </td>
              <td>
                {c.state || '—'}
                <br />
                <span className="muted">
                  {c.city || ''}
                  {c.suburb ? ` · ${c.suburb}` : ''}
                </span>
              </td>
              <td>
                {(c.niches || []).map((n) => (
                  <span className="tag" key={n}>{n}</span>
                ))}
              </td>
              <td className="nowrap">{c.landline || <span className="muted">—</span>}</td>
              <td className="nowrap">{c.mobile || <span className="muted">—</span>}</td>
              <td className={waClass(c.whatsapp_status)}>
                {c.whatsapp_number || '—'}
                <br />
                <small>{c.whatsapp_status}</small>
              </td>
              <td className="email-cell">{c.email || <span className="muted">—</span>}</td>
              <td onClick={(e) => e.stopPropagation()}>
                <select
                  className="stage-select"
                  value={c.stage}
                  onChange={(e) => onMoveStage(c, e.target.value)}
                  aria-label={`Stage for ${c.business_name}`}
                >
                  {(meta.stages || []).map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </td>
              <td onClick={(e) => e.stopPropagation()}>
                <span className="row-log">
                  {LOG_BUTTONS.map((b) => (
                    <button
                      key={b.channel}
                      className="mini-btn log-mini"
                      title={b.title}
                      aria-label={`${b.title} — ${c.business_name}`}
                      disabled={Boolean(logging)}
                      onClick={() => log(c, b.channel)}
                    >
                      {logging && logging.id === c.id && logging.channel === b.channel ? '…' : b.icon}
                    </button>
                  ))}
                </span>
              </td>
              <td onClick={(e) => e.stopPropagation()}>
                <ScoreBadge score={c.lead_score} reasons={c.score_reasons} />
              </td>
              <td className="nowrap">{c.next_followup || <span className="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
