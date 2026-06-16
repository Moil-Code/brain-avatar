import { getCurrentWindow } from "@tauri-apps/api/window";

interface Props {
  onOpenSettings: () => void;
}

export default function TitleBar({ onOpenSettings }: Props) {
  const win = getCurrentWindow();
  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-name" data-tauri-drag-region>
        Brain
      </div>
      <div className="titlebar-actions">
        <button className="tb-btn" title="Settings" onClick={onOpenSettings}>
          ⚙
        </button>
        <button className="tb-btn" title="Hide" onClick={() => win.hide()}>
          —
        </button>
      </div>
    </div>
  );
}
