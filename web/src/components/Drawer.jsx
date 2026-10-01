import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import ScoreBadge from './ScoreBadge';

function waClass(status) {
  if (status === 'Advertises WhatsApp') return 'wa-ok';
  if (status === 'Mobile - unverified') return 'wa-mid';
  return 'wa-no';
}

const LOG_BUTTONS = [
  { channel: 'call', label: '📞 Called' },
  { channel: 'whatsapp', label: '💬 WhatsApp' },
  { channel: 'email', label: '✉️ Emailed' },
];

// Contractor detail drawer (GET /api/contractors/:id → record + activities + tasks).
// Main job: make it one-tap to record outside-CRM contact (📞/💬/✉️ quick-log),
// see last contacted / next follow-up / the open follow-up task, and mark
// manual replies via the one-tap "Replied" / "Interested" stage buttons.
export default function Drawer({ id, meta, refreshTick, onClose, onEdit, onDeleted, onMutated, toast }) {
  const [c, setC] = useState(null);
  const [loading, setLoading] = useState(true);
  const [noteBody, setNoteBody] = useState('');
  const [noteBusy, setNoteBusy] = useState(false);
  const [logBusy, setLogBusy] = useState('');
  const [stageBusy, setStageBusy] = useState(false);
  const [draft, setDraft] = useState(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [scoreInfo, setScoreInfo] = useState(null);
  const [scoreBusy, setScoreBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDue, setTaskDue] = useState('');
  const [taskBusy, setTaskBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setC(await api.contractor(id));
    } catch (err) {
      toast('error', err.message);
      onClose();
    } finally {
      setLoading(false);
    }
  }, [id, onClose, toast]);

  useEffect(() => {
    load();
  }, [load]);

  // A different contractor was opened: drop transient panel state so a draft
  // or note typed for the previous record never leaks into this one.
  useEffect(() => {
    setDraft(null);
    setScoreInfo(null);
    setNoteBody('');
    setTaskTitle('');
    setTaskDue('');
    setConfirmDelete(false);
  }, [id]);

  // External change (e.g. the edit form saved over this drawer): refetch.
  const firstTick = useRef(true);
  useEffect(() => {
    if (firstTick.current) {
      firstTick.current = false;
      return;
    }
    load();
  }, [refreshTick, load]);

  function changed() {
    load();
    onMutated && onMutated();
  }

  async function logContact(channel) {
    setLogBusy(channel);
    try {
      const r = await api.logContact(id, channel);
      toast('success', (r && r.message) || 'Logged — follow-up set in 4 days');
      changed();
    } catch (err) {
      toast('error', err.message);
    } finally {
      setLogBusy('');
    }
  }

  async function moveStage(stage) {
    if (!c || c.stage === stage) return;
    setStageBusy(true);
    try {
      await api.updateContractor(id, { stage });
      toast('success', `${c.business_name} → ${stage}`);
      changed();
    } catch (err) {
      toast('error', err.message);
    } finally {
      setStageBusy(false);
    }
  }

  async function addNote(e) {
    e.preventDefault();
    if (!noteBody.trim()) return;
    setNoteBusy(true);
    try {
      await api.addNote(id, noteBody.trim());
      setNoteBody('');
      changed();
    } catch (err) {
      toast('error', err.message);
    } finally {
      setNoteBusy(false);
    }
  }

  async function getDraft() {
    setDraftBusy(true);
    try {
      setDraft(await api.draft(id));
    } catch (err) {
      toast('error', err.message);
    } finally {
      setDraftBusy(false);
    }
  }

  async function explain() {
    setScoreBusy(true);
    try {
      setScoreInfo(await api.score(id));
    } catch (err) {
      toast('error', err.message);
    } finally {
      setScoreBusy(false);
    }
  }

  async function addTask(e) {
    e.preventDefault();
    if (!taskTitle.trim()) return;
    setTaskBusy(true);
    try {
      await api.createTask({ contractor_id: id, title: taskTitle.trim(), due_date: taskDue || '' });
      setTaskTitle('');
      setTaskDue('');
      toast('success', 'Follow-up task created.');
      changed();
    } catch (err) {
      toast('error', err.message);
    } finally {
      setTaskBusy(false);
    }
  }

  async function doneTask(task) {
    try {
      await api.doneTask(task.id);
      toast('success', `Done: ${task.title}`);
      changed();
    } catch (err) {
      toast('error', err.message);
    }
  }

  async function doDelete() {
    setDeleting(true);
    try {
      await api.deleteContractor(id);
      toast('success', `${c.business_name} deleted.`);
      onDeleted && onDeleted(id);
      onClose();
    } catch (err) {
      toast('error', err.message);
      setDeleting(false);
    }
  }

  function copyDraft() {
    if (!draft?.draft) return;
    const done = () => toast('success', 'Draft copied to clipboard.');
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(draft.draft).then(done, () => toast('error', 'Copy failed — select the text manually.'));
    } else {
      toast('error', 'Clipboard unavailable — select the text manually.');
    }
  }

  if (loading || !c) {
    return (
      <aside className="drawer">
        <button className="icon-btn drawer-close" onClick={onClose} aria-label="Close">✕</button>
        <div className="empty">
          <div className="spinner" /> Loading contractor…
        </div>
      </aside>
    );
  }

  const openTask = (c.tasks || []).find((t) => !t.done);
  const niches = c.niches || [];

  return (
    <aside className="drawer">
      <button className="icon-btn drawer-close" onClick={onClose} aria-label="Close">✕</button>

      <h2 className="drawer-name">{c.business_name}</h2>
      <p className="muted drawer-loc">
        {c.city || ''}{c.suburb ? `, ${c.suburb}` : ''} {c.state || ''}
        {c.contact_name ? ` • ${c.contact_name}` : ''}
      </p>
      <div className="tag-row">
        {niches.map((n) => (
          <span className="tag" key={n}>{n}</span>
        ))}
      </div>

      {/* Stage: dropdown + one-tap reply markers */}
      <div className="drawer-section">
        <div className="stage-row">
          <label className="stage-label" htmlFor="drawer-stage">Stage</label>
          <select
            id="drawer-stage"
            className="stage-select"
            value={c.stage}
            disabled={stageBusy}
            onChange={(e) => moveStage(e.target.value)}
          >
            {(meta.stages || []).map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="quick-stage-row">
          <span className="muted small">Got a reply?</span>
          <button className="btn btn-small" disabled={stageBusy || c.stage === 'Replied'} onClick={() => moveStage('Replied')}>
            ↩ Mark Replied
          </button>
          <button className="btn btn-small" disabled={stageBusy || c.stage === 'Interested'} onClick={() => moveStage('Interested')}>
            ⭐ Mark Interested
          </button>
        </div>
      </div>

      {/* Quick-log: the one-tap way to record contact made outside the CRM */}
      <div className="drawer-section log-section">
        <h3>Log contact</h3>
        <div className="log-btns">
          {LOG_BUTTONS.map((b) => (
            <button
              key={b.channel}
              className="btn log-btn"
              disabled={Boolean(logBusy)}
              onClick={() => logContact(b.channel)}
            >
              {logBusy === b.channel ? 'Logging…' : b.label}
            </button>
          ))}
        </div>
        <div className="contact-dates">
          <div>
            <span className="cd-label">Last contacted</span>
            <b>{c.last_contacted || 'Never'}</b>
          </div>
          <div>
            <span className="cd-label">Next follow-up</span>
            <b>{c.next_followup || '—'}</b>
          </div>
        </div>
        <div className="open-task-line">
          <span className="cd-label">Open follow-up</span>
          {openTask ? (
            <span>
              ⏳ {openTask.title}
              {openTask.due_date ? ` (due ${openTask.due_date})` : ''}
            </span>
          ) : (
            <span className="muted">None — logging a contact creates one automatically.</span>
          )}
        </div>
      </div>

      {/* Score */}
      <div className="drawer-section">
        <div className="score-row">
          <span>Lead score</span>
          <ScoreBadge score={c.lead_score} reasons={c.score_reasons} size="lg" />
          <button className="btn btn-small btn-ghost" onClick={explain} disabled={scoreBusy}>
            {scoreBusy ? 'Thinking…' : 'Explain score'}
          </button>
        </div>
        {(c.score_reasons || []).length > 0 && (
          <ul className="reason-list">
            {c.score_reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        )}
        {scoreInfo && (
          <div className="ai-panel">
            <p>{scoreInfo.explanation || scoreInfo.message || 'No explanation returned.'}</p>
            <p className="muted small">{scoreInfo.enabled ? 'Explained by Claude.' : 'Local rule-based score (Claude AI is off).'}</p>
          </div>
        )}
      </div>

      {/* Contact details */}
      <div className="drawer-section">
        <h3>Contact details</h3>
        <dl className="details">
          <dt>☎ Landline</dt>
          <dd>{c.landline || '—'}</dd>
          <dt>📱 Mobile</dt>
          <dd>{c.mobile || '—'}</dd>
          <dt>💬 WhatsApp</dt>
          <dd className={waClass(c.whatsapp_status)}>
            {c.whatsapp_number || '—'} <small>({c.whatsapp_status})</small>
          </dd>
          <dt>✉ Email</dt>
          <dd>{c.email || '—'}</dd>
          <dt>🌐 Website</dt>
          <dd>
            {c.website ? (
              <a href={c.website.startsWith('http') ? c.website : `https://${c.website}`} target="_blank" rel="noreferrer">
                {c.website}
              </a>
            ) : (
              '—'
            )}
          </dd>
          <dt>Source</dt>
          <dd>{c.source || '—'}</dd>
          <dt>Outcome</dt>
          <dd>{c.outcome || '—'}</dd>
        </dl>
        {c.notes && (
          <>
            <h4 className="sub-h">Notes</h4>
            <p className="notes-text">{c.notes}</p>
          </>
        )}
      </div>

      {/* Actions */}
      <div className="drawer-actions">
        <button className="btn" onClick={() => onEdit(c)}>Edit</button>
        <button className="btn btn-primary" onClick={getDraft} disabled={draftBusy}>
          {draftBusy ? 'Drafting…' : '✨ Draft outreach (Claude)'}
        </button>
        {!confirmDelete ? (
          <button className="btn btn-danger-ghost" onClick={() => setConfirmDelete(true)}>Delete</button>
        ) : (
          <span className="confirm-inline">
            Delete this contractor?
            <button className="btn btn-danger" onClick={doDelete} disabled={deleting}>
              {deleting ? 'Deleting…' : 'Yes, delete'}
            </button>
            <button className="btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
          </span>
        )}
      </div>

      {draft && (
        <div className="ai-panel draft-panel">
          <div className="draft-head">
            <b>{draft.enabled ? 'Claude draft' : 'Outreach draft (local template)'}</b>
            <button className="btn btn-small" onClick={copyDraft}>Copy</button>
          </div>
          <p className="draft-text">{draft.draft || draft.message || 'No draft returned.'}</p>
          <p className="muted small">
            {draft.enabled
              ? 'Generated by Claude — edit before sending.'
              : draft.message || 'Claude AI is off — this is the local template. Set ANTHROPIC_API_KEY on the server for Claude-personalised drafts.'}
          </p>
        </div>
      )}

      {/* Tasks for this contractor */}
      <div className="drawer-section">
        <h3>Tasks</h3>
        {(c.tasks || []).length === 0 && <p className="muted small">No tasks for this contractor yet.</p>}
        <ul className="task-list compact">
          {(c.tasks || []).map((t) => (
            <li key={t.id} className={`task-row${t.done ? ' task-done' : ''}`}>
              <span>{t.done ? '✅' : '⏳'}</span>
              <span className="task-main">
                {t.title}
                {t.due_date && <span className="task-due"> (due {t.due_date})</span>}
              </span>
              {!t.done && (
                <button className="btn btn-small" onClick={() => doneTask(t)}>Mark done</button>
              )}
            </li>
          ))}
        </ul>
        <form className="task-form" onSubmit={addTask}>
          <input placeholder="New follow-up task…" value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} />
          <input type="date" value={taskDue} onChange={(e) => setTaskDue(e.target.value)} />
          <button className="btn" disabled={taskBusy}>{taskBusy ? 'Adding…' : 'Add task'}</button>
        </form>
      </div>

      {/* Timeline */}
      <div className="drawer-section">
        <h3>Timeline</h3>
        <form className="note-form" onSubmit={addNote}>
          <input placeholder="Add note/activity…" value={noteBody} onChange={(e) => setNoteBody(e.target.value)} />
          <button className="btn" disabled={noteBusy}>{noteBusy ? 'Adding…' : 'Add'}</button>
        </form>
        {(c.activities || []).length === 0 && <p className="muted small">No activity yet.</p>}
        {(c.activities || []).map((a) => (
          <div className="activity" key={a.id}>
            <small className="muted">{a.created_at} • {a.type}</small>
            <div>{a.body}</div>
          </div>
        ))}
      </div>
    </aside>
  );
}
