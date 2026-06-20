import { useEffect, useState } from "react";
import {
  listTrainingRuns,
  trajectoryStats,
  type Count,
  type TrainingRun,
  type TrajectoryStats,
} from "../lib/tauri";

interface Props {
  onClose: () => void;
}

// Real-usage turns we'd like before a meaningful live fine-tune. Below this, a
// model can still be cold-started on synthetic + distilled data.
const TRAIN_READY_LIVE = 50;

const SOURCE_LABEL: Record<string, string> = {
  live: "🟢 Live (real usage)",
  synthetic: "🧪 Synthetic",
  distilled: "🎓 Distilled (26B)",
};

/** One horizontal bar: label · proportional fill · count. */
function Bar({ label, count, max, hue }: { label: string; count: number; max: number; hue: number }) {
  const pct = max > 0 ? Math.round((count / max) * 100) : 0;
  return (
    <div className="tt-bar-row">
      <div className="tt-bar-label" title={label}>
        {label}
      </div>
      <div className="tt-bar-track">
        <div className="tt-bar-fill" style={{ width: `${pct}%`, background: `hsl(${hue} 70% 55%)` }} />
      </div>
      <div className="tt-bar-count">{count}</div>
    </div>
  );
}

function BarList({ rows, hue }: { rows: Count[]; hue: number }) {
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0);
  if (rows.length === 0) return <p className="settings-hint">— nothing yet —</p>;
  return (
    <>
      {rows.map((r) => (
        <Bar key={r.name} label={SOURCE_LABEL[r.name] ?? r.name} count={r.count} max={max} hue={hue} />
      ))}
    </>
  );
}

/** Vertical mini-bars: trajectories captured per day (the growth timeline). */
function Sparkline({ rows }: { rows: Count[] }) {
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0);
  if (rows.length === 0) return <p className="settings-hint">No capture history yet.</p>;
  const recent = rows.slice(-21); // last ~3 weeks
  return (
    <div className="tt-spark">
      {recent.map((r) => (
        <div
          key={r.name}
          className="tt-spark-col"
          style={{ height: `${max > 0 ? Math.max(6, (r.count / max) * 100) : 6}%` }}
          title={`${r.name}: ${r.count}`}
        />
      ))}
    </div>
  );
}

function pctText(v: number | null): string {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}

export default function TrainingTracker({ onClose }: Props) {
  const [stats, setStats] = useState<TrajectoryStats | null>(null);
  const [runs, setRuns] = useState<TrainingRun[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    Promise.all([trajectoryStats().catch(() => null), listTrainingRuns().catch(() => [])])
      .then(([s, r]) => {
        if (!alive) return;
        setStats(s);
        setRuns(r);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const live = stats?.live ?? 0;
  const ready = live >= TRAIN_READY_LIVE;
  const livePct = Math.min(100, Math.round((live / TRAIN_READY_LIVE) * 100));

  return (
    <div className="settings">
      <div className="settings-head">
        <span>🧠📈 Training tracker</span>
        <button className="tb-btn" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
      <div className="settings-body">
        {loading ? (
          <p className="settings-hint">Reading the local corpus…</p>
        ) : (
          <>
            {/* WHEN to train — readiness */}
            <div className="tt-readiness">
              <div className="tt-readiness-head">
                {ready ? "✅ Ready to train on real usage" : "⏳ Building the corpus"}
              </div>
              <div className="tt-bar-track tt-readiness-track">
                <div
                  className="tt-bar-fill"
                  style={{ width: `${livePct}%`, background: ready ? "hsl(140 70% 45%)" : "hsl(45 90% 55%)" }}
                />
              </div>
              <p className="settings-hint">
                {live} / {TRAIN_READY_LIVE} real-usage turns captured.{" "}
                {ready
                  ? "Run training/train.sh on the Mac Mini to fine-tune qwen3-8b."
                  : "Keep using Brain and 👍/👎 answers — or cold-start now on synthetic + distilled data."}
              </p>
            </div>

            {/* WHAT we train on — top-line counts */}
            <div className="tt-stat-grid">
              <div className="tt-stat">
                <div className="tt-stat-num">{stats?.total ?? 0}</div>
                <div className="tt-stat-cap">trajectories</div>
              </div>
              <div className="tt-stat">
                <div className="tt-stat-num">{live}</div>
                <div className="tt-stat-cap">live</div>
              </div>
              <div className="tt-stat">
                <div className="tt-stat-num">
                  {stats?.ratings.up ?? 0}/{stats?.ratings.down ?? 0}
                </div>
                <div className="tt-stat-cap">👍 / 👎</div>
              </div>
              <div className="tt-stat">
                <div className="tt-stat-num">{stats?.rated_live ?? 0}</div>
                <div className="tt-stat-cap">rated live (KTO)</div>
              </div>
            </div>

            <div className="settings-section">
              <label className="field-label">Corpus by source</label>
              <BarList rows={stats?.by_source ?? []} hue={150} />
            </div>

            <div className="settings-section">
              <label className="field-label">What behaviors (by task type)</label>
              <BarList rows={stats?.by_task ?? []} hue={210} />
            </div>

            <div className="settings-section">
              <label className="field-label">Tool coverage</label>
              <BarList rows={stats?.by_tool ?? []} hue={280} />
            </div>

            <div className="settings-section">
              <label className="field-label">Capture growth (per day)</label>
              <Sparkline rows={stats?.by_day ?? []} />
            </div>

            {/* WHEN we trained — run history */}
            <div className="settings-section">
              <label className="field-label">Training runs</label>
              {runs.length === 0 ? (
                <p className="settings-hint">
                  No training runs yet. They appear here after you run{" "}
                  <code>training/train.sh</code> on the Mac Mini.
                </p>
              ) : (
                <div className="chats-list">
                  {runs.map((r, i) => (
                    <div className="tt-run" key={`${r.started_at}-${i}`}>
                      <div className="chat-row-title">
                        {r.mode.toUpperCase()} · {r.base_model.split("/").pop()}
                      </div>
                      <div className="chat-row-meta">
                        {r.started_at?.slice(0, 16).replace("T", " ")} · {r.examples} ex · {r.iters} iters
                      </div>
                      <div className="chat-row-meta">
                        eval {pctText(r.eval_before)} → <b>{pctText(r.eval_after)}</b> · {r.status || "done"}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <p className="settings-hint">
              Capture is local-only and never synced. See <code>training/README.md</code> for the
              full pipeline.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
