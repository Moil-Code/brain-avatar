import { useEffect, useRef, useState } from "react";
import { extractDocText } from "../lib/tauri";
import { renderMarkdown } from "../lib/markdown";
import { ErrorBoundary } from "./ErrorBoundary";
import type { Attachment, UiMessage } from "../lib/types";

interface Props {
  messages: UiMessage[];
  busy: boolean;
  recording: boolean;
  voiceEnabled: boolean;
  convoMode: boolean;
  onToggleConvo: () => void;
  muted: boolean;
  onToggleMute: () => void;
  queue: { id: string; text: string }[];
  onDequeue: (id: string) => void;
  onSend: (text: string, attachments: Attachment[]) => void;
  onToggleMic: () => void;
  onStop: () => void;
}

function aid() {
  return Math.random().toString(36).slice(2);
}

/** Read a picked file into an Attachment: images → data URL, docs → extracted text. */
function fileToAttachment(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    if (file.type.startsWith("image/")) {
      reader.onload = () =>
        resolve({ id: aid(), name: file.name, kind: "image", dataUrl: String(reader.result) });
      reader.readAsDataURL(file);
    } else {
      reader.onload = async () => {
        const b64 = String(reader.result).split(",")[1] ?? "";
        try {
          const text = await extractDocText(file.name, b64);
          resolve({ id: aid(), name: file.name, kind: "doc", text });
        } catch (e) {
          reject(e);
        }
      };
      reader.readAsDataURL(file);
    }
  });
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
  web_task: "🌐 browser",
  find_files: "📁 files",
  read_file: "📄 read",
  open_file: "📂 open",
  open_app: "🚀 app",
  list_apps: "🚀 apps",
  run_applescript: "⚙️ control",
  system_control: "🎛 system",
  read_emails: "📨 inbox",
  email_details: "✉️ email",
  x_bookmarks: "🔖 bookmarks",
  generate_image: "🎨 image",
  post_to_facebook: "📘 facebook",
  send_email: "✉️ email",
  create_reminder: "⏰ reminder",
  send_teams_message: "💬 teams",
};

export default function ChatPanel({
  messages,
  busy,
  recording,
  voiceEnabled,
  convoMode,
  onToggleConvo,
  muted,
  onToggleMute,
  queue,
  onDequeue,
  onSend,
  onToggleMic,
  onStop,
}: Props) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const onPickFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-picking the same file
    if (!files.length) return;
    setAttaching(true);
    try {
      // Attach every file that reads cleanly; one bad file (e.g. a doc whose text
      // extraction fails) must not drop the whole batch — keep the rest.
      const results = await Promise.allSettled(files.map(fileToAttachment));
      const added = results
        .filter((r): r is PromiseFulfilledResult<Attachment> => r.status === "fulfilled")
        .map((r) => r.value);
      results
        .filter((r) => r.status === "rejected")
        .forEach((r) => console.error("attach failed", (r as PromiseRejectedResult).reason));
      if (added.length) setAttachments((a) => [...a, ...added]);
    } finally {
      setAttaching(false);
    }
  };

  const submit = () => {
    const t = text.trim();
    if ((!t && attachments.length === 0) || attaching) return; // busy is OK — it queues
    setText("");
    const atts = attachments;
    setAttachments([]);
    onSend(t, atts);
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
            {m.pending && m.steps && m.steps.length > 0 ? (
              <div className="steps">
                {m.steps.map((s) => (
                  <div key={s.id} className={`step ${s.done ? "done" : "active"}`}>
                    <span className="step-ic">
                      {s.done ? "✓" : <span className="step-spin" />}
                    </span>
                    <span className="step-label">{s.label}</span>
                  </div>
                ))}
              </div>
            ) : (
              (m.routeLabel || (m.tools && m.tools.length > 0)) && (
                <div className="msg-tools">
                  {m.routeLabel && <span className="route-badge">🧭 {m.routeLabel}</span>}
                  {m.tools?.map((t) => (
                    <span key={t} className="tool-badge">
                      {TOOL_LABEL[t] ?? t}
                    </span>
                  ))}
                </div>
              )
            )}
            <div className="msg-body">
              {m.content ? (
                m.role === "assistant" ? (
                  <ErrorBoundary key={m.content} fallback={m.content}>
                    {renderMarkdown(m.content)}
                  </ErrorBoundary>
                ) : (
                  m.content
                )
              ) : m.pending && !(m.steps && m.steps.length) ? (
                <span className="typing">▋</span>
              ) : (
                ""
              )}
            </div>
            {m.images && m.images.length > 0 && (
              <div className="msg-images">
                {m.images.map((src, i) => (
                  <img key={i} className="msg-image" src={src} alt="generated" />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {queue.length > 0 && (
        <div className="queue-strip">
          <span className="queue-label">⏳ Queued · {queue.length}</span>
          {queue.map((q, i) => (
            <span key={q.id} className="queue-item" title={q.text}>
              {i + 1}. {q.text.length > 38 ? q.text.slice(0, 38) + "…" : q.text}
              <button className="queue-x" title="Remove" onClick={() => onDequeue(q.id)}>
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      {(attachments.length > 0 || attaching) && (
        <div className="attach-chips">
          {attachments.map((a) => (
            <span key={a.id} className={`attach-chip ${a.kind}`} title={a.name}>
              {a.kind === "image" ? "🖼" : "📄"} {a.name}
              <button
                className="attach-x"
                title="Remove"
                onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
              >
                ✕
              </button>
            </span>
          ))}
          {attaching && <span className="attach-chip loading">Reading…</span>}
        </div>
      )}

      <div className="composer">
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/*,.pdf,.txt,.md,.markdown,.csv,.json,.doc,.docx,.rtf,.html,.htm,.yaml,.yml"
          style={{ display: "none" }}
          onChange={onPickFiles}
        />
        <button
          className="icon-btn attach"
          title="Attach images or documents"
          onClick={() => fileRef.current?.click()}
          disabled={recording}
        >
          📎
        </button>
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
        <button
          className={`icon-btn mute ${muted ? "on" : ""}`}
          title={
            muted
              ? "Muted — the avatar runs but stays silent (click to unmute)"
              : "Mute the avatar's voice — it keeps running, just no sound"
          }
          onClick={onToggleMute}
        >
          {muted ? "🔇" : "🔊"}
        </button>
        {voiceEnabled && (
          <button
            className={`icon-btn convo ${convoMode ? "on" : ""}`}
            title={
              convoMode
                ? "Conversation mode ON — listens again after each reply (click to turn off)"
                : "Conversation mode OFF — turn on for hands-free back-and-forth"
            }
            onClick={onToggleConvo}
          >
            🔁
          </button>
        )}
        {voiceEnabled && (
          <button
            className={`icon-btn mic ${recording ? "recording" : ""}`}
            title={recording ? "Stop & send" : "Hold to talk"}
            onClick={onToggleMic}
          >
            {recording ? "■" : "🎙"}
          </button>
        )}
        {busy && (
          <button className="icon-btn stop" title="Stop & clear queue" onClick={onStop}>
            ✕
          </button>
        )}
        <button
          className="icon-btn send"
          title={busy ? "Add to queue" : "Send"}
          onClick={submit}
          disabled={(!text.trim() && attachments.length === 0) || attaching}
        >
          ➤
        </button>
      </div>
    </div>
  );
}
