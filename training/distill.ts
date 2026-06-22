// Teacher distillation — have the deep 26B (the best LOCAL model) generate gold
// trajectories for the fast tier to learn from. On-device, no cloud.
//
// For each seed task we run a bounded tool loop against an OpenAI-compatible
// endpoint (LM Studio serving the 26B), executing each tool the teacher picks via
// the MOCK environment (no real side effects), and record the trajectory tagged
// source:"distilled" in the same schema as live/synthetic. The exporter then mixes
// all three.
//
// Why mock tools: we want the teacher's tool-SELECTION and phrasing policy, grounded
// on plausible results, without sending email / hitting the real brain. Side-effect
// tools are never actually fired (mockenv returns a neutral ack), and the eval gate
// still penalizes sending-without-confirm, so weak teacher turns get filtered.
//
// Run on the Mac (26B loaded in LM Studio):
//   LMSTUDIO_URL=http://localhost:1234/v1 MODEL=gemma-4-26b-a4b-it-qat \
//     node --experimental-strip-types training/distill.ts [--out FILE] [--n 40]
//
// With no endpoint it LINTS the seed set and exits 0 (offline-safe).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ChatMessage, ToolEvent, TrajectoryRecord } from "./types.ts";
import { TOOLS } from "./eval/cases.ts";
import { mockToolResult } from "./mockenv.ts";
import { splitReasoning } from "./reasoning.ts";

const URL = process.env.LMSTUDIO_URL ?? "";
const MODEL = process.env.MODEL ?? "";
const TOKEN = process.env.LMSTUDIO_TOKEN ?? "";
const MAX_ROUNDS = 5;

const SYS =
  "You are Brain, Andres' personal assistant. Use tools to ground every claim. " +
  "For any action that sends, posts, or deletes, confirm with Andres before doing it.";

// Seed tasks the teacher demonstrates on. Mix of the behaviors we want taught;
// kept generic so the teacher fills in the reasoning.
const SEEDS: string[] = [
  "who is Priya Nair?",
  "tell me about Northwind Logistics",
  "what's the latest on the launch plan?",
  "what's on my calendar tomorrow?",
  "what did Marcus email me about?",
  "find the design doc and tell me what it says",
  "pull Sam's latest, summarize the pricing change, and draft an email to Lena",
  "check my calendar Friday and summarize the hiring plan",
  "email Jordan that the Q3 roadmap is approved",
  "what's our status with Cedar Foods?",
  "remind me about the onboarding flow next Monday",
  "turn the volume down",
];

let seq = 0;
const nextId = (p: string) => `${p}-${(seq++).toString(36)}`;

interface ApiToolCall {
  id?: string;
  function: { name: string; arguments: string };
}

async function chat(messages: ChatMessage[]): Promise<{ content: string; reasoning: string; tool_calls: ApiToolCall[] }> {
  // Never send our captured `reasoning` field back to the model — re-submitting a
  // teacher's harmony/think markup crashes LM Studio's template parser, and the
  // production loop re-feeds tool_calls only. Strip it from the wire messages.
  const wire = messages.map(({ reasoning: _r, ...m }) => m);
  const res = await fetch(`${URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify({ model: MODEL, messages: wire, tools: TOOLS, temperature: 0.2, max_tokens: 800 }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const m = (await res.json()).choices?.[0]?.message ?? {};
  // The 26B teacher runs with thinking ON. Separate its chain-of-thought (whether
  // returned as `reasoning_content` or inline as <think>/harmony markup) from the
  // clean answer, so the FINAL answer isn't polluted and the CoT is preserved.
  const { reasoning, content } = splitReasoning(m.content ?? "", m.reasoning_content ?? m.reasoning);
  return { content, reasoning, tool_calls: Array.isArray(m.tool_calls) ? m.tool_calls : [] };
}

/** Run one seed through a bounded tool loop; return the recorded trajectory. */
async function distillOne(user: string): Promise<TrajectoryRecord> {
  const messages: ChatMessage[] = [
    { role: "system", content: SYS },
    { role: "user", content: user },
  ];
  const toolEvents: ToolEvent[] = [];
  let final = "";
  let rounds = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    rounds = round + 1;
    const { content, reasoning, tool_calls } = await chat(messages);
    if (tool_calls.length === 0) {
      final = content.trim();
      const answer: ChatMessage = { role: "assistant", content: final };
      if (reasoning) answer.reasoning = reasoning; // preserve the teacher's CoT
      messages.push(answer);
      break;
    }
    // Re-feed only the tool_calls (mirrors the production agent loop); the captured
    // reasoning rides along on the record but is stripped before re-send (see chat()).
    const turn: ChatMessage = {
      role: "assistant",
      content: "",
      tool_calls: tool_calls.map((t) => ({
        id: t.id || nextId("call"),
        type: "function",
        function: t.function,
      })),
    };
    if (reasoning) turn.reasoning = reasoning;
    messages.push(turn);
    for (const tc of tool_calls) {
      const result = mockToolResult(tc.function.name, tc.function.arguments);
      toolEvents.push({ round, name: tc.function.name, arguments: tc.function.arguments, ok: true });
      messages.push({
        role: "tool",
        tool_call_id: tc.id || tc.function.name,
        name: tc.function.name,
        content: result,
      });
    }
  }

  return {
    schema_version: 1,
    conversation_id: nextId("conv"),
    turn_id: nextId("turn"),
    created_at: new Date().toISOString(),
    model_id: MODEL,
    task_type: "distilled",
    routed: true,
    user,
    messages,
    tool_events: toolEvents,
    tools_used: [...new Set(toolEvents.map((e) => e.name))],
    rounds,
    final_answer: final,
    rating: 1, // teacher trajectories are treated as positive (gate filters bad ones)
    source: "distilled",
  };
}

function parseArg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function main() {
  const outPath = parseArg("out", "training/data/distilled.jsonl");
  const n = Number(parseArg("n", String(SEEDS.length)));

  if (!URL || !MODEL) {
    const ok = SEEDS.every((s) => typeof s === "string" && s.length > 0);
    console.log(`lint: ${SEEDS.length} seed tasks, ${TOOLS.length} tools — ${ok ? "OK" : "FAILED"}`);
    console.log("(set LMSTUDIO_URL and MODEL to the 26B to actually distill)");
    process.exit(ok ? 0 : 1);
  }

  const seeds = SEEDS.slice(0, n);
  const records: TrajectoryRecord[] = [];
  for (const s of seeds) {
    try {
      records.push(await distillOne(s));
      console.log(`distilled: ${s}`);
    } catch (e) {
      console.error(`skip "${s}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""));
  console.log(`\nwrote ${records.length} distilled trajectories → ${outPath}`);
}

main();
