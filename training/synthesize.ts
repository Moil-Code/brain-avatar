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
// Deterministic by construction (fixed entity pool, indexed ids/timestamps) so
// re-runs are stable and diffable. No model, no network, no side effects.
//
// Run:  node --experimental-strip-types training/synthesize.ts [--out FILE]

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ChatMessage, ToolCall, ToolEvent, TrajectoryRecord } from "./types.ts";

// --- entity pools (kept small & obviously-synthetic; redaction-safe) ----------
const PEOPLE = ["Jordan Avery", "Priya Nair", "Marcus Webb", "Lena Ortiz", "Sam Cho"];
const ORGS = ["Northwind Logistics", "Acme Robotics", "Brightline Health", "Vela Capital"];
const TOPICS = ["the Q3 roadmap", "the onboarding flow", "the pricing change", "the launch plan"];
const DAYS = ["tomorrow", "today", "Friday", "next Monday"];

let seq = 0;
const BASE = Date.parse("2026-01-01T09:00:00Z");
function nextId(prefix: string): string {
  return `${prefix}-${(seq++).toString(36)}`;
}
function ts(): string {
  return new Date(BASE + seq * 60_000).toISOString();
}

// A short, representative system message. The exporter NORMALIZES the system
// message across every example (real + synthetic) to the canonical production
// prompt, so this placeholder's exact text doesn't matter — only its presence.
const SYS = "You are Brain, Andres' personal assistant. Use tools; ground every claim; confirm before sending.";

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: nextId("call"), type: "function", function: { name, arguments: JSON.stringify(args) } };
}
function eventsFrom(calls: ToolCall[], round: number, ok = true): ToolEvent[] {
  return calls.map((c) => ({ round, name: c.function.name, arguments: c.function.arguments, ok }));
}

interface BuildOpts {
  task: string;
  user: string;
  messages: ChatMessage[];
  toolEvents: ToolEvent[];
  final: string;
  rounds: number;
  rating?: number | null;
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
    rating: o.rating ?? 1, // synthetic gold trajectories are positive examples
    source: "synthetic",
  };
}

// --- scenario generators ------------------------------------------------------

/** "Who is X" → brain_page(X) FIRST, then a grounded one-liner. Teaches: reach for
 *  brain_page on a named entity instead of answering from memory. */
function* brainPage(): Generator<TrajectoryRecord> {
  for (const name of PEOPLE) {
    const c = call("brain_page", { name });
    const result = `${name} — VP Operations at Northwind. Owns the fulfillment SLA. Last sync: shipping delays resolved.`;
    yield record({
      task: "action",
      user: `who is ${name}?`,
      final: `${name} is VP Operations at Northwind, where they own the fulfillment SLA. Latest: the shipping delays are resolved.`,
      rounds: 1,
      toolEvents: eventsFrom([c], 0),
      messages: [
        { role: "system", content: SYS },
        { role: "user", content: `who is ${name}?` },
        { role: "assistant", content: "", tool_calls: [c] },
        { role: "tool", tool_call_id: c.id, name: "brain_page", content: result },
        {
          role: "assistant",
          content: `${name} is VP Operations at Northwind, where they own the fulfillment SLA. Latest: the shipping delays are resolved.`,
        },
      ],
    });
  }
}

/** Multi-step request → manage_tasks FIRST (the board IS the plan), then the real
 *  tools, then a final answer. Teaches decomposition + no plan-in-prose. */
function* decompose(): Generator<TrajectoryRecord> {
  for (let i = 0; i < PEOPLE.length; i++) {
    const who = PEOPLE[i];
    const topic = TOPICS[i % TOPICS.length];
    const recipient = PEOPLE[(i + 1) % PEOPLE.length];
    const user = `pull ${who}'s latest, summarize ${topic}, and draft an email to ${recipient}`;

    const cards = [
      { title: `Pull ${who}'s latest`, status: "in_progress" },
      { title: `Summarize ${topic}`, status: "todo" },
      { title: `Draft email to ${recipient}`, status: "todo" },
    ];
    const boardCall = call("manage_tasks", { cards });
    const pageCall = call("brain_page", { name: who });
    const searchCall = call("brain_search", { query: topic });

    const pageResult = `${who} — leading ${topic}; flagged one open risk on timeline.`;
    const searchResult = `${topic}: three workstreams, one slipping a week; mitigation drafted.`;

    yield record({
      task: "deep",
      user,
      rounds: 3,
      final:
        `Done. ${who} is leading ${topic} with one timeline risk flagged. Summary: three workstreams, ` +
        `one slipping a week with a mitigation drafted. I've prepared a draft email to ${recipient} — ` +
        `want me to send it?`,
      toolEvents: [
        ...eventsFrom([boardCall], 0),
        ...eventsFrom([pageCall], 0),
        ...eventsFrom([searchCall], 1),
      ],
      messages: [
        { role: "system", content: SYS },
        { role: "user", content: user },
        // FIRST action: lay out the board.
        { role: "assistant", content: "", tool_calls: [boardCall] },
        { role: "tool", tool_call_id: boardCall.id, name: "manage_tasks", content: "board created (3 cards)" },
        // Work card 1.
        { role: "assistant", content: "", tool_calls: [pageCall] },
        { role: "tool", tool_call_id: pageCall.id, name: "brain_page", content: pageResult },
        // Work card 2.
        { role: "assistant", content: "", tool_calls: [searchCall] },
        { role: "tool", tool_call_id: searchCall.id, name: "brain_search", content: searchResult },
        // Card 3 SENDS → confirm instead of firing send_email.
        {
          role: "assistant",
          content:
            `Done. ${who} is leading ${topic} with one timeline risk flagged. Summary: three workstreams, ` +
            `one slipping a week with a mitigation drafted. I've prepared a draft email to ${recipient} — ` +
            `want me to send it?`,
        },
      ],
    });
  }
}

/** "Email X about Y" → DRAFT + ask for confirmation; emit NO send tool this turn.
 *  Teaches the confirm-before-send gate (the model must not fire side-effects). */
function* confirmBeforeSend(): Generator<TrajectoryRecord> {
  for (let i = 0; i < PEOPLE.length; i++) {
    const who = PEOPLE[i];
    const topic = TOPICS[i % TOPICS.length];
    const user = `email ${who} that ${topic} is approved`;
    const final =
      `Here's the draft to ${who}:\n\nSubject: ${topic} — approved\n\nHi ${who.split(" ")[0]}, ` +
      `confirming ${topic} is approved. Best, Andres\n\nSend it?`;
    yield record({
      task: "action",
      user,
      rounds: 1,
      final,
      toolEvents: [], // the gold turn makes NO tool call — it asks first
      messages: [
        { role: "system", content: SYS },
        { role: "user", content: user },
        { role: "assistant", content: final },
      ],
    });
  }
}

/** Named entity the brain doesn't know → brain_page returns empty → REFUSE/say so
 *  rather than fabricate. Teaches grounding discipline. */
function* groundingRefusal(): Generator<TrajectoryRecord> {
  for (const org of ORGS) {
    const c = call("brain_page", { name: org });
    yield record({
      task: "action",
      user: `what's our latest status with ${org}?`,
      rounds: 1,
      final: `I don't have anything on ${org} in your brain yet — nothing to report. Want me to search the web instead?`,
      toolEvents: eventsFrom([c], 0),
      messages: [
        { role: "system", content: SYS },
        { role: "user", content: `what's our latest status with ${org}?` },
        { role: "assistant", content: "", tool_calls: [c] },
        { role: "tool", tool_call_id: c.id, name: "brain_page", content: "No page found for that entity." },
        {
          role: "assistant",
          content: `I don't have anything on ${org} in your brain yet — nothing to report. Want me to search the web instead?`,
        },
      ],
    });
  }
}

/** "Latest on X" → web_search → fetch_url → answer from the live page. Teaches the
 *  search-then-open pattern and answering from the result, not memory. */
function* webLookup(): Generator<TrajectoryRecord> {
  for (const topic of TOPICS) {
    const q = `latest news ${topic}`;
    const search = call("web_search", { query: q });
    const url = "https://example.com/report";
    const fetch = call("fetch_url", { url });
    yield record({
      task: "action",
      user: `what's the latest on ${topic}?`,
      rounds: 2,
      final: `Per the latest report, ${topic} shipped a milestone this week and the next review is set for Friday.`,
      toolEvents: [...eventsFrom([search], 0), ...eventsFrom([fetch], 1)],
      messages: [
        { role: "system", content: SYS },
        { role: "user", content: `what's the latest on ${topic}?` },
        { role: "assistant", content: "", tool_calls: [search] },
        { role: "tool", tool_call_id: search.id, name: "web_search", content: `1. Report — ${url}` },
        { role: "assistant", content: "", tool_calls: [fetch] },
        { role: "tool", tool_call_id: fetch.id, name: "fetch_url", content: `${topic} shipped a milestone; review Friday.` },
        {
          role: "assistant",
          content: `Per the latest report, ${topic} shipped a milestone this week and the next review is set for Friday.`,
        },
      ],
    });
  }
}

/** "What's on my calendar <day>" → calendar_events → answer. */
function* calendar(): Generator<TrajectoryRecord> {
  for (const day of DAYS) {
    const c = call("calendar_events", { range: day });
    yield record({
      task: "action",
      user: `what's on my calendar ${day}?`,
      rounds: 1,
      final: `${day === "today" ? "Today" : day} you have two events: a 10am standup and a 2pm review.`,
      toolEvents: eventsFrom([c], 0),
      messages: [
        { role: "system", content: SYS },
        { role: "user", content: `what's on my calendar ${day}?` },
        { role: "assistant", content: "", tool_calls: [c] },
        { role: "tool", tool_call_id: c.id, name: "calendar_events", content: "10:00 Standup; 14:00 Review" },
        {
          role: "assistant",
          content: `${day === "today" ? "Today" : day} you have two events: a 10am standup and a 2pm review.`,
        },
      ],
    });
  }
}

const GENERATORS = [brainPage, decompose, confirmBeforeSend, groundingRefusal, webLookup, calendar];

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
console.log(`wrote ${records.length} synthetic trajectories → ${outPath}`);
console.log("by task_type:", byTask);
