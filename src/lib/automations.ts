// The proactive layer: scheduled tasks the avatar runs on its own and delivers
// through notifications / speech / email / brain. The store lives in Rust
// (automations.json); this module owns the schema, due-checking, and delivery.
//
// Deliberately does NOT import agent.ts — the orchestration (calling runAgent
// then deliver) lives in App.tsx, so there is no import cycle.

import {
  getAutomations as rawGet,
  setAutomations as rawSet,
  notify,
  pushChat,
  sendEmail,
} from "./tauri";
import { speak } from "./voice";
import type { Automation, AutomationDelivery, AutomationSchedule } from "./types";

export const DEFAULT_AUTOMATION_EMAIL = "andres@moilapp.com";

/** If the app was closed at the scheduled minute, still fire when reopened within
 *  this window (so a 9am briefing opened at 10am still runs, but not at 9pm). */
const CATCHUP_MS = 6 * 60 * 60 * 1000;

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function parseHM(t: string): { h: number; m: number } {
  const [h, m] = (t || "09:00").split(":").map((x) => parseInt(x, 10));
  return { h: Number.isFinite(h) ? h : 9, m: Number.isFinite(m) ? m : 0 };
}

// --- store ---------------------------------------------------------------

export async function loadAutomations(): Promise<Automation[]> {
  const raw = await rawGet().catch(() => [] as Automation[]);
  return Array.isArray(raw) ? raw : [];
}

export async function saveAutomations(list: Automation[]): Promise<void> {
  await rawSet(list);
}

/** Insert or replace an automation by id and persist. Returns the new list. */
export async function upsertAutomation(a: Automation): Promise<Automation[]> {
  const list = await loadAutomations();
  const i = list.findIndex((x) => x.id === a.id);
  if (i >= 0) list[i] = a;
  else list.push(a);
  await saveAutomations(list);
  return list;
}

export async function removeAutomation(id: string): Promise<Automation[]> {
  const list = (await loadAutomations()).filter((x) => x.id !== id);
  await saveAutomations(list);
  return list;
}

/** Build a fully-formed Automation from partial input (used by the UI and the
 *  create_automation tool). Delivery defaults to notify + speak. */
export function makeAutomation(input: {
  name: string;
  prompt: string;
  schedule: AutomationSchedule;
  delivery?: Partial<AutomationDelivery>;
  emailTo?: string;
}): Automation {
  return {
    id: uid(),
    name: input.name.trim() || "Untitled automation",
    prompt: input.prompt.trim(),
    schedule: input.schedule,
    delivery: {
      speak: input.delivery?.speak ?? true,
      notify: input.delivery?.notify ?? true,
      email: input.delivery?.email ?? false,
      brain: input.delivery?.brain ?? false,
    },
    emailTo: input.emailTo,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
}

/** Ready-made nightly automation — processes today's conversations and pushes
 *  key insights into the brain. Pass to makeAutomation() to instantiate. */
export const BRAIN_ENRICHMENT_PRESET = {
  name: "Nightly Brain Enrichment",
  prompt:
    "Fetch today's conversations using fetch_daily_conversations. For each conversation, " +
    "extract: key decisions made, people mentioned (with context), projects or tasks referenced, " +
    "commitments or follow-ups promised, and any lessons learned. Before saving each insight, " +
    "use brain_search to check if it is already known — skip anything the brain already has. " +
    "For each genuinely new insight, call push_chat with a descriptive title " +
    "(e.g. 'Decision: [topic] – [date]') and the full insight content. " +
    "Aim for 3–7 distinct insights. If no new insights are found, say so.",
  schedule: { kind: "daily" as const, time: "22:30" },
  delivery: { speak: false, notify: true, email: false, brain: true },
} satisfies Parameters<typeof makeAutomation>[0];

// --- scheduling ----------------------------------------------------------

/** Most recent scheduled slot at or before `now` for a daily automation. */
function slotDaily(time: string, now: Date): Date {
  const { h, m } = parseHM(time);
  const slot = new Date(now);
  slot.setHours(h, m, 0, 0);
  if (slot.getTime() > now.getTime()) slot.setDate(slot.getDate() - 1);
  return slot;
}
function slotWeekly(weekday: number, time: string, now: Date): Date {
  const { h, m } = parseHM(time);
  const slot = new Date(now);
  slot.setHours(h, m, 0, 0);
  let diff = (slot.getDay() - weekday + 7) % 7;
  if (diff === 0 && slot.getTime() > now.getTime()) diff = 7;
  slot.setDate(slot.getDate() - diff);
  return slot;
}
function slotHourly(minute: number, now: Date): Date {
  const slot = new Date(now);
  slot.setMinutes(minute, 0, 0);
  if (slot.getTime() > now.getTime()) slot.setHours(slot.getHours() - 1);
  return slot;
}

/** Whether an automation should fire right now (enabled, past its slot, not yet
 *  run for that slot, and still within the catch-up window). */
export function isDue(a: Automation, now: Date = new Date()): boolean {
  if (!a.enabled) return false;
  const last = a.lastRun ? new Date(a.lastRun).getTime() : 0;
  const s = a.schedule;
  if (s.kind === "interval") {
    const every = Math.max(1, s.everyMinutes) * 60000;
    return now.getTime() - last >= every;
  }
  let slot: Date;
  if (s.kind === "daily") slot = slotDaily(s.time, now);
  else if (s.kind === "weekly") slot = slotWeekly(s.weekday, s.time, now);
  else slot = slotHourly(s.minute, now);
  const slotMs = slot.getTime();
  return slotMs <= now.getTime() && last < slotMs && now.getTime() - slotMs <= CATCHUP_MS;
}

/** Human description for the UI and spoken confirmations. */
export function describeSchedule(s: AutomationSchedule): string {
  switch (s.kind) {
    case "daily":
      return `every day at ${s.time}`;
    case "weekly":
      return `every ${WEEKDAYS[s.weekday] ?? "week"} at ${s.time}`;
    case "hourly":
      return `every hour at :${pad(s.minute)}`;
    case "interval":
      return `every ${s.everyMinutes} min`;
  }
}

/** One-line summary of all automations (for the list_automations tool). */
export function summarizeAutomations(list: Automation[]): string {
  if (list.length === 0) return "No automations are set up yet.";
  return list
    .map((a) => {
      const on = a.enabled ? "on" : "off";
      const ch = Object.entries(a.delivery)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join("+");
      return `• ${a.name} — ${describeSchedule(a.schedule)} (${on}; delivers via ${ch || "nothing"})`;
    })
    .join("\n");
}

// --- delivery ------------------------------------------------------------

function toHtml(text: string): string {
  const esc = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return esc.replace(/\n/g, "<br>");
}

/** Deliver an automation result through its background channels (notify / email /
 *  brain). Speech and the in-app chat record are handled by the caller so they can
 *  drive the avatar's speaking state. Each channel fails independently. */
export async function deliverAutomation(a: Automation, content: string): Promise<void> {
  const title = `Brain · ${a.name}`;
  if (a.delivery.notify) await notify(title, content).catch(() => {});
  if (a.delivery.email) {
    const to = (a.emailTo || DEFAULT_AUTOMATION_EMAIL).trim();
    await sendEmail([to], `[Brain] ${a.name}`, toHtml(content)).catch(() => {});
  }
  if (a.delivery.brain) {
    await pushChat(`automation-${a.id}`, a.name, "assistant", content).catch(() => {});
  }
}

/** Convenience for the caller: speak a result if the automation opted into voice. */
export function maybeSpeak(a: Automation, content: string): void {
  if (a.delivery.speak) speak(content);
}
