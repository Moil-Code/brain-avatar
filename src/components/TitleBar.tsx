interface Props {
  onOpenSettings: () => void;
  onMinimize: () => void;
  peeked: boolean;
  onExitPeek: () => void;
}

export default function TitleBar({ onOpenSettings, onMinimize, peeked, onExitPeek }: Props) {
  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-name" data-tauri-drag-region>
        Brain
      </div>
      <div className="titlebar-actions">
        {peeked && (
          <button className="tb-btn" title="Dock back" onClick={onExitPeek}>
            ⤢
          </button>
        )}
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
