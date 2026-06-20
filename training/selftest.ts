// Offline self-test for the training pipeline's pure logic. No model, no network.
//   node --experimental-strip-types training/selftest.ts
//
// Covers: the eval scorer's pass/fail rules, the redactor, and the structural
// invariants every synthetic trajectory must hold (so a generator regression that
// produces malformed training data fails loudly here, not silently in a fine-tune).

import assert from "node:assert/strict";
import type { ChatMessage, TrajectoryRecord } from "./types.ts";
import { scoreCase, type EvalCase } from "./eval/cases.ts";
import { redactText } from "./redact.ts";

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
