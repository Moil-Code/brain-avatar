interface Props {
  onOpenSettings: () => void;
  onOpenChats: () => void;
  onOpenAutomations: () => void;
  onOpenTraining: () => void;
  onNewChat: () => void;
  onMinimize: () => void;
  peeked: boolean;
  onExitPeek: () => void;
  models: string[];
  modelOverride: string | null;
  onSelectModel: (model: string | null) => void;
}

export default function TitleBar({
  onOpenSettings,
  onOpenChats,
  onOpenAutomations,
  onOpenTraining,
  onNewChat,
  onMinimize,
  peeked,
  onExitPeek,
  models,
  modelOverride,
  onSelectModel,
}: Props) {
  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-name" data-tauri-drag-region>
        Brain
      </div>
      <div className="titlebar-actions">
        {models.length > 0 && (
          <select
            className="tb-model"
            value={modelOverride ?? ""}
            title="Model — “Auto” picks the best per task; or force one"
            onChange={(e) => onSelectModel(e.target.value || null)}
          >
            <option value="">Auto</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m.split("/").pop()}
              </option>
            ))}
          </select>
        )}
        {peeked && (
          <button className="tb-btn" title="Dock back" onClick={onExitPeek}>
            ⤢
          </button>
        )}
        <button className="tb-btn" title="New chat" onClick={onNewChat}>
          ＋
        </button>
        <button className="tb-btn" title="Recent chats" onClick={onOpenChats}>
          🕘
        </button>
        <button className="tb-btn" title="Automations" onClick={onOpenAutomations}>
          ⏰
        </button>
        <button className="tb-btn" title="Training tracker" onClick={onOpenTraining}>
          📈
        </button>
        <button className="tb-btn" title="Settings" onClick={onOpenSettings}>
          ⚙
        </button>
        <button
          className="tb-btn"
          title="Peek to the top edge — slides down when you move near it. ⌘⇧Space to summon."
          onClick={onMinimize}
        >
          —
        </button>
      </div>
    </div>
  );
}
