// Pure helpers for the kanban task board — no Tauri, no React, fully unit-testable.
// These drive the agent loop's three guardrails against the "narrate a plan but
// never execute it" failure:
//   1. detectNarration  — catches a model describing work instead of calling tools.
//   2. isMultiTask / estimateTaskCount — decides when to force board decomposition.
//   3. validateEvidence — refuses a "done" card that isn't backed by a real tool call.

import type { TaskBoard, TaskCard } from "./types";

/** Named patterns that signal the model is narrating a plan instead of acting.
 *  Each is individually testable; detectNarration returns the matched name. */
export const NARRATION_PATTERNS: { name: string; re: RegExp }[] = [
  // The exact failure phrasings observed in the TEDC conversation:
  {
    name: "queued_tasks",
    re: /\bi(?:['’]?ve| have)\s+(?:queued|added|created|noted|listed|broken\s+(?:down|out))\s+(?:all\s+)?(?:the\s+)?(?:tasks?|items?|steps?)\b/i,
  },
  {
    name: "heres_the_breakdown",
    re: /\b(?:here(?:['’]?s| is)|below is)\s+(?:the|my|a)\s+(?:breakdown|plan|outline|approach|sequence|task\s+list)\b/i,
  },
  {
    name: "ill_do_next",
    re: /\bi(?:['’]?ll| will)\s+(?:do|tackle|handle|address|work\s+on|start\s+with|begin\s+with)\s+(?:this|that|these|next|first|the\s+(?:first|next))\b/i,
  },
  {
    name: "next_steps_label",
    re: /(?:^|\n)\s*(?:next\s+steps?|plan|here(?:['’]?s| is)\s+what\s+i(?:['’]?ll| will)\s+do)\s*:/im,
  },
  // The original ACTION_CLAIM coverage, widened with more action verbs:
  {
    name: "i_will_action",
    re: /\bi(?:['’]?ll| will)\s+(?:search|look\s+up|find|locate|open|check|attempt|handle|retrieve|pull\s+up|fetch|get|analyze|review|read|write|draft|send|schedule|create|update|generate|compile|summarize|extract|run|start|begin|proceed)\b/i,
  },
  {
    name: "let_me_action",
    re: /\blet\s+me\s+(?:search|look\s+up|find|locate|open|check|retrieve|pull\s+up|fetch|get|access|analyze|review|read|write|draft|send|schedule|create|run|start|begin|investigate|examine|verify|gather)\b/i,
  },
  {
    name: "ive_done_action",
    re: /\bi(?:['’]?ve| have)\s+(?:opened|found|located|searched|scheduled|sent|retrieved|drafted|written|analyzed|reviewed|created|updated|generated|fetched|pulled|completed|finished)\b/i,
  },
  { name: "searching_for", re: /\b(?:searching|looking|hunting)\s+for\b/i },
];

/** Two consecutive numbered list items (1. … 2. …) — a plan written in prose. */
export const NUMBERED_PLAN = /(?:^|\n)\s*1[.)]\s+\S[\s\S]{1,400}?(?:^|\n)\s*2[.)]\s+\S/m;

/** Returns the name of the first narration pattern matched, or null if the text
 *  reads as a genuine answer/question rather than an unexecuted plan. */
export function detectNarration(content: string): string | null {
  if (!content) return null;
  for (const p of NARRATION_PATTERNS) if (p.re.test(content)) return p.name;
  // A numbered plan (two+ items on their own lines) reads as narration unless it's
  // a short tally or a question to the user. >40 chars skips tiny numbered answers
  // like "1. 4\n2. 6"; the trailing-"?" check skips a numbered question.
  if (content.length > 40 && NUMBERED_PLAN.test(content) && !/\?\s*$/.test(content.trim())) {
    return "numbered_plan_no_tool";
  }
  return null;
}

const IMPERATIVE_VERBS = [
  "search", "find", "look", "check", "fetch", "get", "retrieve", "pull", "open", "read",
  "write", "draft", "send", "email", "reply", "schedule", "book", "create", "add", "update",
  "delete", "summarize", "analyze", "review", "compile", "extract", "list", "show", "explain",
  "post", "upload", "download", "run", "compose", "prepare", "build", "generate", "plan", "rewrite",
  "research", "interview", "compare", "investigate", "evaluate", "assess", "audit", "outline", "gather",
];

/** Rough count of distinct tasks in a user message. Errs generous: a false high
 *  count just spends a cheap extra round; a false low count is the dropped-task bug. */
export function estimateTaskCount(userMsg: string): number {
  const msg = userMsg.trim();
  if (!msg) return 0;
  // 1) Explicit numbered/bulleted list wins.
  const numbered = msg.match(/(?:^|\n)\s*\d+[.)]\s+\S/g);
  if (numbered && numbered.length >= 2) return numbered.length;
  // 2) Distinct imperative verbs after a clause boundary (start, ". ", "and", "then", ",").
  const lower = msg.toLowerCase();
  const hits = new Set<string>();
  for (const v of IMPERATIVE_VERBS) {
    const re = new RegExp(`(?:^|[.!?]\\s+|\\sand\\s+|\\sthen\\s+|,\\s+)${v}\\b`, "i");
    if (re.test(lower)) hits.add(v);
  }
  if (hits.size >= 2) return hits.size;
  // 3) Explicit sequencing connectors ("and then", "after that", "also", ";").
  const conn = msg.split(/\s(?:and\s+then|then|after\s+that|also)\s|;\s/i).filter((s) => s.trim().length > 4);
  if (conn.length >= 2) return conn.length;
  return 1;
}

export function isMultiTask(userMsg: string): boolean {
  return estimateTaskCount(userMsg) >= 2;
}

/** Harness-side evidence gate: a "done" card must be backed by something real.
 *  Accept when the evidence names a tool that actually ran this round, or carries
 *  a concrete artifact (path, URL, quoted/prefixed id, or a number-with-unit). */
export function validateEvidence(
  evidence: string | undefined,
  toolsThisRound: Set<string>
): { ok: boolean; reason?: string } {
  if (!evidence || evidence.trim().length < 8) {
    return { ok: false, reason: "evidence is empty or too short (<8 chars)" };
  }
  const lower = evidence.toLowerCase();
  for (const t of toolsThisRound) {
    if (t !== "manage_tasks" && lower.includes(t.toLowerCase())) return { ok: true };
  }
  if (/(?:\/Users\/|\/Library\/|~\/)/.test(evidence)) return { ok: true };
  if (/\bhttps?:\/\//i.test(evidence)) return { ok: true };
  if (/(?:`[^`]+`|\b(?:msg_|event_|conv_|file_|task_)[\w-]{4,})/.test(evidence)) return { ok: true };
  if (
    /\b\d{2,}\s*(?:bytes|chars|lines|results|matches|rows|kb|mb|messages|emails|events|files|slides|hits|words)\b/i.test(
      evidence
    )
  ) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: "evidence must name a tool that ran this round, a path, a URL, a quoted ID, or a number-with-unit",
  };
}

const STATUS_ORDER: TaskCard["status"][] = ["in_progress", "todo", "blocked", "done"];

/** Compact text rendering of the board for re-injection into the model context. */
export function renderBoardSnapshot(b: TaskBoard): string {
  const cols: Record<string, TaskCard[]> = { in_progress: [], todo: [], blocked: [], done: [] };
  for (const c of b.tasks) (cols[c.status] ?? cols.todo).push(c);
  const line = (c: TaskCard) =>
    `  - [${(c.id || "").slice(0, 6)}] ${c.title}` +
    (c.attempt_count > 1 ? ` (×${c.attempt_count})` : "") +
    (c.evidence ? ` — ev: ${c.evidence.slice(0, 80)}` : "") +
    (c.blocker ? ` — blocker: ${c.blocker}` : "");
  const out: string[] = [];
  for (const status of STATUS_ORDER) {
    const items = cols[status];
    out.push(`${status.toUpperCase()} (${items.length}):`);
    out.push(...items.map(line));
  }
  return out.join("\n");
}

/** Count of cards still needing work (todo or in_progress). */
export function openCardCount(b: TaskBoard | null): number {
  if (!b) return 0;
  return b.tasks.filter((c) => c.status === "todo" || c.status === "in_progress").length;
}
