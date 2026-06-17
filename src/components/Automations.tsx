import { useEffect, useState } from "react";
import {
  DEFAULT_AUTOMATION_EMAIL,
  describeSchedule,
  loadAutomations,
  makeAutomation,
  removeAutomation,
  saveAutomations,
  upsertAutomation,
} from "../lib/automations";
import type { Automation, AutomationSchedule } from "../lib/types";

interface Props {
  onClose: () => void;
  onRunNow: (a: Automation) => void;
}

type ScheduleKind = "daily" | "weekly" | "hourly" | "interval";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A ready-made automation Andres can add in one click. */
const PRESETS: { label: string; build: () => Automation }[] = [
  {
    label: "🌅 Morning briefing (daily 8am)",
    build: () =>
      makeAutomation({
        name: "Morning briefing",
        prompt:
          "Give me a concise morning briefing. Check my calendar for today and list my meetings " +
          "with times. Check my inbox for anything important that arrived overnight. Surface my top " +
          "open commitments from my brain. Keep it short and spoken-friendly — a quick rundown to " +
          "start the day.",
        schedule: { kind: "daily", time: "08:00" },
        delivery: { speak: true, notify: true, email: true, brain: false },
      }),
  },
  {
    label: "📊 Weekly Facebook metrics (Mon 9am)",
    build: () =>
      makeAutomation({
        name: "Weekly FB metrics",
        prompt:
          "Check my Facebook metrics for the moil page. Summarize followers, 28-day reach, " +
          "impressions and post engagement, and how my recent posts performed. Note what changed " +
          "versus a typical week and one suggestion.",
        schedule: { kind: "weekly", weekday: 1, time: "09:00" },
        delivery: { speak: true, notify: true, email: true, brain: true },
      }),
  },
  {
    label: "🌙 End-of-day capture (daily 6pm)",
    build: () =>
      makeAutomation({
        name: "End-of-day capture",
        prompt:
          "Summarize what happened today: the meetings I had and any decisions or follow-ups I " +
          "should remember. Write it as a short journal note so it's captured for my brain.",
        schedule: { kind: "daily", time: "18:00" },
        delivery: { speak: false, notify: true, email: false, brain: true },
      }),
  },
];

function relTime(iso?: string): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export default function Automations({ onClose, onRunNow }: Props) {
  const [list, setList] = useState<Automation[]>([]);
  const [creating, setCreating] = useState(false);

  // new-automation form state
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<ScheduleKind>("daily");
  const [time, setTime] = useState("09:00");
  const [weekday, setWeekday] = useState(1);
  const [minute, setMinute] = useState(0);
  const [everyMinutes, setEveryMinutes] = useState(60);
  const [dNotify, setDNotify] = useState(true);
  const [dSpeak, setDSpeak] = useState(true);
  const [dEmail, setDEmail] = useState(false);
  const [dBrain, setDBrain] = useState(false);

  const refresh = async () => setList(await loadAutomations().catch(() => []));
  useEffect(() => {
    refresh();
  }, []);

  const buildSchedule = (): AutomationSchedule => {
    if (kind === "weekly") return { kind: "weekly", weekday, time };
    if (kind === "hourly") return { kind: "hourly", minute };
    if (kind === "interval") return { kind: "interval", everyMinutes };
    return { kind: "daily", time };
  };

  const addPreset = async (a: Automation) => {
    await upsertAutomation(a);
    await refresh();
  };

  const create = async () => {
    if (!name.trim() || !prompt.trim()) return;
    const a = makeAutomation({
      name,
      prompt,
      schedule: buildSchedule(),
      delivery: { notify: dNotify, speak: dSpeak, email: dEmail, brain: dBrain },
    });
    await upsertAutomation(a);
    setName("");
    setPrompt("");
    setCreating(false);
    await refresh();
  };

  const toggle = async (a: Automation) => {
    const next = list.map((x) => (x.id === a.id ? { ...x, enabled: !x.enabled } : x));
    setList(next);
    await saveAutomations(next);
  };

  const del = async (id: string) => {
    setList(await removeAutomation(id));
  };

  return (
    <div className="settings">
      <div className="settings-head">
        <h2>Automations</h2>
        <button className="tb-btn" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
      <div className="settings-body">
        <p className="settings-hint">
          Tasks Brain runs on its own and delivers to you. They fire while the avatar is running.
          You can also create them by voice — “every Monday at 9, email me my Facebook metrics.”
        </p>

        {list.length === 0 ? (
          <p className="settings-hint">No automations yet — add one below.</p>
        ) : (
          <div className="chats-list">
            {list.map((a) => (
              <div key={a.id} className={`chat-row ${a.enabled ? "active" : ""}`}>
                <div className="chat-row-main">
                  <div className="chat-row-title">
                    {a.enabled ? "🟢" : "⚪️"} {a.name}
                  </div>
                  <div className="chat-row-meta">
                    {describeSchedule(a.schedule)} · last run {relTime(a.lastRun)}
                  </div>
                  {a.lastResult && <div className="chat-row-meta">↳ {a.lastResult}</div>}
                </div>
                <div style={{ display: "flex", gap: 4 }}>
                  <button className="chat-row-del" title="Run now" onClick={() => onRunNow(a)}>
                    ▶
                  </button>
                  <button
                    className="chat-row-del"
                    title={a.enabled ? "Pause" : "Enable"}
                    onClick={() => toggle(a)}
                  >
                    {a.enabled ? "⏸" : "✓"}
                  </button>
                  <button className="chat-row-del" title="Delete" onClick={() => del(a.id)}>
                    🗑
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {!creating ? (
          <div className="settings-section">
            <h3>Quick add</h3>
            {PRESETS.map((p) => (
              <button
                key={p.label}
                className="ghost-btn"
                style={{ display: "block", width: "100%", marginBottom: 6, textAlign: "left" }}
                onClick={() => addPreset(p.build())}
              >
                {p.label}
              </button>
            ))}
            <button className="primary-btn" onClick={() => setCreating(true)}>
              ＋ Custom automation
            </button>
          </div>
        ) : (
          <div className="settings-section">
            <h3>New automation</h3>
            <label className="field">
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Weekly FB metrics" />
            </label>
            <label className="field">
              <span>What should Brain do?</span>
              <textarea
                value={prompt}
                rows={3}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Check my Facebook metrics for the moil page and summarize what changed this week."
              />
            </label>
            <label className="field">
              <span>Repeat</span>
              <select value={kind} onChange={(e) => setKind(e.target.value as ScheduleKind)}>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="hourly">Hourly</option>
                <option value="interval">Every N minutes</option>
              </select>
            </label>
            {kind === "weekly" && (
              <label className="field">
                <span>Day</span>
                <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                  {WEEKDAYS.map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {(kind === "daily" || kind === "weekly") && (
              <label className="field">
                <span>Time</span>
                <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              </label>
            )}
            {kind === "hourly" && (
              <label className="field">
                <span>Minute of hour</span>
                <input
                  type="number"
                  min={0}
                  max={59}
                  value={minute}
                  onChange={(e) => setMinute(Number(e.target.value))}
                />
              </label>
            )}
            {kind === "interval" && (
              <label className="field">
                <span>Every (minutes)</span>
                <input
                  type="number"
                  min={1}
                  value={everyMinutes}
                  onChange={(e) => setEveryMinutes(Number(e.target.value))}
                />
              </label>
            )}
            <label className="field">
              <span>Deliver via</span>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <label className="auto-check">
                  <input type="checkbox" checked={dNotify} onChange={(e) => setDNotify(e.target.checked)} /> Notify
                </label>
                <label className="auto-check">
                  <input type="checkbox" checked={dSpeak} onChange={(e) => setDSpeak(e.target.checked)} /> Speak
                </label>
                <label className="auto-check">
                  <input type="checkbox" checked={dEmail} onChange={(e) => setDEmail(e.target.checked)} /> Email
                </label>
                <label className="auto-check">
                  <input type="checkbox" checked={dBrain} onChange={(e) => setDBrain(e.target.checked)} /> Brain
                </label>
              </div>
            </label>
            {dEmail && (
              <p className="settings-hint">Emails go to {DEFAULT_AUTOMATION_EMAIL}.</p>
            )}
          </div>
        )}
      </div>
      {creating && (
        <div className="settings-foot">
          <button className="ghost-btn" onClick={() => setCreating(false)}>
            Cancel
          </button>
          <button className="primary-btn" onClick={create} disabled={!name.trim() || !prompt.trim()}>
            Create
          </button>
        </div>
      )}
    </div>
  );
}
