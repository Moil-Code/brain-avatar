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
const outDir = arg("out", "training/data/export");
const mode = arg("mode", "sft");
const validRatio = Number(arg("valid-ratio", "0.1"));
const maxSynthRatio = Number(arg("max-synth-ratio", "0.6"));

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

/** SFT: a trajectory is gold only if every tool call executed and the user didn't
 *  thumb it down. (rating null = unrated = kept; rating 1 = kept; rating -1 = dropped.) */
function isGold(r: TrajectoryRecord): boolean {
  return r.tool_events.every((e) => e.ok) && r.rating !== -1;
}

function toSft(r: TrajectoryRecord, sys: string | null): MlxExample {
  return { messages: normalizeSystem(r.messages, sys) };
}

/** KTO: prompt = everything before the final assistant turn; completion = that
 *  turn; label = thumbs-up. Only rated turns carry a usable preference signal. */
function toKto(r: TrajectoryRecord, sys: string | null) {
  const msgs = normalizeSystem(r.messages, sys);
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
const live = loadLive(liveDir).map(redactRecord);
let synth = loadJsonl(synthFile).map(redactRecord);

// Cap synthetic share so the fine-tune doesn't drift onto templated phrasing once
// real data exists. Early on (no live data) this is a no-op and it's all synthetic.
if (live.length > 0 && synth.length > 0) {
  const maxSynth = Math.floor((maxSynthRatio / (1 - maxSynthRatio)) * live.length);
  if (synth.length > maxSynth) synth = synth.slice(0, maxSynth);
}

const corpus = [...live, ...synth];
const kept = mode === "kto" ? corpus.filter((r) => r.rating !== null) : corpus.filter(isGold);

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

console.log(`mode=${mode}  live=${live.length}  synthetic=${synth.length}  kept=${kept.length}`);
console.log(`→ ${join(outDir, "train.jsonl")}  (${train.length} train, ${valid.length} valid)`);
if (!sys) console.log("note: training/system_prompt.txt absent — kept each record's own system message.");
if (live.length === 0) console.log(`note: no live data at ${liveDir} — corpus is synthetic-only for now.`);
