import { useState } from 'react';
import ScoreBadge from './ScoreBadge';

// Pipeline board: one column per stage (from /api/meta). Cards can be dragged
// between columns (HTML5 drag events) or stepped with the ← / → buttons; both
// end in PUT /api/contractors/:id {stage} via onMoveStage.
// Compact one-tap contact logging for a Kanban card (call / WhatsApp / email).
// Logging only — this records contact made outside the CRM, it never sends.
function CardLogButtons({ contractor, onLogContact, busyChannel }) {
  const buttons = [
    { channel: 'call', label: '📞', title: 'Log: called' },
    { channel: 'whatsapp', label: '💬', title: 'Log: WhatsApp message sent' },
    { channel: 'email', label: '✉️', title: 'Log: emailed' },
  ];
  return (
    <span className="card-log" onClick={(e) => e.stopPropagation()}>
      {buttons.map((b) => (
        <button
          key={b.channel}
          className="mini-btn log-mini"
          title={b.title}
          disabled={Boolean(busyChannel)}
          onClick={() => onLogContact(contractor, b.channel)}
        >
          {busyChannel === b.channel ? '…' : b.label}
        </button>
      ))}
    </span>
  );
}

export default function Kanban({ contractors, meta, onOpen, onMoveStage, onLogContact }) {
  const [dragId, setDragId] = useState(null);
  const [overStage, setOverStage] = useState(null);
  const [logBusy, setLogBusy] = useState({}); // contractorId -> channel being logged
  const stages = meta.stages || [];

  async function handleLog(contractor, channel) {
    setLogBusy((s) => ({ ...s, [contractor.id]: channel }));
    try {
      await onLogContact(contractor, channel);
    } catch {
      // Error already surfaced via toast by the parent handler.
    } finally {
      setLogBusy((s) => ({ ...s, [contractor.id]: '' }));
    }
  }

  function drop(stage) {
    setOverStage(null);
    if (dragId == null) return;
    const c = contractors.find((x) => x.id === dragId);
    setDragId(null);
    if (c && c.stage !== stage) onMoveStage(c, stage);
  }

  return (
    <div className="kanban">
      {stages.map((stage, i) => {
        const cards = contractors.filter((c) => c.stage === stage);
        return (
          <div
            key={stage}
            className={`col${overStage === stage ? ' col-over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setOverStage(stage);
            }}
            onDragLeave={() => setOverStage((s) => (s === stage ? null : s))}
            onDrop={() => drop(stage)}
          >
            <h4>
              {stage} <span className="col-count">{cards.length}</span>
            </h4>
            {cards.length === 0 && <div className="col-empty">No contractors here yet</div>}
            {cards.map((c) => (
              <div
                key={c.id}
                className={`card${dragId === c.id ? ' card-dragging' : ''}`}
                draggable
                onDragStart={(e) => {
                  setDragId(c.id);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', String(c.id));
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setOverStage(null);
                }}
                onClick={() => onOpen(c.id)}
              >
                <div className="card-top">
                  <b>{c.business_name}</b>
                  <ScoreBadge score={c.lead_score} size="sm" />
                </div>
                <small className="muted">
                  {c.city || ''} {c.state || ''}
                </small>
                <div className="card-tags">
                  {(c.niches || []).map((n) => (
                    <span className="tag" key={n}>{n}</span>
                  ))}
                </div>
                <div className="card-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="mini-btn"
                    disabled={i === 0}
                    title={i > 0 ? `Move back to ${stages[i - 1]}` : 'First stage'}
                    onClick={() => onMoveStage(c, stages[i - 1])}
                  >
                    ←
                  </button>
                  <button
                    className="mini-btn"
                    disabled={i === stages.length - 1}
                    title={i < stages.length - 1 ? `Move to ${stages[i + 1]}` : 'Last stage'}
                    onClick={() => onMoveStage(c, stages[i + 1])}
                  >
                    →
                  </button>
                  {onLogContact && (
                    <CardLogButtons contractor={c} busyChannel={logBusy[c.id] || ''} onLogContact={handleLog} />
                  )}
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
