# Training Capabilities — Audit, Research & Plan

_Authored: 2026-06-22. Scope: a full audit of what our local-model **training**
pipeline can and cannot do today, what 2025–2026 best practice says we **should**
be doing, the gaps between the two, and a prioritized plan. Companion to
[`LOCAL_MODEL_TRAINING_PLAN.md`](./LOCAL_MODEL_TRAINING_PLAN.md) (the strategy) —
this doc is the **capability inventory + gap closure**._

---

## 0. The triggering question — "do we track how the model *thinks*?"

**Short answer: no — and that was the single highest-value gap, now partly closed.**

The model's reasoning / chain-of-thought ("thinking") was discarded at every layer,
and was **not** part of any training data:

| Layer | What happens to reasoning | Where |
|---|---|---|
| Generation (fast tier) | Thinking **disabled** (`enable_thinking:false`) for qwen3-8b / Gemma fast tiers | `src-tauri/src/llm.rs` |
| Answer cleanup | `<think>` / harmony `<\|channel\|>` markup **stripped** before the answer is shown/spoken | `llm.rs::strip_reasoning` |
| Agent loop | Re-feeds **only** `tool_calls` with `content:""` — reasoning never re-enters the loop | `src/lib/agent.ts` |
| Trajectory schema | **No reasoning field** — capture stores messages/tool calls/answer/rating only | `src-tauri/src/trajectory.rs`, `training/types.ts` |
| Teacher distillation | The 26B's reasoning was **thrown away**, and (bug) its raw `<think>` markup could **leak into the distilled final answer** | `training/distill.ts` |

Stripping at **inference** on the fast tier is correct (it's a deliberate latency
choice and prevents LM Studio template-parser crashes). The miss was at **capture**:
the one place CoT is most valuable — **teacher distillation** — was discarding it.
This pass fixes that (see §5).

---

## 1. Audit — what the training pipeline has today

A genuinely capable, well-structured **on-device** pipeline already exists (all local,
no cloud, MLX-LM target). Inventory:

| Capability | Status | File(s) |
|---|---|---|
| Live trajectory capture (messages, tool calls, args, success, route, rating, note) | ✅ | `src-tauri/src/trajectory.rs`, `src/App.tsx`, `src/components/ChatPanel.tsx` |
| Shared schema (Rust ↔ TS mirror, `schema_version 1`) | ✅ | `trajectory.rs`, `training/types.ts` |
| Synthetic gold generator (135 trajectories, 13 scenarios × entity pool × phrasings) | ✅ | `training/synthesize.ts` |
| Teacher distillation (26B → mock-tool trajectories) | ✅ | `training/distill.ts`, `training/mockenv.ts` |
| Deterministic PII redaction (structured identifiers) | ✅ | `training/redact.ts` |
| Exporter → MLX-LM `sft`/`kto` JSONL, system normalization, synth-ratio cap, stable split | ✅ | `training/export.ts` |
| Frozen eval suite + pure scorer; threshold gate; offline lint | ✅ | `training/eval/cases.ts`, `training/eval/run.ts` |
| Offline self-test (scorer, redactor, generator invariants) | ✅ | `training/selftest.ts` |
| End-to-end train script (venv → `mlx_lm.lora` → `fuse` → eval gate) | ✅ | `training/train.sh` |
| In-app Training tracker + notify-when-ready | ✅ | `trajectory.rs` (`trajectory_stats`, `training_readiness`) |

**Verdict:** the *plumbing* is in good shape. The gaps are in **data richness**
(reasoning, tool schemas, outcome labels), **eval depth**, and **redaction strength**.

---

## 2. Research — what 2025–2026 best practice says we should do

Findings below are from primary sources (papers / official docs), verified live.

1. **Reasoning/CoT distillation is the biggest small-model lever.** Training on a
   teacher's *rationales*, not just labels, let a 770M model beat a 540B one on less
   data (*Distilling Step-by-Step*, [2305.02301](https://arxiv.org/abs/2305.02301)).
   SFT-distillation of reasoning traces into small models is how
   [DeepSeek-R1](https://arxiv.org/abs/2501.12948) and
   [s1](https://arxiv.org/abs/2501.19393) work — and **trace quality/curation beats
   volume** (s1: 1k curated traces). → **Capture the 26B teacher's reasoning.**

2. **Reasoning at inference vs training.** Capturing reasoning is worth it even when
   the fast tier runs `enable_thinking:false`, but be deliberate: the documented harm
   is SFT-ing a *thinking* model onto *short* answers (it collapses reasoning). Qwen3's
   official guidance: **don't carry `<think>` blocks across turns** — history should
   hold the final answer only ([Qwen3](https://qwenlm.github.io/blog/qwen3/)). →
   **Default: don't fold reasoning into fast-tier SFT; keep capture + re-feed only the
   answer.** (Exactly what we now do.)

3. **Tool schemas belong in training data.** MLX-LM and HF both define a `tools` array
   alongside `messages`; omitting it trades away generalization to unseen tools.
   ([MLX-LM LORA.md](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/LORA.md),
   [HF chat_extras](https://huggingface.co/docs/transformers/chat_extras)). → **Attach
   `tools` to exported examples** (match `arguments` encoding to the base model).

4. **Self-distillation / model collapse is real.** Recursively training on a model's
   own (or a sibling's) synthetic output degrades the distribution
   ([Nature 2024](https://www.nature.com/articles/s41586-024-07566-y)). Mitigations:
   **accumulate real + synthetic** rather than replace, **cap the synthetic ratio**,
   distill from a **stronger** teacher, and **dedup** near-duplicates (SemDeDup,
   [2303.09540](https://arxiv.org/abs/2303.09540)). → We already cap the synth ratio
   and use a larger teacher; **add semantic dedup**.

5. **KTO is right for our thumbs data**, but guard it. Unpaired binary feedback maps to
   KTO, not DPO ([2402.01306](https://arxiv.org/abs/2402.01306)). Weight classes to
   land 1:1–4:3 desirable:undesirable; guard against **sycophancy /
   over-optimization** ([2310.13548](https://arxiv.org/abs/2310.13548)) with an SFT
   anchor and held-out truthfulness checks. → **Add class weighting + an SFT-anchored
   KTO pass.**

6. **Eval must go beyond "right first tool."** Mirror BFCL (AST match: function +
   *argument values* + types; plus an **irrelevance/refusal** category) and τ-bench
   (multi-turn, state-based, `pass^k` reliability)
   ([BFCL](https://gorilla.cs.berkeley.edu/blogs/8_berkeley_function_calling_leaderboard.html),
   [τ-bench 2406.12045](https://arxiv.org/abs/2406.12045)). → **Add JSON-validity,
   argument-value, refusal, and multi-turn checks.**

7. **Regex redaction is not enough.** Names/contextual PII need NER; the on-device
   standard is **Microsoft Presidio** (regex + spaCy NER, fully local). Models
   demonstrably memorize and regurgitate PII
   ([Carlini 2012.07805](https://arxiv.org/abs/2012.07805)). → **Add an NER pass**
   before any row becomes training data.

---

## 3. Gap analysis (prioritized)

| # | Gap | Severity | Effort | Best-practice ref |
|---|---|---|---|---|
| G1 | **Teacher reasoning discarded** (and `<think>` could leak into distilled answers) | 🔴 high | low | §2.1, §2.2 |
| G2 | **Tool schemas omitted** from exported examples | 🟠 med | low | §2.3 |
| G3 | **Eval shallow** — first-tool only; no JSON-validity / arg-value / refusal / multi-turn | 🟠 med | med | §2.6 |
| G4 | **Redaction structured-only** — no NER name redaction | 🟠 med (privacy) | med | §2.7 |
| G5 | **No semantic dedup** — templated synthetic phrasings risk redundancy/collapse | 🟡 low | med | §2.4 |
| G6 | **KTO unguarded** — no class weighting / sycophancy guard | 🟡 low | low | §2.5 |
| G7 | **No derived outcome labels** beyond `ok` (next-turn correction, confirm-honored) | 🟡 low | med | plan §0.2 |
| G8 | **No implicit preference signals** (re-ask = weak negative, etc.) | 🟡 low | med | plan §0.3 |

---

## 4. Plan — phased

**Phase A — data richness (no GPU).** G1 ✅ (this pass), G2, G5, G7.
**Phase B — eval depth (no GPU).** G3 ✅ partial (this pass), then refusal + multi-turn + a BFCL-style AST scorer.
**Phase C — privacy (no GPU).** G4: add an on-device NER pass (Presidio or a local model) at export.
**Phase D — train + align (Mac Mini GPU).** First LoRA SFT of the fast tier through the hardened gate; then guarded KTO (G6) with class weighting.
**Phase E — operationalize.** Nightly export shard + regression scoring; periodic versioned-adapter retrains with one-click rollback.

Ordering principle (unchanged from the strategy doc): **instrument and measure before
you train.** No adapter ships that regresses tool-call success, argument validity, or
the no-narration / confirm-before-send behaviors.

---

## 5. What this pass executed (2026-06-22)

Closed **G1** end-to-end, plus down-payments on **G3** and **G7** — all offline,
fully tested, zero GPU:

- **New `training/reasoning.ts`** — shared `splitReasoning()` (separates a model's
  CoT from its clean answer; handles `reasoning_content`, `<think>…</think>`, and
  harmony `<\|channel\|>` markup, mirroring the Rust stripper) and `withThink()` (re-emits
  the canonical reasoning-SFT shape).
- **`distill.ts`** — the 26B teacher's reasoning is now **captured** onto each
  assistant turn, and the **`<think>`-leak bug is fixed** (the final answer is cleaned).
  Reasoning is **never re-fed** to the model in the loop (matches Qwen3 guidance / the
  production agent loop).
- **Schema** — optional `reasoning` field added to `ChatMessage` (both `training/types.ts`
  and `src/lib/types.ts`). The Rust store needs no change (it persists `messages` as raw
  JSON), so capture stays faithful and the exporter decides what to do with it.
- **`redact.ts`** — the PII scrubber now covers reasoning traces too.
- **`export.ts`** — new `--reasoning none|distilled|all` flag (**default `none`**, so the
  fast-tier SFT stays reasoning-free and existing runs are byte-for-byte unchanged). It
  folds reasoning into a `<think>` block only for the selected sources, **never emits a
  raw `reasoning` field**, and logs how many examples carry reasoning. The **gold filter
  now also requires parseable JSON tool arguments** (a cheap outcome label, G7).
- **`eval/cases.ts`** — the scorer now rejects **malformed JSON tool arguments** and
  checks **argument values** via `expectArgsInclude` (G3); `who-is`/`tell-about` now
  assert the right entity is passed, not just the right tool.
- **`selftest.ts`** — +10 checks (now **24**, all passing) covering reasoning
  split/fold, reasoning redaction, the JSON-arg and argument-value scorer rules, and
  the exporter's fold + gold-filtering.

**How to use the new capability:** to train a reasoning-capable target on the teacher's
CoT, run the distiller against the 26B, then
`node --experimental-strip-types training/export.ts --mode sft --reasoning distilled`.
Leave the default (`none`) when fine-tuning the production fast tier (thinking-disabled).

### Validation (all green)
- `training/selftest.ts` → **24/24** pass.
- Full offline pipeline: `synthesize` (135) → `export` (sft/kto, both `reasoning`
  modes) → `distill` lint → `eval` lint — all succeed.
- `npx tsc --noEmit` → no type errors. `npm test` → **66/66** pass.

### Deliberate next steps (not in this pass)
G2 (attach real `tools` schemas — needs production tool signatures, not the eval stubs),
G4 (NER redaction), G5 (semantic dedup), G6 (KTO class weighting + sycophancy guard),
G8 (implicit signals), and Phase B's refusal/multi-turn/AST eval.
