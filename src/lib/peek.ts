import {
  getCurrentWindow,
  currentMonitor,
  PhysicalPosition,
  PhysicalSize,
} from "@tauri-apps/api/window";

const MENU_BAR_PX = 26;
const BAR_W = 200;
const BAR_H = 34;
const FULL_W = 420;
const FULL_H = 640;

let saved: { x: number; y: number; w: number; h: number } | null = null;

async function topCenter(widthLogical: number) {
  const mon = await currentMonitor();
  const scale = mon?.scaleFactor ?? 1;
  const originX = mon?.position.x ?? 0;
  const originY = mon?.position.y ?? 0;
  const screenW = mon?.size.width ?? Math.round(1440 * scale);
  const x = originX + Math.round((screenW - widthLogical * scale) / 2);
  const y = originY + Math.round(MENU_BAR_PX * scale);
  return { x, y, scale };
}

/** Shrink the window into a small top-center bar and remember where it was. */
export async function enterPeek() {
  const win = getCurrentWindow();
  const pos = await win.outerPosition();
  const size = await win.outerSize();
  saved = { x: pos.x, y: pos.y, w: size.width, h: size.height };
  await collapsePeek();
}

export async function collapsePeek() {
  const win = getCurrentWindow();
  const { x, y, scale } = await topCenter(BAR_W);
  await win.setSize(new PhysicalSize(Math.round(BAR_W * scale), Math.round(BAR_H * scale)));
  await win.setPosition(new PhysicalPosition(x, y));
}

export async function expandPeek() {
  const win = getCurrentWindow();
  const { x, y, scale } = await topCenter(FULL_W);
  await win.setSize(new PhysicalSize(Math.round(FULL_W * scale), Math.round(FULL_H * scale)));
  await win.setPosition(new PhysicalPosition(x, y));
}

/** Restore the window to its pre-peek size and position. */
export async function exitPeek() {
  const win = getCurrentWindow();
  if (saved) {
    await win.setSize(new PhysicalSize(saved.w, saved.h));
    await win.setPosition(new PhysicalPosition(saved.x, saved.y));
    saved = null;
  }
}
