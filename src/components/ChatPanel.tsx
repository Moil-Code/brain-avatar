import { useEffect, useRef, useState } from "react";
import { extractDocText, rateTrajectory } from "../lib/tauri";
import { speak, stopSpeaking } from "../lib/voice";
import { renderMarkdown } from "../lib/markdown";
import { ErrorBoundary } from "./ErrorBoundary";
import TaskBoard from "./TaskBoard";
import type { Attachment, TaskBoard as Board, UiMessage } from "../lib/types";

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
  /** Live kanban board for this conversation (null when none). */
  board?: Board | null;
  boardExpanded?: boolean;
  onToggleBoard?: () => void;
  /** Sync API URL + token for posting feedback ratings (optional — omit to hide buttons). */
  syncApiUrl?: string;
  syncToken?: string;
  /** Active conversation id — needed to associate feedback with the right conversation. */
  conversationId?: string;
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
  board,
  boardExpanded,
  onToggleBoard,
  syncApiUrl,
  syncToken,
  conversationId,
}: Props) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [ratings, setRatings] = useState<Record<string, -1 | 1>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [noteFor, setNoteFor] = useState<string | null>(null); // message with the note box open
  const [noteDraft, setNoteDraft] = useState("");
  const [playingId, setPlayingId] = useState<string | null>(null); // answer being read aloud
  const [copiedId, setCopiedId] = useState<string | null>(null); // answer just copied (✓ flash)
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Hydrate ratings + notes from localStorage so they survive page reload.
  useEffect(() => {
    try {
      setRatings(JSON.parse(localStorage.getItem("msg-ratings") ?? "{}"));
      setNotes(JSON.parse(localStorage.getItem("msg-notes") ?? "{}"));
    } catch { /* ignore */ }
  }, []);

  // Persist a rating (+ optional note) to the on-device training corpus (the KTO
  // signal) and, if configured, the cloud. Local-only works without any sync.
  const persist = async (messageId: string, rating: -1 | 1, note?: string) => {
    rateTrajectory(messageId, rating, note).catch(() => {});
    if (!syncApiUrl || !conversationId) return;
    try {
      await fetch(`${syncApiUrl}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${syncToken ?? ""}` },
        body: JSON.stringify({ conversationId, messageId, rating, note: note ?? null }),
      });
    } catch { /* best-effort */ }
  };

  const handleRate = (messageId: string, rating: -1 | 1) => {
    setRatings((r) => ({ ...r, [messageId]: rating }));
    try {
      const stored = JSON.parse(localStorage.getItem("msg-ratings") ?? "{}");
      localStorage.setItem("msg-ratings", JSON.stringify({ ...stored, [messageId]: rating }));
    } catch { /* ignore */ }
    void persist(messageId, rating, notes[messageId]);
    // Open the note box so the user can add specifics right after the thumb.
    setNoteDraft(notes[messageId] ?? "");
    setNoteFor(messageId);
  };

  const saveNote = (messageId: string) => {
    const note = noteDraft.trim();
    setNotes((n) => ({ ...n, [messageId]: note }));
    try {
      const stored = JSON.parse(localStorage.getItem("msg-notes") ?? "{}");
      localStorage.setItem("msg-notes", JSON.stringify({ ...stored, [messageId]: note }));
    } catch { /* ignore */ }
    void persist(messageId, ratings[messageId] ?? 1, note);
    setNoteFor(null);
  };

  // Read one answer aloud on demand (or stop it). Forces past the global mute —
  // this is an explicit "say THIS one" request, so it speaks even when the avatar
  // is muted, and lets you replay an answer after the auto-spoken reply ended.
  const togglePlay = (m: UiMessage) => {
    if (playingId === m.id) {
      stopSpeaking();
      setPlayingId(null);
      return;
    }
    stopSpeaking(); // interrupt the auto-spoken reply or another answer first
    speak(m.content, {
      force: true,
      onStart: () => setPlayingId(m.id),
      // Guard the clear: if the user already started a different answer, this
      // (interrupted) playback's end must not wipe the new one's highlight.
      onEnd: () => setPlayingId((cur) => (cur === m.id ? null : cur)),
    });
  };

  // Copy one answer's text to the clipboard so it can be pasted elsewhere without
  // hand-selecting it. Flashes a ✓ for a moment, then reverts to the copy icon.
  const copyAnswer = async (m: UiMessage) => {
    try {
      await navigator.clipboard.writeText(m.content);
    } catch {
      // Fallback for any context where the async Clipboard API is unavailable.
      const ta = document.createElement("textarea");
      ta.value = m.content;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch { /* give up silently */ }
      document.body.removeChild(ta);
    }
    setCopiedId(m.id);
    window.setTimeout(() => setCopiedId((cur) => (cur === m.id ? null : cur)), 1500);
  };

  // Switching conversations leaves the current answer half-spoken otherwise —
  // stop playback (and drop the highlight) when the active chat changes.
  useEffect(() => {
    return () => {
      stopSpeaking();
      setPlayingId(null);
    };
  }, [conversationId]);

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
            {m.role === "assistant" && !m.pending && (
              <div
                className={`msg-feedback${
                  noteFor === m.id || notes[m.id] || playingId === m.id || copiedId === m.id
                    ? " fb-open"
                    : ""
                }`}
              >
                <button
                  className={`fb-btn${copiedId === m.id ? " fb-active" : ""}`}
                  title={copiedId === m.id ? "Copied!" : "Copy this answer"}
                  onClick={() => copyAnswer(m)}
                >
                  {copiedId === m.id ? "✓" : "📋"}
                </button>
                <button
                  className={`fb-btn${playingId === m.id ? " fb-playing" : ""}`}
                  title={playingId === m.id ? "Stop reading aloud" : "Play this answer aloud"}
                  onClick={() => togglePlay(m)}
                >
                  {playingId === m.id ? "⏹" : "🔊"}
                </button>
                <button
                  className={`fb-btn${ratings[m.id] === 1 ? " fb-active" : ""}`}
                  title="Good response"
                  onClick={() => handleRate(m.id, 1)}
                >
                  👍
                </button>
                <button
                  className={`fb-btn${ratings[m.id] === -1 ? " fb-active" : ""}`}
                  title="Poor response"
                  onClick={() => handleRate(m.id, -1)}
                >
                  👎
                </button>
                {(ratings[m.id] || notes[m.id]) && noteFor !== m.id && (
                  <button
                    className="fb-note-btn"
                    title="Add specific feedback"
                    onClick={() => {
                      setNoteDraft(notes[m.id] ?? "");
                      setNoteFor(m.id);
                    }}
                  >
                    💬 {notes[m.id] ? "edit note" : "add note"}
                  </button>
                )}
                {notes[m.id] && noteFor !== m.id && (
                  <span className="fb-note-text" title={notes[m.id]}>
                    “{notes[m.id]}”
                  </span>
                )}
                {noteFor === m.id && (
                  <div className="fb-note-box">
                    <textarea
                      className="fb-note-input"
                      autoFocus
                      rows={2}
                      placeholder={
                        ratings[m.id] === -1
                          ? "What was wrong? (e.g. wrong tool, made up the proof)"
                          : "What worked well? (optional)"
                      }
                      value={noteDraft}
                      onChange={(e) => setNoteDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          saveNote(m.id);
                        }
                        if (e.key === "Escape") setNoteFor(null);
                      }}
                    />
                    <div className="fb-note-actions">
                      <button className="fb-note-save" onClick={() => saveNote(m.id)}>
                        Save
                      </button>
                      <button className="fb-note-cancel" onClick={() => setNoteFor(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <TaskBoard
        board={board ?? null}
        expanded={boardExpanded ?? false}
        onToggle={onToggleBoard ?? (() => {})}
      />

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
