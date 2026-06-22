import { useEffect, useState } from "react";
import {
  daemonProbe,
  listVoices,
  llmProbe,
  mcpProbe,
  openVoiceDownload,
  setSettings,
  ttsSpeak,
} from "../lib/tauri";
import type { McpServer, Settings as SettingsType } from "../lib/types";

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
  {
    title: "Remote brain (MacBook / iPhone client)",
    hint: "Point this at the Mac Mini's brain-daemon (over Tailscale) to use the brain, calendar, mail, and web from this device. Leave blank to run everything locally. On iPhone this is required, and the model 'Remote URL' above should point at the SAME daemon's /v1 passthrough (e.g. http://100.x.y.z:8787/v1) with the daemon token — so both tools and the LLM flow over the tailnet.",
    fields: [
      { key: "brain_daemon_url", label: "Daemon URL", placeholder: "http://100.x.y.z:8787" },
      { key: "brain_daemon_token", label: "Daemon token", secret: true },
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

  const servers: McpServer[] = draft.mcp_servers ?? [];
  const setServers = (next: McpServer[]) => setDraft((d) => ({ ...d, mcp_servers: next }));
  const updateServer = (i: number, patch: Partial<McpServer>) =>
    setServers(servers.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const addServer = () =>
    setServers([...servers, { name: "", command: "npx", args: [], env: {}, enabled: true }]);
  const removeServer = (i: number) => setServers(servers.filter((_, j) => j !== i));
  const testServer = async (s: McpServer) => {
    if (!s.command.trim()) {
      setProbe("Give the server a command first (e.g. npx).");
      return;
    }
    setProbe(`Testing MCP server “${s.name || s.command}”…`);
    try {
      setProbe(`✓ ${await mcpProbe(s)}`);
    } catch (e) {
      setProbe(`✗ ${e}`);
    }
  };

  const testDaemon = async () => {
    if (!draft.brain_daemon_url.trim()) {
      setProbe("Enter a daemon URL first (or leave blank to run locally).");
      return;
    }
    setProbe("Testing brain-daemon…");
    try {
      setProbe(`✓ ${await daemonProbe(draft.brain_daemon_url, draft.brain_daemon_token)}`);
    } catch (e) {
      setProbe(`✗ ${e}`);
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
            {sec.title.startsWith("Model") && (
              <button className="ghost-btn" onClick={testConnection}>
                Test connection
              </button>
            )}
            {sec.title.startsWith("Remote brain") && (
              <button className="ghost-btn" onClick={testDaemon}>
                Test connection
              </button>
            )}
          </div>
        ))}

        <div className="settings-section">
          <h3>Voice</h3>
          <p className="settings-hint">
            macOS ships only robotic voices by default. Click <strong>Download better voices…</strong>,
            download a <strong>Premium</strong> voice (e.g. Zoe), then pick it in the{" "}
            <strong>Spoken voice</strong> list below — it appears as “Zoe (Premium)”. The avatar speaks
            through the neural voice engine, so Premium/Enhanced voices work directly here.
          </p>
          <button className="ghost-btn" onClick={() => openVoiceDownload().catch(() => {})}>
            🔊 Download better voices…
          </button>
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
          <h3>MCP tool servers</h3>
          <p className="settings-hint">
            Connect external Model Context Protocol servers to give Brain new tools — filesystem,
            iMessage, Notes, GitHub, and more — with no app changes. Each server is launched over
            stdio; its tools appear to the model automatically. Example: command{" "}
            <code>npx</code>, args{" "}
            <code>-y @modelcontextprotocol/server-filesystem ~/Documents</code>.
          </p>
          {servers.map((s, i) => (
            <div className="mcp-server" key={i}>
              <label className="field">
                <span>Name</span>
                <input
                  type="text"
                  value={s.name}
                  placeholder="filesystem"
                  onChange={(e) => updateServer(i, { name: e.target.value })}
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <label className="field">
                <span>Command</span>
                <input
                  type="text"
                  value={s.command}
                  placeholder="npx"
                  onChange={(e) => updateServer(i, { command: e.target.value })}
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <label className="field">
                <span>Args (space-separated)</span>
                <input
                  type="text"
                  value={s.args.join(" ")}
                  placeholder="-y @modelcontextprotocol/server-filesystem ~/Documents"
                  onChange={(e) =>
                    updateServer(i, { args: e.target.value.split(/\s+/).filter(Boolean) })
                  }
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <div className="mcp-server-row">
                <label className="mcp-enable">
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    onChange={(e) => updateServer(i, { enabled: e.target.checked })}
                  />
                  Enabled
                </label>
                <button className="ghost-btn" onClick={() => testServer(s)}>
                  Test
                </button>
                <button className="ghost-btn" onClick={() => removeServer(i)}>
                  Remove
                </button>
              </div>
            </div>
          ))}
          <button className="ghost-btn" onClick={addServer}>
            + Add MCP server
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
