// Derived outcome labels — computed at export from the captured trajectory stream,
// so they need no capture-time (app) instrumentation.
//
// "Was this turn corrected by the user on the very next turn?" is a cheap, high-value
// NEGATIVE signal: an answer the user immediately pushed back on ("no, that's wrong",
// "actually I meant…") is not a clean trajectory to imitate. We link consecutive turns
// by conversation_id + created_at and flag the preceding turn. Synthetic/distilled
// records each get a unique conversation_id, so they're never affected; this targets
// real live data as it accrues.

import type { TrajectoryRecord } from "./types.ts";

// Tools that SEND/POST/DELETE/message on the user's behalf — the system prompt requires
// an explicit confirmation (confirm=true) before they fire. A turn that fired one WITHOUT
// confirm broke the safety contract and must never be a gold example to imitate.
const SIDE_EFFECT_TOOLS = new Set([
  "send_email",
  "send_teams_message",
  "post_to_facebook",
  "send_imessage",
  "create_reminder",
  "create_automation",
  "calendar_delete",
]);

/** Did this turn fire a confirm-required tool without confirm=true in its arguments? */
export function firedUnconfirmedSend(r: TrajectoryRecord): boolean {
  return r.tool_events.some((e) => {
    if (!SIDE_EFFECT_TOOLS.has(e.name)) return false;
    try {
      return JSON.parse(e.arguments || "{}").confirm !== true;
    } catch {
      return true; // unparseable args on a send → treat as unconfirmed
    }
  });
}

const CORRECTION_RE =
  /^\s*(no\b|nope\b|nah\b|that'?s (not|wrong|incorrect)|not (what|quite|right)|wrong\b|actually\b|i meant\b|i said\b|that'?s not (it|what|right)|try again|incorrect\b|you (got it wrong|misunderstood))/i;

/** Heuristic: does this user message read as a correction/pushback on the prior answer? */
export function looksLikeCorrection(userText: string): boolean {
  return CORRECTION_RE.test(userText ?? "");
}

/** turn_ids whose answer was (likely) corrected by the user on the next turn of the
 *  same conversation. */
export function correctedTurnIds(records: TrajectoryRecord[]): Set<string> {
  const byConv = new Map<string, TrajectoryRecord[]>();
  for (const r of records) {
    const k = r.conversation_id ?? "";
    let arr = byConv.get(k);
    if (!arr) {
      arr = [];
      byConv.set(k, arr);
    }
    arr.push(r);
  }
  const corrected = new Set<string>();
  for (const turns of byConv.values()) {
    turns.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
    for (let i = 0; i < turns.length - 1; i++) {
      if (looksLikeCorrection(turns[i + 1].user)) corrected.add(turns[i].turn_id);
    }
  }
  return corrected;
}
