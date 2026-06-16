import { useState } from "react";
import { llmProbe, setSettings } from "../lib/tauri";
import type { Settings as SettingsType } from "../lib/types";

interface Props {
  initial: SettingsType;
  onSaved: (s: SettingsType) => void;
  onClose: () => void;
}

type Field = { key: keyof SettingsType; label: string; secret?: boolean; placeholder?: string };

const SECTIONS: { title: string; hint?: string; fields: Field[] }[] = [
  {
    title: "Local model (LM Studio)",
    hint: "Local endpoint is tried first; the remote Mac is the fallback.",
    fields: [
      { key: "lm_studio_local_url", label: "Local URL", placeholder: "http://localhost:1234/v1" },
      { key: "lm_studio_remote_url", label: "Remote URL", placeholder: "http://Mac-mini.local:1234/v1" },
      { key: "lm_studio_remote_token", label: "Remote API token", secret: true },
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
    hint: "Absolute paths so the packaged app can find them.",
    fields: [
      { key: "gbrain_path", label: "gbrain path" },
      { key: "m365_path", label: "m365 path" },
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

  const testLocal = async () => {
    setProbe("Testing local…");
    const r = await llmProbe(draft.lm_studio_local_url).catch((e) => ({ ok: false, models: [], error: String(e) }));
    if (r.ok) setProbe(`✓ Local up. Models: ${r.models.join(", ") || "(none reported)"}`);
    else {
      setProbe(`✗ Local unreachable — trying remote…`);
      const rr = await llmProbe(draft.lm_studio_remote_url, draft.lm_studio_remote_token).catch((e) => ({
        ok: false,
        models: [],
        error: String(e),
      }));
      if (rr.ok) setProbe(`✓ Remote up. Models: ${rr.models.join(", ") || "(none)"}`);
      else setProbe(`✗ Neither endpoint reachable. ${rr.error ?? ""}`);
    }
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
            {sec.title.startsWith("Local model") && (
              <button className="ghost-btn" onClick={testLocal}>
                Test connection
              </button>
            )}
          </div>
        ))}

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
