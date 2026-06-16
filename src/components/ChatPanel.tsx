import { useEffect, useRef, useState } from "react";
import type { UiMessage } from "../lib/types";

interface Props {
  messages: UiMessage[];
  busy: boolean;
  recording: boolean;
  voiceEnabled: boolean;
  onSend: (text: string) => void;
  onToggleMic: () => void;
  onStop: () => void;
}

const TOOL_LABEL: Record<string, string> = {
  brain_page: "🧠 brain",
  brain_search: "🧠 brain",
  calendar_events: "📅 calendar",
  calendar_create: "📅 schedule",
  calendar_update: "📅 update",
  calendar_delete: "📅 delete",
  create_teams_meeting: "📹 teams",
  web_search: "🌐 web",
  fetch_url: "📖 page",
  find_files: "📁 files",
  read_file: "📄 read",
  open_file: "📂 open",
  open_app: "🚀 app",
  list_apps: "🚀 apps",
  run_applescript: "⚙️ control",
  read_emails: "📨 inbox",
  send_email: "✉️ email",
  create_reminder: "⏰ reminder",
  send_teams_message: "💬 teams",
};

export default function ChatPanel({
  messages,
  busy,
  recording,
  voiceEnabled,
  onSend,
  onToggleMic,
  onStop,
}: Props) {
  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const submit = () => {
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    onSend(t);
  };

  return (
    <div className="chat">
      <div className="messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="empty-hint">
            Ask me about your brain, calendar, deals, files, or the web.
            <br />
            <span className="kbd">⌘⇧Space</span> to summon · <span className="kbd">⌘⇧V</span> to talk
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg msg-${m.role}`}>
            {(m.routeLabel || (m.tools && m.tools.length > 0)) && (
              <div className="msg-tools">
                {m.routeLabel && <span className="route-badge">🧭 {m.routeLabel}</span>}
                {m.tools?.map((t) => (
                  <span key={t} className="tool-badge">
                    {TOOL_LABEL[t] ?? t}
                  </span>
                ))}
              </div>
            )}
            <div className="msg-body">
              {m.content || (m.pending ? <span className="typing">▋</span> : "")}
            </div>
          </div>
        ))}
      </div>

      <div className="composer">
        <textarea
          className="composer-input"
          placeholder={recording ? "Listening… tap mic to stop" : "Message Brain…"}
          value={text}
          rows={1}
          disabled={recording}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {voiceEnabled && (
          <button
            className={`icon-btn mic ${recording ? "recording" : ""}`}
            title={recording ? "Stop & send" : "Hold to talk"}
            onClick={onToggleMic}
          >
            {recording ? "■" : "🎙"}
          </button>
        )}
        {busy ? (
          <button className="icon-btn stop" title="Stop" onClick={onStop}>
            ✕
          </button>
        ) : (
          <button className="icon-btn send" title="Send" onClick={submit} disabled={!text.trim()}>
            ➤
          </button>
        )}
      </div>
    </div>
  );
}
