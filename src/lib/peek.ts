import { getCurrentWindow, currentMonitor, PhysicalPosition } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";

const STRIP_PX = 8;
const MENU_BAR_PX = 26;

let pollTimer: number | null = null;
let savedPos: { x: number; y: number } | null = null;
let revealed = false;

async function geo() {
  const win = getCurrentWindow();
  const mon = await currentMonitor();
  const size = await win.outerSize();
  const scale = mon?.scaleFactor ?? 1;
  const screenW = mon?.size.width ?? Math.round(1440 * scale);
  const centerX = Math.round((screenW - size.width) / 2);
  const menu = Math.round(MENU_BAR_PX * scale);
  const strip = Math.round(STRIP_PX * scale);
  return { win, size, scale, centerX, menu, strip };
}

async function place(reveal: boolean) {
  const g = await geo();
  const y = reveal ? g.menu : g.menu - (g.size.height - g.strip);
  await g.win.setPosition(new PhysicalPosition(g.centerX, y));
  revealed = reveal;
}

function startPoll() {
  stopPoll();
  pollTimer = window.setInterval(async () => {
    try {
      const [cx, cy] = await invoke<[number, number]>("cursor_position");
      const g = await geo();
      const xIn = cx >= g.centerX - 12 && cx <= g.centerX + g.size.width + 12;
      const overStrip = xIn && cy <= g.menu + g.strip + Math.round(8 * g.scale);
      const overWindow = xIn && cy >= g.menu - 6 && cy <= g.menu + g.size.height + 6;
      if (!revealed && overStrip) {
        await place(true);
      } else if (revealed && !overWindow) {
        await place(false);
      }
    } catch {
      /* ignore transient errors */
    }
  }, 150);
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** Dock to the top edge (strip visible) and start tracking the cursor to reveal/hide. */
export async function enterPeek() {
  const g = await geo();
  const pos = await g.win.outerPosition();
  savedPos = { x: pos.x, y: pos.y };
  revealed = false;
  await place(false);
  startPoll();
}

/** Leave peek mode and restore the previous position. */
export async function exitPeek() {
  stopPoll();
  const win = getCurrentWindow();
  if (savedPos) {
    await win.setPosition(new PhysicalPosition(savedPos.x, savedPos.y));
    savedPos = null;
  }
  revealed = false;
}
