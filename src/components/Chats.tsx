import type { ConvSummary } from "../lib/tauri";

interface Props {
  conversations: ConvSummary[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

function relTime(iso: string): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function Chats({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
  onClose,
}: Props) {
  return (
    <div className="settings">
      <div className="settings-head">
        <h2>Chats</h2>
        <button className="tb-btn" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
      <div className="settings-body">
        <button className="primary-btn chats-new" onClick={onNew}>
          ＋ New chat
        </button>
        {conversations.length === 0 ? (
          <p className="settings-hint">No saved chats yet.</p>
        ) : (
          <div className="chats-list">
            {conversations.map((c) => (
              <div
                key={c.id}
                className={`chat-row ${c.id === activeId ? "active" : ""}`}
                onClick={() => onSelect(c.id)}
                title={c.title}
              >
                <div className="chat-row-main">
                  <div className="chat-row-title">{c.title}</div>
                  <div className="chat-row-meta">
                    {relTime(c.updated_at)} · {c.message_count} msg
                  </div>
                </div>
                <button
                  className="chat-row-del"
                  title="Delete chat"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(c.id);
                  }}
                >
                  🗑
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
