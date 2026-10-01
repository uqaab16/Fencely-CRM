// Dashboard strip: headline counts from GET /api/stats plus a by-stage
// summary (clicking a stage pill jumps to the Pipeline view).
export default function StatsStrip({ stats, onStageClick }) {
  if (!stats) {
    return (
      <section className="stats">
        <div className="stat stat-loading">Loading stats…</div>
      </section>
    );
  }
  const cards = [
    ['Total contractors', stats.total],
    ['Contacted', stats.contacted],
    ['Replied', stats.replied],
    ['Interested+', stats.interested],
    ['WhatsApp advertised', stats.whatsappAdvertised],
    ['Follow-ups due today', stats.followupsDueToday],
  ];
  const stages = Object.entries(stats.byStage || {});
  return (
    <section className="stats-wrap">
      <div className="stats">
        {cards.map(([label, value]) => (
          <div className="stat" key={label}>
            <b>{value ?? 0}</b>
            <span>{label}</span>
          </div>
        ))}
      </div>
      {stages.length > 0 && (
        <div className="stage-summary">
          {stages.map(([stage, count]) => (
            <button key={stage} className="stage-pill" onClick={() => onStageClick && onStageClick(stage)} title={`View ${stage} in Pipeline`}>
              {stage} <b>{count}</b>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
