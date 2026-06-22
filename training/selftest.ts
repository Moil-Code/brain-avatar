// Offline self-test for the training pipeline's pure logic. No model, no network.
//   node --experimental-strip-types training/selftest.ts
//
// Covers: the eval scorer's pass/fail rules, the redactor, and the structural
// invariants every synthetic trajectory must hold (so a generator regression that
// produces malformed training data fails loudly here, not silently in a fine-tune).

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import type { ChatMessage, TrajectoryRecord } from "./types.ts";
import { scoreCase, scoreMultiTurn, type EvalCase, type MultiTurnCase } from "./eval/cases.ts";
import { redactText, redactRecord } from "./redact.ts";
import { mockToolResult } from "./mockenv.ts";
import { splitReasoning, withThink } from "./reasoning.ts";
import { dedup, jaccard, recordSignature } from "./dedup.ts";
import { ktoWeights } from "./kto.ts";
import { looksLikeCorrection, correctedTurnIds, firedUnconfirmedSend } from "./outcomes.ts";

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

// --- eval: irrelevance/refusal + multi-tool acceptance -----------------------
check("scorer: irrelevance — tool call on smalltalk fails, direct answer passes", () => {
  const c: EvalCase = { id: "s", user: "good morning!", expectNoToolCall: true };
  assert.equal(scoreCase(c, callMsg("brain_search", "{}")).pass, false);
  assert.equal(scoreCase(c, asst(undefined, "Morning!")).pass, true);
});
check("scorer: expectOneOfFirstTool accepts any listed tool", () => {
  const c: EvalCase = { id: "c", user: "u", expectOneOfFirstTool: ["brain_search", "brain_page"] };
  assert.equal(scoreCase(c, callMsg("brain_page", "{}")).pass, true);
  assert.equal(scoreCase(c, callMsg("web_search", "{}")).pass, false);
});
check("synth: chitchat records make no tool call", () => {
  const chit = recs.filter((r) => r.task_type === "trivial_chat");
  assert.ok(chit.length > 0, "has chitchat records");
  for (const r of chit) assert.equal(r.tool_events.length, 0, "no tools on smalltalk");
});

// --- exporter: tool schemas attached to SFT examples (G2) ---------------------
check("export: tool schemas attached by default; --tools off omits them", () => {
  const td = "/tmp/_tools_selftest";
  execSync(`rm -rf ${td} && mkdir -p ${td}`, { stdio: "ignore" });
  writeFileSync(`${td}/distilled.jsonl`, JSON.stringify(goldRec) + "\n");
  const run = (toolsArg: string) => {
    const out = `${td}/out_${toolsArg}`;
    execSync(
      `node --experimental-strip-types training/export.ts --live ${td}/nolive --synth ${td}/nosynth.jsonl --distill ${td}/distilled.jsonl --out ${out} --mode sft --tools ${toolsArg}`,
      { stdio: "ignore" }
    );
    return readFileSync(`${out}/train.jsonl`, "utf8") + readFileSync(`${out}/valid.jsonl`, "utf8");
  };
  const on = run("on");
  assert.ok(on.includes('"tools"') && on.includes("brain_page") && on.includes("parameters"), "tools schema present by default");
  assert.ok(!run("off").includes('"tools"'), "tools omitted with --tools off");
});

// --- KTO class weighting (sycophancy/imbalance guard) ------------------------
check("kto weights: balanced classes stay 1:1", () => {
  const w = ktoWeights(10, 10);
  assert.equal(w.desirable_weight, 1);
  assert.equal(w.undesirable_weight, 1);
  assert.equal(w.ratio, 1);
});
check("kto weights: rarer thumbs-down gets up-weighted to balance", () => {
  const w = ktoWeights(90, 10);
  assert.equal(w.desirable_weight, 1);
  assert.ok(w.undesirable_weight > 1, "undesirables up-weighted");
  assert.equal(w.ratio, 1, "balanced after weighting");
});
check("kto weights: one-class corpus is flagged, not silently balanced", () => {
  const w = ktoWeights(5, 0);
  assert.ok(w.note && /one preference class/.test(w.note));
});
check("export kto: writes balancing weights + guard config", () => {
  const kt = "/tmp/_kto_selftest";
  execSync(`rm -rf ${kt} && mkdir -p ${kt}`, { stdio: "ignore" });
  const neg: TrajectoryRecord = {
    ...goldRec, turn_id: "tNeg", user: "who is Sam?", rating: -1, tool_events: [], tools_used: [],
    final_answer: "Sam is in sales.",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "who is Sam?" },
      { role: "assistant", content: "Sam is in sales." },
    ],
  };
  writeFileSync(`${kt}/distilled.jsonl`, [JSON.stringify(goldRec), JSON.stringify(neg)].join("\n") + "\n");
  execSync(
    `node --experimental-strip-types training/export.ts --live ${kt}/nolive --synth ${kt}/nosynth.jsonl --distill ${kt}/distilled.jsonl --out ${kt}/out --mode kto`,
    { stdio: "ignore" }
  );
  const cfg = JSON.parse(readFileSync(`${kt}/out/kto_config.json`, "utf8"));
  assert.equal(cfg.n_pos, 1, "one thumbs-up");
  assert.equal(cfg.n_neg, 1, "one thumbs-down");
  assert.ok(typeof cfg.guard === "string" && cfg.guard.length > 0, "guard note present");
});

// --- derived outcome labels: next-turn correction (G7) -----------------------
check("outcomes: correction phrases detected, normal asks not", () => {
  assert.ok(looksLikeCorrection("no, that's wrong"));
  assert.ok(looksLikeCorrection("actually I meant Sam"));
  assert.ok(!looksLikeCorrection("what's on my calendar?"));
  assert.ok(!looksLikeCorrection("notify me about the launch")); // 'no' must be a word boundary
});
check("outcomes: a turn corrected on the next turn is flagged", () => {
  const seq = [
    { ...goldRec, conversation_id: "cc", turn_id: "t1", created_at: "2026-01-01T00:00:00Z", user: "who is Jordan?" },
    { ...goldRec, conversation_id: "cc", turn_id: "t2", created_at: "2026-01-01T00:01:00Z", user: "no, that's wrong" },
  ] as TrajectoryRecord[];
  const s = correctedTurnIds(seq);
  assert.ok(s.has("t1"), "t1 corrected by t2");
  assert.ok(!s.has("t2"), "t2 not corrected (no following turn)");
});
check("export sft: drops a turn the user corrected next turn", () => {
  const oc = "/tmp/_outcomes_selftest";
  execSync(`rm -rf ${oc} && mkdir -p ${oc}`, { stdio: "ignore" });
  const t1 = { ...goldRec, conversation_id: "cc", turn_id: "t1", created_at: "2026-01-01T00:00:00Z", user: "who is Jordan?" };
  const t2: TrajectoryRecord = {
    ...goldRec, conversation_id: "cc", turn_id: "t2", created_at: "2026-01-01T00:01:00Z",
    user: "no, that's wrong", tool_events: [], tools_used: [], final_answer: "Sorry — let me fix that.",
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "no, that's wrong" },
      { role: "assistant", content: "Sorry — let me fix that." },
    ],
  };
  writeFileSync(`${oc}/distilled.jsonl`, [JSON.stringify(t1), JSON.stringify(t2)].join("\n") + "\n");
  execSync(
    `node --experimental-strip-types training/export.ts --live ${oc}/nolive --synth ${oc}/nosynth.jsonl --distill ${oc}/distilled.jsonl --out ${oc}/out --mode sft --dedup off`,
    { stdio: "ignore" }
  );
  const raw = readFileSync(`${oc}/out/train.jsonl`, "utf8") + readFileSync(`${oc}/out/valid.jsonl`, "utf8");
  assert.equal(raw.split("\n").filter((l) => l.trim()).length, 1, "corrected t1 dropped, t2 kept");
});

// --- multi-turn eval scorer (confirm→send flow) ------------------------------
check("scorer: multi-turn passes only when EVERY turn passes", () => {
  const c: MultiTurnCase = {
    id: "mt",
    turns: [
      { user: "email Marcus the plan is approved", forbidTools: ["send_email"], expectNoToolCall: true, expectContentIncludes: "?" },
      { user: "yes, send it", expectFirstTool: "send_email" },
    ],
  };
  const good = [asst(undefined, "Want me to send it?"), callMsg("send_email", "{}")];
  const sentEarly = [callMsg("send_email", "{}"), callMsg("send_email", "{}")];
  assert.equal(scoreMultiTurn(c, good).pass, true);
  assert.equal(scoreMultiTurn(c, sentEarly).pass, false, "sending on turn 1 fails the case");
});

// --- confirm-before-send safety filter (G7) ----------------------------------
check("safety: unconfirmed send flagged; confirmed send / non-send are fine", () => {
  const mk = (name: string, args: string) =>
    ({ ...goldRec, tool_events: [{ round: 0, name, arguments: args, ok: true }] }) as TrajectoryRecord;
  assert.equal(firedUnconfirmedSend(mk("send_email", '{"to":"x","body":"y"}')), true);
  assert.equal(firedUnconfirmedSend(mk("send_email", '{"to":"x","body":"y","confirm":true}')), false);
  assert.equal(firedUnconfirmedSend(mk("brain_page", '{"name":"X"}')), false);
});
check("export sft: drops a turn that sent without confirmation", () => {
  const sf = "/tmp/_safety_selftest";
  execSync(`rm -rf ${sf} && mkdir -p ${sf}`, { stdio: "ignore" });
  const unsafe: TrajectoryRecord = {
    ...goldRec, turn_id: "tUnsafe", user: "email Sam", final_answer: "Sent.",
    tool_events: [{ round: 0, name: "send_email", arguments: '{"to":"Sam","body":"hi"}', ok: true }],
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "email Sam" },
      { role: "assistant", content: "", tool_calls: [{ id: "x", type: "function", function: { name: "send_email", arguments: '{"to":"Sam","body":"hi"}' } }] },
      { role: "tool", tool_call_id: "x", name: "send_email", content: "ok" },
      { role: "assistant", content: "Sent." },
    ],
  };
  writeFileSync(`${sf}/distilled.jsonl`, [JSON.stringify(goldRec), JSON.stringify(unsafe)].join("\n") + "\n");
  execSync(
    `node --experimental-strip-types training/export.ts --live ${sf}/nolive --synth ${sf}/nosynth.jsonl --distill ${sf}/distilled.jsonl --out ${sf}/out --mode sft --dedup off`,
    { stdio: "ignore" }
  );
  const raw = readFileSync(`${sf}/out/train.jsonl`, "utf8") + readFileSync(`${sf}/out/valid.jsonl`, "utf8");
  assert.equal(raw.split("\n").filter((l) => l.trim()).length, 1, "unconfirmed send dropped, gold kept");
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
