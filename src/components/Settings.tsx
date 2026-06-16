import { useEffect, useState } from "react";
import { listVoices, llmProbe, setSettings, ttsSpeak } from "../lib/tauri";
import type { Settings as SettingsType } from "../lib/types";

interface Props {
  initial: SettingsType;
  onSaved: (s: SettingsType) => void;
  onClose: () => void;
}

type Field = { key: keyof SettingsType; label: string; secret?: boolean; placeholder?: string };

const SECTIONS: { title: string; hint?: string; fields: Field[] }[] = [
  {
    title: "Model (LM Studio)",
    hint: "The remote 24GB Mac (Mac-mini.local) is the primary inference box and is tried first; the local host is the fallback.",
    fields: [
      { key: "lm_studio_remote_url", label: "Remote URL (primary)", placeholder: "http://Mac-mini.local:1234/v1" },
      { key: "lm_studio_remote_token", label: "Remote API token", secret: true },
      { key: "lm_studio_local_url", label: "Local URL (fallback)", placeholder: "http://localhost:1234/v1" },
      { key: "model", label: "Model (blank = auto)", placeholder: "auto-select first model" },
    ],
  },
  {
    title: "Voice (Groq Whisper)",
    fields: [
      { key: "groq_api_key", label: "Groq API key", secret: true },
      { key: "groq_model", label: "Whisper model", placeholder: "whisper-large-v3-turbo" },
    ],
  },
  {
    title: "Web search (Brave)",
    fields: [{ key: "brave_api_key", label: "Brave API key", secret: true }],
  },
  {
    title: "Local tools",
    hint: "Absolute paths so the packaged app can find them. The M365 app id (optional) enables calendar create/edit/delete — see README.",
    fields: [
      { key: "gbrain_path", label: "gbrain path" },
      { key: "m365_path", label: "m365 path" },
      { key: "m365_app_id", label: "M365 app id (calendar write)" },
    ],
  },
  {
    title: "History sync (Vercel + Supabase)",
    hint: "Optional. Leave blank to stay fully local.",
    fields: [
      { key: "sync_api_url", label: "Vercel API URL", placeholder: "https://your-app.vercel.app" },
      { key: "sync_token", label: "Sync token", secret: true },
    ],
  },
];

export default function Settings({ initial, onSaved, onClose }: Props) {
  const [draft, setDraft] = useState<SettingsType>(initial);
  const [saving, setSaving] = useState(false);
  const [probe, setProbe] = useState<string>("");
  const [voices, setVoices] = useState<string[]>([]);

  useEffect(() => {
    listVoices().then(setVoices).catch(() => {});
  }, []);

  const update = (key: keyof SettingsType, value: string) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const save = async () => {
    setSaving(true);
    try {
      await setSettings(draft);
      onSaved(draft);
    } catch (e) {
      setProbe(`Save failed: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    setProbe("Testing remote (24GB Mac)…");
    const r = await llmProbe(draft.lm_studio_remote_url, draft.lm_studio_remote_token).catch((e) => ({
      ok: false,
      models: [],
      error: String(e),
    }));
    if (r.ok) {
      setProbe(`✓ Remote up. Models: ${r.models.join(", ") || "(none reported)"}`);
      return;
    }
    setProbe(`✗ Remote unreachable (${r.error ?? "?"}) — trying local fallback…`);
    const rr = await llmProbe(draft.lm_studio_local_url).catch((e) => ({ ok: false, models: [], error: String(e) }));
    if (rr.ok) setProbe(`✓ Local fallback up. Models: ${rr.models.join(", ") || "(none)"}`);
    else setProbe(`✗ Neither endpoint reachable. Remote: ${r.error ?? "?"}`);
  };

  return (
    <div className="settings">
      <div className="settings-head">
        <h2>Settings</h2>
        <button className="tb-btn" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="settings-body">
        {SECTIONS.map((sec) => (
          <div className="settings-section" key={sec.title}>
            <h3>{sec.title}</h3>
            {sec.hint && <p className="settings-hint">{sec.hint}</p>}
            {sec.fields.map((f) => (
              <label className="field" key={String(f.key)}>
                <span>{f.label}</span>
                <input
                  type={f.secret ? "password" : "text"}
                  value={String(draft[f.key] ?? "")}
                  placeholder={f.placeholder}
                  onChange={(e) => update(f.key, e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
            ))}
            {sec.title.startsWith("Model") && (
              <button className="ghost-btn" onClick={testConnection}>
                Test connection
              </button>
            )}
          </div>
        ))}

        <div className="settings-section">
          <h3>Voice</h3>
          <p className="settings-hint">
            For a natural voice, download an Enhanced/Premium voice in System Settings → Accessibility →
            Spoken Content → System Voice → Manage Voices, then pick it here.
          </p>
          <label className="field">
            <span>Spoken voice</span>
            <select
              value={draft.tts_voice}
              onChange={(e) => update("tts_voice", e.target.value)}
            >
              <option value="">System default</option>
              {voices.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <button
            className="ghost-btn"
            onClick={() =>
              ttsSpeak("Hi Andres, this is how I sound. Ready when you are.", draft.tts_voice).catch(() => {})
            }
          >
            ▶ Preview voice
          </button>
        </div>

        <div className="settings-section">
          <h3>Personality</h3>
          <label className="field">
            <span>System prompt</span>
            <textarea
              rows={6}
              value={draft.system_prompt}
              onChange={(e) => update("system_prompt", e.target.value)}
            />
          </label>
        </div>

        {probe && <div className="probe-result">{probe}</div>}
      </div>
      <div className="settings-foot">
        <button className="ghost-btn" onClick={onClose}>
          Cancel
        </button>
        <button className="primary-btn" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
