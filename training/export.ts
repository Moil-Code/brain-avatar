// Exporter: trajectory corpus → MLX-LM training files.
//
// Fuses LIVE captures (<app_config_dir>/trajectories/*.jsonl) with SYNTHETIC
// records, redacts, normalizes the system message so every example shares the
// canonical prompt, filters per training mode, and writes train/valid splits.
//
//   SFT  — gold supervised set: keep only clean trajectories (all tool calls ok,
//          not thumbed-down). Emits {messages} per MLX-LM chat format.
//   KTO  — unpaired preference set from thumbs: keep rated turns. Emits
//          {prompt, completion, label} (label = thumbs-up), the shape KTO expects.
//
// Deterministic split (hash of turn_id) so re-runs are stable. No model, no network.
//
// Run:
//   node --experimental-strip-types training/export.ts \
//     [--live DIR] [--synth FILE] [--out DIR] [--mode sft|kto] \
//     [--valid-ratio 0.1] [--max-synth-ratio 0.6]

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, MlxExample, TrajectoryRecord } from "./types.ts";
import { redactRecord } from "./redact.ts";
import { withThink } from "./reasoning.ts";
import { dedup, recordSignature, type DedupMode } from "./dedup.ts";
import { TOOL_DEFS } from "./tool_defs.ts";
import { ktoWeights, KTO_GUARD } from "./kto.ts";
import { correctedTurnIds, firedUnconfirmedSend } from "./outcomes.ts";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const DEFAULT_LIVE = join(
  homedir(),
  "Library",
  "Application Support",
  "com.moil.brainavatar",
  "trajectories"
);
const liveDir = arg("live", DEFAULT_LIVE);
const synthFile = arg("synth", "training/data/synthetic.jsonl");
const distillFile = arg("distill", "training/data/distilled.jsonl");
const outDir = arg("out", "training/data/export");
const mode = arg("mode", "sft");
const validRatio = Number(arg("valid-ratio", "0.1"));
const maxSynthRatio = Number(arg("max-synth-ratio", "0.6"));
// Whether to fold captured reasoning back into the assistant answer as a <think>
// block (reasoning-distillation SFT). Default OFF: the gemma-4-12b target (dense Gemma)
// runs with thinking DISABLED, so its SFT data should stay reasoning-free to keep
// train/inference consistent. Opt in when fine-tuning a thinking-capable target.
//   none      — never emit reasoning (default; current behavior preserved)
//   distilled — only from teacher-distilled trajectories (where CoT is high quality)
//   all       — wherever a reasoning trace was captured
const reasoningMode = arg("reasoning", "none");
// De-duplicate the corpus before training. `exact` (default) drops identical
// signatures — always safe and protects the growing live corpus; `near` also drops
// high-overlap (Jaccard ≥ threshold) trajectories; `off` keeps everything.
const dedupMode = arg("dedup", "exact") as DedupMode;
const dedupThreshold = Number(arg("dedup-threshold", "0.9"));
// Attach the tool schemas to each SFT example (MLX-LM/HF tools format). Default ON:
// fine-tuning a tool-caller without the signatures hurts generalization to the tools.
// `--tools off` reverts to messages-only. (KTO keeps its {prompt,completion,label} shape.)
const withTools = arg("tools", "on") !== "off";
// Optional denylist of real names to scrub from live data (one per line). Default: none
// (structured-PII redaction still always runs). Full contextual NER → Presidio (see audit).
const namesFile = arg("redact-names", "");
const redactNames =
  namesFile && existsSync(namesFile)
    ? readFileSync(namesFile, "utf8").split("\n").map((s) => s.trim()).filter(Boolean)
    : [];

// --- load ---------------------------------------------------------------------
function loadJsonl(path: string): TrajectoryRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TrajectoryRecord);
}

function loadLive(dir: string): TrajectoryRecord[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => loadJsonl(join(dir, f)));
}

// Canonical system prompt: every example is normalized to this so training matches
// inference. Falls back to each record's own system message when the file is absent.
function canonicalSystem(): string | null {
  const p = "training/system_prompt.txt";
  return existsSync(p) ? readFileSync(p, "utf8").trim() : null;
}

// --- transforms ---------------------------------------------------------------
function normalizeSystem(msgs: ChatMessage[], sys: string | null): ChatMessage[] {
  if (!sys) return msgs;
  const rest = msgs.filter((m) => m.role !== "system");
  return [{ role: "system", content: sys }, ...rest];
}

/** Tool arguments must be valid JSON to be usable (empty = no-arg call is fine). */
function argsOk(s: string): boolean {
  if (!s || !s.trim()) return true;
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

/** SFT: a trajectory is gold only if every tool call executed with PARSEABLE JSON args,
 *  no confirm-required tool fired without confirmation, and the user didn't thumb it
 *  down. (rating null = unrated = kept; rating 1 = kept; rating -1 = dropped.) These are
 *  cheap outcome labels — a turn with malformed args or an unconfirmed send is never a
 *  clean example to imitate. */
function isGold(r: TrajectoryRecord): boolean {
  return r.tool_events.every((e) => e.ok && argsOk(e.arguments)) && !firedUnconfirmedSend(r) && r.rating !== -1;
}

/** Fold (or drop) per-message reasoning per the export mode. The captured trace is
 *  never emitted as a raw field — either it becomes a <think> block in the answer
 *  (reasoning SFT) or it's stripped, so MLX-LM only ever sees standard chat fields. */
function applyReasoning(msgs: ChatMessage[], source: string): ChatMessage[] {
  const include =
    reasoningMode === "all" || (reasoningMode === "distilled" && source === "distilled");
  return msgs.map((m) => {
    const { reasoning, ...rest } = m;
    if (m.role === "assistant" && include && reasoning && reasoning.trim()) {
      return { ...rest, content: withThink(reasoning, m.content ?? "") };
    }
    return rest;
  });
}

function toSft(r: TrajectoryRecord, sys: string | null): MlxExample {
  const ex: MlxExample = { messages: normalizeSystem(applyReasoning(r.messages, r.source), sys) };
  if (withTools) ex.tools = TOOL_DEFS;
  return ex;
}

/** KTO: prompt = everything before the final assistant turn; completion = that
 *  turn; label = thumbs-up. Only rated turns carry a usable preference signal. */
function toKto(r: TrajectoryRecord, sys: string | null) {
  const msgs = normalizeSystem(applyReasoning(r.messages, r.source), sys);
  const lastAssistant = [...msgs].reverse().findIndex((m) => m.role === "assistant" && !m.tool_calls);
  if (lastAssistant < 0) return null;
  const cut = msgs.length - 1 - lastAssistant;
  return {
    prompt: msgs.slice(0, cut),
    completion: [msgs[cut]],
    label: r.rating === 1,
  };
}

// Deterministic [0,1) from a string — stable train/valid assignment across runs.
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

// --- build corpus -------------------------------------------------------------
const sys = canonicalSystem();
const live = loadLive(liveDir).map((r) => redactRecord(r, redactNames));
const distilled = loadJsonl(distillFile).map((r) => redactRecord(r, redactNames));
let synth = loadJsonl(synthFile).map((r) => redactRecord(r, redactNames));

// Cap the GENERATED share (synthetic + distilled) so the fine-tune doesn't drift
// onto templated/teacher phrasing once real data exists. Early on (no live data)
// this is a no-op and the corpus is generated-only.
const generatedCount = synth.length + distilled.length;
if (live.length > 0 && generatedCount > 0) {
  const maxGen = Math.floor((maxSynthRatio / (1 - maxSynthRatio)) * live.length);
  // Trim synthetic first (distilled is the scarcer, higher-value generated source).
  const overflow = generatedCount - maxGen;
  if (overflow > 0) synth = synth.slice(0, Math.max(0, synth.length - overflow));
}

const corpus = [...live, ...distilled, ...synth];
// Derived negative label: a turn the user corrected on the next turn isn't gold to imitate.
const corrected = correctedTurnIds(corpus);
const filtered =
  mode === "kto"
    ? corpus.filter((r) => r.rating !== null)
    : corpus.filter((r) => isGold(r) && !corrected.has(r.turn_id));

// Drop duplicate trajectories (by user + tool sequence + final answer) before split.
const { kept, removed: dropped } = dedup(
  filtered,
  (r) => recordSignature(r.user, r.tool_events.map((e) => e.name), r.final_answer),
  dedupMode,
  dedupThreshold
);

const train: unknown[] = [];
const valid: unknown[] = [];
for (const r of kept) {
  const ex = mode === "kto" ? toKto(r, sys) : toSft(r, sys);
  if (!ex) continue;
  (hash01(r.turn_id) < validRatio ? valid : train).push(ex);
}

mkdirSync(outDir, { recursive: true });
const write = (name: string, rows: unknown[]) =>
  writeFileSync(join(outDir, name), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
write("train.jsonl", train);
write("valid.jsonl", valid);

// How many emitted examples carry a folded-in <think> reasoning block.
const withReasoning = [...train, ...valid].filter((r) =>
  JSON.stringify(r).includes("<think>")
).length;

console.log(`mode=${mode}  live=${live.length}  distilled=${distilled.length}  synthetic=${synth.length}  kept=${kept.length}`);
console.log(`→ ${join(outDir, "train.jsonl")}  (${train.length} train, ${valid.length} valid)`);
console.log(`dedup=${dedupMode}  removed=${dropped}  ·  reasoning=${reasoningMode}  examples-with-<think>=${withReasoning}  ·  tools=${withTools ? "on" : "off"}  ·  corrected-turns=${corrected.size}`);

// KTO: emit balancing weights + the anti-sycophancy guardrail for the Mac-side run.
if (mode === "kto") {
  const labels = [...train, ...valid].map((r) => (r as { label?: boolean }).label);
  const nPos = labels.filter((l) => l === true).length;
  const nNeg = labels.filter((l) => l === false).length;
  const cfg = { ...ktoWeights(nPos, nNeg), guard: KTO_GUARD };
  writeFileSync(join(outDir, "kto_config.json"), JSON.stringify(cfg, null, 2) + "\n");
  console.log(
    `kto weights: desirable=${cfg.desirable_weight} undesirable=${cfg.undesirable_weight} ` +
      `(n_pos=${nPos}, n_neg=${nNeg}, ratio=${cfg.ratio})${cfg.note ? ` — ${cfg.note}` : ""}`
  );
}
if (!sys) console.log("note: training/system_prompt.txt absent — kept each record's own system message.");
if (live.length === 0) console.log(`note: no live data at ${liveDir} — corpus is synthetic-only for now.`);
