// Offline self-test for the training pipeline's pure logic. No model, no network.
//   node --experimental-strip-types training/selftest.ts
//
// Covers: the eval scorer's pass/fail rules, the redactor, and the structural
// invariants every synthetic trajectory must hold (so a generator regression that
// produces malformed training data fails loudly here, not silently in a fine-tune).

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import type { ChatMessage, TrajectoryRecord } from "./types.ts";
import { scoreCase, type EvalCase } from "./eval/cases.ts";
import { redactText, redactRecord } from "./redact.ts";
import { mockToolResult } from "./mockenv.ts";
import { splitReasoning, withThink } from "./reasoning.ts";
import { dedup, jaccard, recordSignature } from "./dedup.ts";

let n = 0;
const check = (name: string, fn: () => void) => {
  fn();
  n++;
  console.log(`ok ${n} - ${name}`);
};

// --- scorer -------------------------------------------------------------------
const asst = (tool?: string, content = ""): ChatMessage =>
  tool
    ? { role: "assistant", content, tool_calls: [{ id: "x", type: "function", function: { name: tool, arguments: "{}" } }] }
    : { role: "assistant", content };

check("scorer: right first tool passes", () => {
  const c: EvalCase = { id: "a", user: "u", expectFirstTool: "brain_page" };
  assert.equal(scoreCase(c, asst("brain_page")).pass, true);
});
check("scorer: wrong first tool fails", () => {
  const c: EvalCase = { id: "a", user: "u", expectFirstTool: "brain_page" };
  assert.equal(scoreCase(c, asst("web_search")).pass, false);
});
check("scorer: forbidden tool fails (confirm-before-send)", () => {
  const c: EvalCase = { id: "a", user: "u", forbidTools: ["send_email"], expectNoToolCall: true };
  assert.equal(scoreCase(c, asst("send_email")).pass, false);
});
check("scorer: confirm question (no tool) passes", () => {
  const c: EvalCase = { id: "a", user: "u", expectNoToolCall: true, expectContentIncludes: "?" };
  assert.equal(scoreCase(c, asst(undefined, "Want me to send it?")).pass, true);
});

// --- redactor -----------------------------------------------------------------
check("redact: email", () => assert.ok(!redactText("ping bob@acme.com now").includes("bob@acme.com")));
check("redact: macOS path", () => assert.equal(redactText("at /Users/andres/x"), "at /Users/[USER]/x"));
check("redact: long token", () => assert.ok(redactText("key abcdef0123456789abcdef0123").includes("[TOKEN]")));
check("redact: leaves plain prose", () => assert.equal(redactText("summarize the roadmap"), "summarize the roadmap"));

// --- synthetic generator invariants ------------------------------------------
const { execSync } = await import("node:child_process");
execSync("node --experimental-strip-types training/synthesize.ts --out /tmp/_synth_selftest.jsonl", { stdio: "ignore" });
const recs: TrajectoryRecord[] = readJsonl("/tmp/_synth_selftest.jsonl");

check("synth: produced records", () => assert.ok(recs.length > 0));
check("synth: every record well-formed", () => {
  for (const r of recs) {
    assert.equal(r.schema_version, 1);
    assert.equal(r.source, "synthetic");
    assert.ok(r.messages[0].role === "system", "starts with system");
    assert.ok(r.messages.some((m) => m.role === "user"), "has a user turn");
    assert.equal(r.messages.at(-1)?.role, "assistant", "ends with assistant answer");
    // assistant tool-call turns must be followed by a matching tool result
    for (let i = 0; i < r.messages.length; i++) {
      const m = r.messages[i];
      if (m.role === "assistant" && m.tool_calls?.length) {
        const next = r.messages[i + 1];
        assert.equal(next?.role, "tool", `tool result follows tool call in ${r.turn_id}`);
        assert.equal(next?.tool_call_id, m.tool_calls[0].id, "tool result id matches");
      }
    }
  }
});
check("synth: decompose case calls manage_tasks first", () => {
  const dec = recs.find((r) => r.task_type === "deep");
  assert.ok(dec, "has a deep/decompose record");
  const firstAsst = dec!.messages.find((m) => m.role === "assistant" && m.tool_calls?.length);
  assert.equal(firstAsst?.tool_calls?.[0].function.name, "manage_tasks");
});

// --- mock env (teacher distillation) -----------------------------------------
check("mockenv: known tools return non-empty results", () => {
  for (const t of ["brain_page", "calendar_events", "web_search", "read_emails", "find_files"]) {
    assert.ok(mockToolResult(t, "{}").length > 0, `${t} returns a result`);
  }
});
check("mockenv: brain_page echoes the entity name", () => {
  assert.ok(mockToolResult("brain_page", JSON.stringify({ name: "Acme" })).includes("Acme"));
});
check("mockenv: side-effect tools are never really fired", () => {
  assert.ok(mockToolResult("send_email", "{}").includes("not actually sent"));
});

// --- reasoning split/fold (teacher CoT capture) ------------------------------
check("reasoning: <think> block → trace + clean answer", () => {
  const s = splitReasoning("<think>weigh the options</think>the answer");
  assert.equal(s.reasoning, "weigh the options");
  assert.equal(s.content, "the answer");
});
check("reasoning: harmony channels → final is the answer", () => {
  const s = splitReasoning("<|channel|>analysis<|message|>thinking hard<|channel|>final<|message|>done");
  assert.equal(s.reasoning, "thinking hard");
  assert.equal(s.content, "done");
});
check("reasoning: separate reasoning_content field is kept", () => {
  const s = splitReasoning("plain answer", "the hidden trace");
  assert.equal(s.reasoning, "the hidden trace");
  assert.equal(s.content, "plain answer");
});
check("reasoning: plain content passes through untouched", () => {
  const s = splitReasoning("just an answer");
  assert.equal(s.reasoning, "");
  assert.equal(s.content, "just an answer");
});
check("reasoning: withThink renders a think block (and no-ops when empty)", () => {
  assert.ok(withThink("cot", "ans").startsWith("<think>"));
  assert.ok(withThink("cot", "ans").includes("ans"));
  assert.equal(withThink("", "ans"), "ans");
});
check("redact: scrubs the reasoning trace too", () => {
  const rec = {
    schema_version: 1, conversation_id: "c", turn_id: "t", created_at: "2026-01-01T00:00:00Z",
    model_id: "m", task_type: "distilled", routed: true, user: "u",
    messages: [{ role: "assistant", content: "ok", reasoning: "email priya@acme.com to confirm" }],
    tool_events: [], tools_used: [], rounds: 1, final_answer: "ok", rating: 1, source: "distilled",
  } as TrajectoryRecord;
  const out = redactRecord(rec);
  assert.ok(!JSON.stringify(out).includes("priya@acme.com"), "email scrubbed from reasoning");
});

// --- scorer: JSON-arg validity + argument-value checks ------------------------
const callMsg = (name: string, args: string): ChatMessage => ({
  role: "assistant", content: "", tool_calls: [{ id: "x", type: "function", function: { name, arguments: args } }],
});
check("scorer: malformed JSON tool args fail", () => {
  const c: EvalCase = { id: "a", user: "u", expectFirstTool: "brain_page" };
  assert.equal(scoreCase(c, callMsg("brain_page", "{bad")).pass, false);
});
check("scorer: expectArgsInclude checks the argument VALUE", () => {
  const c: EvalCase = { id: "a", user: "u", expectFirstTool: "brain_page", expectArgsInclude: "Jordan" };
  assert.equal(scoreCase(c, callMsg("brain_page", '{"name":"Jordan"}')).pass, true);
  assert.equal(scoreCase(c, callMsg("brain_page", '{"name":"Sam"}')).pass, false);
});

// --- exporter: reasoning fold (opt-in) + gold filtering -----------------------
const exTmp = "/tmp/_export_selftest";
execSync(`rm -rf ${exTmp} && mkdir -p ${exTmp}`, { stdio: "ignore" });
const goldRec: TrajectoryRecord = {
  schema_version: 1, conversation_id: "c1", turn_id: "tGold", created_at: "2026-01-01T00:00:00Z",
  model_id: "teacher", task_type: "distilled", routed: true, user: "who is Jordan?",
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "who is Jordan?" },
    { role: "assistant", content: "", tool_calls: [{ id: "x", type: "function", function: { name: "brain_page", arguments: '{"name":"Jordan"}' } }], reasoning: "look up the page first" },
    { role: "tool", tool_call_id: "x", name: "brain_page", content: "Jordan — VP Ops" },
    { role: "assistant", content: "Jordan is VP Ops.", reasoning: "summarize the page" },
  ],
  tool_events: [{ round: 0, name: "brain_page", arguments: '{"name":"Jordan"}', ok: true }],
  tools_used: ["brain_page"], rounds: 1, final_answer: "Jordan is VP Ops.", rating: 1, source: "distilled",
};
const badArgsRec: TrajectoryRecord = {
  ...goldRec, turn_id: "tBad",
  messages: [
    { role: "system", content: "sys" }, { role: "user", content: "x" },
    { role: "assistant", content: "done" },
  ],
  tool_events: [{ round: 0, name: "brain_page", arguments: "{bad", ok: true }],
};
writeFileSync(`${exTmp}/distilled.jsonl`, [JSON.stringify(goldRec), JSON.stringify(badArgsRec)].join("\n") + "\n");
const runExport = (reasoning: string) => {
  const out = `${exTmp}/out_${reasoning}`;
  execSync(
    `node --experimental-strip-types training/export.ts --live ${exTmp}/nolive --synth ${exTmp}/nosynth.jsonl --distill ${exTmp}/distilled.jsonl --out ${out} --mode sft --reasoning ${reasoning}`,
    { stdio: "ignore" }
  );
  const raw = readFileSync(`${out}/train.jsonl`, "utf8") + readFileSync(`${out}/valid.jsonl`, "utf8");
  return { raw, rows: raw.split("\n").filter((l) => l.trim()) };
};
check("export: --reasoning all folds <think>; bad-args record dropped by gold filter", () => {
  const all = runExport("all");
  assert.equal(all.rows.length, 1, "only the gold record survives (malformed-args record dropped)");
  assert.ok(all.raw.includes("<think>"), "reasoning folded into the answer");
  assert.ok(!all.raw.includes('"reasoning"'), "no raw reasoning field leaks into the export");
});
check("export: --reasoning none (default) withholds reasoning", () => {
  const none = runExport("none");
  assert.equal(none.rows.length, 1);
  assert.ok(!none.raw.includes("<think>"), "no think block by default");
  assert.ok(!none.raw.includes('"reasoning"'), "no raw reasoning field by default");
});

// --- corpus dedup (model-collapse guard) -------------------------------------
check("dedup: jaccard identical=1, disjoint=0", () => {
  assert.equal(jaccard(new Set(["a b c"]), new Set(["a b c"])), 1);
  assert.equal(jaccard(new Set(["a b c"]), new Set(["x y z"])), 0);
});
check("dedup: exact drops identical signatures, keeps distinct", () => {
  const sig = (s: string) => recordSignature(s, ["brain_page"], "answer");
  const items = ["who is Jordan?", "who is Jordan?", "who is Sam?"];
  const r = dedup(items, sig, "exact");
  assert.equal(r.kept.length, 2);
  assert.equal(r.removed, 1);
});
check("dedup: near drops high-overlap, off keeps everything", () => {
  const a = "pull Jordan's latest and summarize the Q3 roadmap for the team";
  const b = "pull Jordan's latest and summarize the Q3 roadmap for the group"; // ~1 token diff
  const c = "turn the volume down";
  const sig = (s: string) => s;
  assert.equal(dedup([a, b, c], sig, "near", 0.8).kept.length, 2, "near collapses a≈b");
  assert.equal(dedup([a, b, c], sig, "off").kept.length, 3, "off keeps all");
});
check("export: duplicate trajectory dropped by default; --dedup off keeps both", () => {
  const ded = "/tmp/_dedup_selftest";
  execSync(`rm -rf ${ded} && mkdir -p ${ded}`, { stdio: "ignore" });
  const dup: TrajectoryRecord = { ...goldRec, turn_id: "tDup" }; // same signature as goldRec
  writeFileSync(`${ded}/distilled.jsonl`, [JSON.stringify(goldRec), JSON.stringify(dup)].join("\n") + "\n");
  const run = (dedupArg: string) => {
    const out = `${ded}/out_${dedupArg}`;
    execSync(
      `node --experimental-strip-types training/export.ts --live ${ded}/nolive --synth ${ded}/nosynth.jsonl --distill ${ded}/distilled.jsonl --out ${out} --mode sft --dedup ${dedupArg}`,
      { stdio: "ignore" }
    );
    const raw = readFileSync(`${out}/train.jsonl`, "utf8") + readFileSync(`${out}/valid.jsonl`, "utf8");
    return raw.split("\n").filter((l) => l.trim()).length;
  };
  assert.equal(run("exact"), 1, "exact dedup removes the duplicate");
  assert.equal(run("off"), 2, "off keeps the duplicate");
});

console.log(`\n1..${n}\nall ${n} checks passed`);

function readJsonl(p: string): TrajectoryRecord[] {
  return require_fs()
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l: string) => l.trim())
    .map((l: string) => JSON.parse(l));
}
function require_fs() {
  return globalThis.process.getBuiltinModule("node:fs");
}
