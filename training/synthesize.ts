// Synthetic trajectory generator.
//
// Real usage is the best training signal, but it's sparse early on — and the
// behaviors we most want to teach (decompose first, never narrate, confirm before
// sending, refuse when grounding is empty) are exactly the ones a fresh install
// rarely produces cleanly. So we MANUFACTURE gold trajectories for them.
//
// The trick ("track it through code"): we own the tool layer, so we can script a
// mock tool environment with deterministic results and emit the canonical correct
// trajectory — the exact messages/tool_calls a perfect run would produce — in the
// same schema as live capture (schema_version 1), tagged source:"synthetic". The
// exporter then mixes these with real "live" records and weights them.
//
// Coverage is multiplied two ways: over an entity POOL, and over PHRASING variants
// per scenario — so the model learns the behavior, not one surface form. Builders
// (singleTool/chainTools/withBoard/noTool) guarantee the structural invariant that
// every assistant tool-call turn is followed by its matching tool result.
//
// Deterministic by construction (fixed pools, indexed ids/timestamps) so re-runs
// are stable and diffable. No model, no network, no side effects.
//
// Run:  node --experimental-strip-types training/synthesize.ts [--out FILE]

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ChatMessage, ToolCall, ToolEvent, TrajectoryRecord } from "./types.ts";

// --- entity pools (kept small & obviously-synthetic; redaction-safe) ----------
const PEOPLE = ["Jordan Avery", "Priya Nair", "Marcus Webb", "Lena Ortiz", "Sam Cho", "Dana Reyes", "Omar Idris"];
const ORGS = ["Northwind Logistics", "Acme Robotics", "Brightline Health", "Vela Capital", "Cedar Foods"];
const TOPICS = ["the Q3 roadmap", "the onboarding flow", "the pricing change", "the launch plan", "the hiring plan"];
const DAYS = ["tomorrow", "today", "Friday", "next Monday", "this week"];
const FILES = ["the budget spreadsheet", "the design doc", "the contract draft", "the pitch deck"];

let seq = 0;
const BASE = Date.parse("2026-01-01T09:00:00Z");
const nextId = (p: string) => `${p}-${(seq++).toString(36)}`;
const ts = () => new Date(BASE + seq * 60_000).toISOString();
const first = (full: string) => full.split(" ")[0];
// Deterministic pick from an array by index (stable across runs).
const pick = <T>(arr: T[], i: number): T => arr[i % arr.length];

// A short, representative system message. The exporter NORMALIZES the system
// message across every example (real + synthetic) to the canonical production
// prompt, so this placeholder's exact text doesn't matter — only its presence.
const SYS = "You are Brain, Andres' personal assistant. Use tools; ground every claim; confirm before sending.";

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: nextId("call"), type: "function", function: { name, arguments: JSON.stringify(args) } };
}

interface BuildOpts {
  task: string;
  user: string;
  messages: ChatMessage[];
  toolEvents: ToolEvent[];
  final: string;
  rounds: number;
}
function record(o: BuildOpts): TrajectoryRecord {
  return {
    schema_version: 1,
    conversation_id: nextId("conv"),
    turn_id: nextId("turn"),
    created_at: ts(),
    model_id: "qwen3-8b",
    task_type: o.task,
    routed: true,
    user: o.user,
    messages: o.messages,
    tool_events: o.toolEvents,
    tools_used: [...new Set(o.toolEvents.map((e) => e.name))],
    rounds: o.rounds,
    final_answer: o.final,
    rating: 1, // synthetic gold trajectories are positive examples
    source: "synthetic",
  };
}

// --- trajectory builders (guarantee the call→result invariant) -----------------
interface Step {
  name: string;
  args: Record<string, unknown>;
  result: string;
}

/** One tool, then a grounded answer. */
function singleTool(task: string, user: string, step: Step, final: string): TrajectoryRecord {
  const c = call(step.name, step.args);
  return record({
    task,
    user,
    rounds: 1,
    final,
    toolEvents: [{ round: 0, name: c.function.name, arguments: c.function.arguments, ok: true }],
    messages: [
      { role: "system", content: SYS },
      { role: "user", content: user },
      { role: "assistant", content: "", tool_calls: [c] },
      { role: "tool", tool_call_id: c.id, name: step.name, content: step.result },
      { role: "assistant", content: final },
    ],
  });
}

/** A chain of tools, each its own round, then a grounded answer. */
function chainTools(task: string, user: string, steps: Step[], final: string): TrajectoryRecord {
  const messages: ChatMessage[] = [
    { role: "system", content: SYS },
    { role: "user", content: user },
  ];
  const toolEvents: ToolEvent[] = [];
  steps.forEach((s, i) => {
    const c = call(s.name, s.args);
    messages.push({ role: "assistant", content: "", tool_calls: [c] });
    messages.push({ role: "tool", tool_call_id: c.id, name: s.name, content: s.result });
    toolEvents.push({ round: i, name: s.name, arguments: c.function.arguments, ok: true });
  });
  messages.push({ role: "assistant", content: final });
  return record({ task, user, rounds: steps.length, final, messages, toolEvents });
}

/** Multi-step request: manage_tasks FIRST (the board IS the plan), then the steps,
 *  then a final answer. Teaches decomposition + no plan-in-prose. */
function withBoard(
  user: string,
  cards: { title: string; status: string }[],
  steps: Step[],
  final: string
): TrajectoryRecord {
  const board = call("manage_tasks", { cards });
  const messages: ChatMessage[] = [
    { role: "system", content: SYS },
    { role: "user", content: user },
    { role: "assistant", content: "", tool_calls: [board] },
    { role: "tool", tool_call_id: board.id, name: "manage_tasks", content: `board created (${cards.length} cards)` },
  ];
  const toolEvents: ToolEvent[] = [{ round: 0, name: "manage_tasks", arguments: board.function.arguments, ok: true }];
  steps.forEach((s, i) => {
    const c = call(s.name, s.args);
    messages.push({ role: "assistant", content: "", tool_calls: [c] });
    messages.push({ role: "tool", tool_call_id: c.id, name: s.name, content: s.result });
    toolEvents.push({ round: i + 1, name: s.name, arguments: c.function.arguments, ok: true });
  });
  messages.push({ role: "assistant", content: final });
  return record({ task: "deep", user, rounds: steps.length + 1, final, messages, toolEvents });
}

/** No tool call at all — the gold turn asks/answers directly (confirm-before-send,
 *  or a question that needs no tool). */
function noTool(task: string, user: string, final: string): TrajectoryRecord {
  return record({
    task,
    user,
    rounds: 1,
    final,
    toolEvents: [],
    messages: [
      { role: "system", content: SYS },
      { role: "user", content: user },
      { role: "assistant", content: final },
    ],
  });
}

// --- scenario generators ------------------------------------------------------

/** brain_page-first on a named PERSON, across phrasings → one grounded answer. */
function* people(): Generator<TrajectoryRecord> {
  const phrasings = ["who is {n}?", "tell me about {n}", "what's {n}'s role?", "give me the latest on {n}"];
  for (let i = 0; i < PEOPLE.length; i++) {
    const n = PEOPLE[i];
    const result = `${n} — VP Operations at Northwind. Owns the fulfillment SLA. Last sync: shipping delays resolved.`;
    const final = `${n} is VP Operations at Northwind, where they own the fulfillment SLA. Latest: the shipping delays are resolved.`;
    for (const p of phrasings) {
      const user = p.replace("{n}", n);
      yield singleTool("action", user, { name: "brain_page", args: { name: n }, result }, final);
    }
  }
}

/** brain_page-first on a named ORG. */
function* orgs(): Generator<TrajectoryRecord> {
  const phrasings = ["what's the deal with {o}?", "tell me about {o}", "where are we with {o}?"];
  for (let i = 0; i < ORGS.length; i++) {
    const o = ORGS[i];
    const result = `${o} — active partner; contract renews in Q4; main contact is ${pick(PEOPLE, i)}.`;
    const final = `${o} is an active partner with a Q4 renewal; your main contact there is ${pick(PEOPLE, i)}.`;
    for (const p of phrasings) {
      yield singleTool("action", p.replace("{o}", o), { name: "brain_page", args: { name: o }, result }, final);
    }
  }
}

/** Multi-step (3 tasks) → board-first, ending with a confirm on the send card. */
function* decompose3(): Generator<TrajectoryRecord> {
  const phrasings = [
    "pull {who}'s latest, summarize {topic}, and draft an email to {to}",
    "get me {who}'s status, write up {topic}, then prep a note to {to}",
  ];
  for (let i = 0; i < PEOPLE.length; i++) {
    const who = PEOPLE[i];
    const topic = pick(TOPICS, i);
    const to = pick(PEOPLE, i + 1);
    for (const p of phrasings) {
      const user = p.replace("{who}", who).replace("{topic}", topic).replace("{to}", to);
      yield withBoard(
        user,
        [
          { title: `Pull ${who}'s latest`, status: "in_progress" },
          { title: `Summarize ${topic}`, status: "todo" },
          { title: `Draft email to ${to}`, status: "todo" },
        ],
        [
          { name: "brain_page", args: { name: who }, result: `${who} — leading ${topic}; one timeline risk flagged.` },
          { name: "brain_search", args: { query: topic }, result: `${topic}: three workstreams, one slipping a week.` },
        ],
        `Done. ${who} is leading ${topic} with one timeline risk. Summary: three workstreams, one slipping a week. ` +
          `I've drafted the email to ${to} — want me to send it?`
      );
    }
  }
}

/** Multi-step (2 tasks) → board-first. */
function* decompose2(): Generator<TrajectoryRecord> {
  for (let i = 0; i < 4; i++) {
    const day = pick(DAYS, i);
    const topic = pick(TOPICS, i);
    const user = `check my calendar ${day} and summarize ${topic}`;
    yield withBoard(
      user,
      [
        { title: `Check calendar ${day}`, status: "in_progress" },
        { title: `Summarize ${topic}`, status: "todo" },
      ],
      [
        { name: "calendar_events", args: { range: day }, result: "10:00 Standup; 14:00 Review" },
        { name: "brain_search", args: { query: topic }, result: `${topic}: on track, review ${day}.` },
      ],
      `${day} you have a 10am standup and a 2pm review. On ${topic}: on track, with a review ${day}.`
    );
  }
}

/** "Email/message X …" → DRAFT + ask to confirm; emit NO send tool this turn. */
function* confirmSend(): Generator<TrajectoryRecord> {
  const phrasings = ["email {n} that {topic} is approved", "send {n} a note saying {topic} is approved", "tell {n} {topic} got approved"];
  for (let i = 0; i < PEOPLE.length; i++) {
    const n = PEOPLE[i];
    const topic = pick(TOPICS, i);
    for (const p of phrasings) {
      const user = p.replace("{n}", n).replace("{topic}", topic);
      const final = `Here's the draft to ${n}:\n\nSubject: ${topic} — approved\n\nHi ${first(n)}, confirming ${topic} is approved. Best, Andres\n\nSend it?`;
      yield noTool("action", user, final);
    }
  }
}

/** Brain doesn't know the entity → brain_page empty → say so, don't fabricate. */
function* groundingRefusal(): Generator<TrajectoryRecord> {
  const phrasings = ["what's our latest status with {o}?", "give me the rundown on {o}"];
  for (const o of ORGS) {
    for (const p of phrasings) {
      yield singleTool(
        "action",
        p.replace("{o}", o),
        { name: "brain_page", args: { name: o }, result: "No page found for that entity." },
        `I don't have anything on ${o} in your brain yet — nothing to report. Want me to search the web instead?`
      );
    }
  }
}

/** "Latest on X" → web_search → fetch_url → answer from the live page. */
function* webLookup(): Generator<TrajectoryRecord> {
  const phrasings = ["what's the latest on {t}?", "look up recent news about {t}", "search the web for {t}"];
  for (let i = 0; i < TOPICS.length; i++) {
    const t = TOPICS[i];
    const url = "https://example.com/report";
    for (const p of phrasings) {
      yield chainTools(
        "action",
        p.replace("{t}", t),
        [
          { name: "web_search", args: { query: `latest ${t}` }, result: `1. Report — ${url}` },
          { name: "fetch_url", args: { url }, result: `${t} shipped a milestone; next review Friday.` },
        ],
        `Per the latest report, ${t} shipped a milestone this week and the next review is set for Friday.`
      );
    }
  }
}

/** Calendar read. */
function* calendar(): Generator<TrajectoryRecord> {
  const phrasings = ["what's on my calendar {d}?", "am I busy {d}?"];
  for (const d of DAYS) {
    for (const p of phrasings) {
      yield singleTool(
        "action",
        p.replace("{d}", d),
        { name: "calendar_events", args: { range: d }, result: "10:00 Standup; 14:00 Review" },
        `${d === "today" ? "Today" : d} you have two events: a 10am standup and a 2pm review.`
      );
    }
  }
}

/** Inbox: read_emails (list) → email_details (one) → answer. */
function* email(): Generator<TrajectoryRecord> {
  for (let i = 0; i < 4; i++) {
    const who = pick(PEOPLE, i);
    yield chainTools(
      "action",
      `what did ${who} email me about?`,
      [
        { name: "read_emails", args: { query: who }, result: `1. ${who}: "${pick(TOPICS, i)} update"` },
        { name: "email_details", args: { query: who }, result: `${who} says ${pick(TOPICS, i)} is on track; needs sign-off by Friday.` },
      ],
      `${who} emailed about ${pick(TOPICS, i)} — it's on track, and they need your sign-off by Friday.`
    );
  }
}

/** Files: find_files → read_file → answer. */
function* files(): Generator<TrajectoryRecord> {
  for (let i = 0; i < FILES.length; i++) {
    const f = FILES[i];
    yield chainTools(
      "action",
      `find ${f} and tell me what it says`,
      [
        { name: "find_files", args: { query: f }, result: `~/Documents/${f.replace(/^the /, "")}.pdf` },
        { name: "read_file", args: { path: `~/Documents/${f.replace(/^the /, "")}.pdf` }, result: `${f}: totals look final; one open question on timing.` },
      ],
      `${f} looks final; the one open item is timing.`
    );
  }
}

/** Reminders: a confirm-before-create style, no side-effect tool fired. */
function* reminders(): Generator<TrajectoryRecord> {
  for (let i = 0; i < 4; i++) {
    const topic = pick(TOPICS, i);
    const day = pick(DAYS, i);
    yield noTool(
      "action",
      `remind me about ${topic} ${day}`,
      `I'll add a reminder: "${topic}" for ${day}. Confirm and I'll create it.`
    );
  }
}

/** system_control: direct device actions (no confirm needed for volume/media). */
function* systemControl(): Generator<TrajectoryRecord> {
  const cases: { user: string; action: string; final: string }[] = [
    { user: "turn the volume down", action: "volume_down", final: "Turned the volume down." },
    { user: "mute the mac", action: "mute", final: "Muted system audio." },
    { user: "pause the music", action: "media_playpause", final: "Paused." },
    { user: "raise the brightness", action: "brightness_up", final: "Raised the brightness." },
  ];
  for (const c of cases) {
    yield singleTool("action", c.user, { name: "system_control", args: { action: c.action }, result: "ok" }, c.final);
  }
}

/** Recurring automation: confirm the schedule + what it does, then create. */
function* automations(): Generator<TrajectoryRecord> {
  const cases = [
    { user: "every Monday at 9 email me my Facebook metrics", when: "Mondays at 9am", what: "email your Facebook metrics" },
    { user: "each morning brief me on my calendar", when: "every morning", what: "speak your calendar briefing" },
  ];
  for (const c of cases) {
    yield noTool("action", c.user, `I'll set up an automation to ${c.what} ${c.when}. Confirm and I'll create it.`);
  }
}

const GENERATORS = [
  people, orgs, decompose3, decompose2, confirmSend, groundingRefusal,
  webLookup, calendar, email, files, reminders, systemControl, automations,
];

function generateAll(): TrajectoryRecord[] {
  const out: TrajectoryRecord[] = [];
  for (const gen of GENERATORS) for (const rec of gen()) out.push(rec);
  return out;
}

// --- main ---------------------------------------------------------------------
function parseOut(): string {
  const i = process.argv.indexOf("--out");
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "training/data/synthetic.jsonl";
}

const records = generateAll();
const outPath = parseOut();
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");

const byTask = records.reduce<Record<string, number>>((m, r) => {
  m[r.task_type] = (m[r.task_type] ?? 0) + 1;
  return m;
}, {});
const tools = records.reduce<Record<string, number>>((m, r) => {
  for (const t of r.tools_used) m[t] = (m[t] ?? 0) + 1;
  return m;
}, {});
console.log(`wrote ${records.length} synthetic trajectories → ${outPath}`);
console.log("by task_type:", byTask);
console.log("tool coverage:", tools);
