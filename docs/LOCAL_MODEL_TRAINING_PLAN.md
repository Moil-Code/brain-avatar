# Training the Local Models — Research, Audit, Analysis & Plan

_Authored: 2026-06-20. Scope: how to turn Brain Avatar's local LM Studio models
(Gemma 4 family + Qwen) into **measurably better assistants** by training them on
our own usage — not by swapping models or writing more prompt band-aids._

> **Status: planning only.** Per the directive, this document does **not** start a
> training run. It is the research/audit/analysis/plan that has to land *before* we
> spend a single GPU-hour, because today we are throwing away the one dataset that
> would make training work (see §2.3). Fix the data capture first; train second.

---

## 0. The thesis (read this first)

We already have a "daily improvement loop" — but it improves the **brain (the RAG
knowledge base)**, not the **model**. The Nightly Brain Enrichment automation
(`src/lib/automations.ts:100`) extracts facts from conversations and pushes them
into gbrain. That makes the assistant *know more*. It does nothing to make the
model *behave better* — decompose tasks, call tools correctly, stop narrating,
stay grounded. Those behaviors are currently held together by ~80 lines of
prompt engineering and regex heuristics that the code itself documents as
patches around model failure modes.

**The high-leverage move is to convert those band-aids into learned behavior.**
Every prompt hack in this repo is a labeled training signal in disguise. We have
the failure modes written down, the routing tiers defined, and a data pipeline
half-built. The plan below closes the loop: capture the *trajectories* (not just
Q→A text), distill the behaviors we hand-coded into a fine-tune of the small fast
tier, and use the thumbs feedback we already collect as a preference signal.

Three things make this realistic *now*:

1. **The hardware can train.** MLX-LM ships LoRA/QLoRA/DoRA natively for Apple
   Silicon; a 7–8B QLoRA fits in ~7–8 GB working memory and a small adapter trains
   in well under an hour on the 24 GB Mac Mini. No cloud, no data leaving the box.
2. **The target is small.** We don't need to fine-tune the 26B. The job to improve
   is the **fast/tool tier** (`qwen3-8b` → `gemma-4-e4b`), and small models are
   exactly where fine-tuning beats prompting by the largest margin.
3. **The feedback is the right shape for the right algorithm.** Our thumbs up/down
   (`message_feedback`) is unpaired binary feedback — which maps cleanly onto
   **KTO**, not classic DPO (DPO needs matched chosen/rejected pairs we don't have).

---

## 1. Audit — what exists today

### 1.1 The runtime stack (from `docs/MODEL_PERFORMANCE_AUDIT.md`)

| Tier | Model | Format | Role |
|------|-------|--------|------|
| Fast / tool | `qwen3-8b-mlx` | MLX 4-bit | tool calls, quick answers, voice |
| Mid / vision | `gemma-4-12b-qat` | GGUF QAT | workhorse, multimodal |
| Deep | `gemma-4-26b-a4b-it-qat` | GGUF QAT | synthesis, long-form |
| Embeddings | `nomic` → `bge-m3` | GGUF | brain RAG |

Routing is a zero-latency local heuristic (`src/lib/router.ts`): default → fast
tier; `isDeep()` regex → 26B; image → 12B. The fast tier handles ~95% of traffic
and is the tier the user actually feels. **It is the right and only training target
for v1.**

### 1.2 The data pipeline (already built, commit `07e2764`)

- Every turn → Supabase `messages` (`role`, `content`, `message_id`, `created_at`).
- Per-message 👍/👎 → `message_feedback` (`rating ∈ {-1, 1}`, upsert on `message_id`).
- `GET /api/digest?date=` aggregates a day's conversations (`backend/api/digest.ts`).
- `POST /api/feedback` records ratings (`backend/api/feedback.ts`).
- Nightly automation consumes the digest to enrich **gbrain** — not the model.

### 1.3 The behaviors we currently hand-code (these are the training targets)

The codebase is a catalogue of small-model failure modes we patched in prompt/code:

| Failure mode | Where it's patched | Evidence it's a model weakness |
|---|---|---|
| **Narrates instead of acting** ("I'll search…") | `kanban.ts:detectNarration`, system prompt "CRITICAL" block (`config.rs:140`) | Whole regex layer exists only because the model claims to act without emitting a tool call |
| **Won't decompose multi-step work** | `BOARD_PROTOCOL` + worked example (`agent.ts:74`) | Comment: few-shot example moved decompose reliability "1/5 → 5/5" on small models |
| **Burns rounds on retries/re-sends** | round budget 5→20 (`agent.ts:65`) | "a small local model burns rounds on retries, nudges, and re-sends" |
| **Reasoning markup leaks into answers** | daemon strips `<think>`/`<channel>` (`README` + `agent.ts:1404`) | Deep model "fragile in the tool loop" |
| **Marks tasks done without evidence** | `validateEvidence` gate (`kanban.ts`) | Model fabricates completion |
| **Drops grounding / guesses from stale training** | date-grounding system msg (`agent.ts:1150`) | Model answers from pre-cutoff memory |

Every row is a behavior a fine-tune can internalize, shrinking the prompt and the
heuristic scaffolding it took to force it.

---

## 2. Analysis — the gap between "data we keep" and "data we'd need to train"

### 2.1 What enrichment ≠ training

The nightly loop is **retrieval enrichment**: conversation → extracted fact →
gbrain. The model is frozen. This is valuable and should continue, but it cannot
fix *how* the model acts — only *what context* it's handed. Confusing the two is
the main conceptual risk: "the brain got smarter" is not "the model got better."

### 2.2 KTO, not DPO, for the feedback we have

The feedback table stores a single `rating ∈ {-1,1}` per message — **unpaired,
binary** signal. Classic DPO needs a *chosen vs. rejected* pair for the same
prompt, which we do not produce. **KTO (Kahneman–Tversky Optimization)** is built
for exactly this asymmetric thumbs-up/down case and is the correct algorithm to
reach for. This is a free win: the collection format we already shipped is the
right one — we just have nothing consuming it yet.

### 2.3 🔴 The blocking gap: we persist answers, not trajectories

This is the most important finding in this document.

`src/App.tsx:364-365` persists exactly two rows per turn:

```ts
saveMessage(activeConv, "user", text, userMsg.id)        // final user text
saveMessage(activeConv, "assistant", answer, botId)      // final assistant prose
```

`save_message` (`history.rs:28`) only accepts `role` + `content` (text). So the
**entire tool-calling trajectory is discarded**: which tool the model chose, the
JSON arguments it emitted, the tool results it saw, the kanban decomposition, the
intermediate retries. The agent builds all of this in memory (`agent.ts:1409`
pushes `{role:"assistant", tool_calls}`; `agent.ts:1448` pushes `{role:"tool", …}`)
and then drops everything except the final prose.

**Consequence:** the data we are accumulating can train *general chat tone*, but it
is **useless for the tool-use, decomposition, and grounding behaviors that are the
actual weak points.** You cannot SFT a model to call `brain_page` with the right
args from data that never recorded the call. Until this is fixed, every day of
"data collection" is producing the wrong dataset.

**This is the #1 thing to build, and it is pure plumbing — no model, no GPU.**

### 2.4 Other data-quality gaps

- **No outcome label.** We don't record whether a tool call *succeeded*, whether
  the user corrected the assistant next turn, or whether a confirm-before-send was
  honored. These are cheap to derive and are gold for filtering training data.
- **Thumbs are sparse & hover-hidden** (`ChatPanel.tsx`, fire-and-forget). Most
  turns get no rating. We need implicit signals too (user re-asks = negative;
  user proceeds = positive).
- **No PII boundary.** Transcripts contain real people, deals, emails, calendar.
  Training data must stay on-device (MLX-LM does) and a redaction/consent pass is
  non-negotiable before any trajectory becomes a training row.

---

## 3. The plan — phased, low-risk → high-leverage

Ordering principle: **instrument and measure before you train.** A fine-tune you
can't evaluate is worse than no fine-tune — it can silently regress tool-calling.

### Phase 0 — Data foundation & eval harness (no training)

The prerequisite for everything. All plumbing, all reversible.

0.1 **Persist full trajectories.** Extend `save_message`/schema to store the
   assistant `tool_calls` (name + args), the `tool` result rows, and the route
   (`taskType`, `modelId`) per turn. Add a `turns`/`trajectory` table keyed by
   `conversation_id` + turn index; keep the existing `messages` table for the UI.
   *This unblocks all tool-use training.*

0.2 **Add derived outcome labels.** On each turn record: did every tool call
   parse/execute, was there a next-turn user correction, did a send/post get
   confirmed. Cheap, deterministic, hugely improves data filtering.

0.3 **Capture implicit preference signals.** Re-ask within N turns → weak negative;
   user moves on / says thanks → weak positive. Fold these into the same store the
   explicit thumbs write to, so KTO has volume.

0.4 **Build the eval harness *first*.** A frozen, versioned suite of ~100–200 real
   requests with checkable assertions: *did it call the right tool, with valid JSON
   args, decompose when it should, avoid narration, stay grounded.* Reuse the
   existing test seams (`agent.test.ts`, `router.test.ts`, `kanban.ts` validators)
   as the scoring functions. Every future model/adapter is graded against this. No
   adapter ships that regresses tool-call success or narration rate.

0.5 **Redaction + consent pass.** A deterministic scrubber (names, emails, tokens,
   file paths) applied when exporting trajectories → training set. On-device only.

**Exit criteria for Phase 0:** we can export, from real usage, a versioned JSONL of
*(prompt, tools, chosen tool call(s), outcome label, rating)* — and score any model
against a fixed eval. Until this exists, do not start Phase 1.

### Phase 1 — Behavioral SFT of the fast tier (the main event)

Goal: teach the small fast-tier model the tool protocol, decomposition, and
no-narration discipline directly — so the prompt scaffolding can shrink and small
models stop needing 20 rounds of nudging.

1.1 **Target & method.** Fast tier only (`qwen3-8b` or the `gemma-4-e4b`
   challenger). **LoRA/QLoRA via MLX-LM** on the Mac Mini, 4-bit, chat+tools data
   format (MLX-LM supports a native `tools` field, which maps 1:1 to how the agent
   loop calls the model). Adapter, not full weights — instantly revertible.

1.2 **Dataset = our own good trajectories + synthesized hard cases.**
   - **Positive trajectories** from Phase 0: turns where the right tool was called,
     JSON parsed, outcome succeeded, rating ≥ 0.
   - **Behavior-distillation set:** use the *26B* (our best local model) to generate
     gold trajectories for the failure modes in §1.3 — clean decompositions, correct
     `manage_tasks` card arrays, confirm-before-send flows, "tool returned nothing →
     say so" refusals. The big model teaches the small one (on-device distillation).
   - **Hard negatives → corrections:** narration turns, evidence-less "done", leaked
     `<think>` — paired with the corrected behavior.

1.3 **Train → eval → gate.** Run against the Phase 0 harness. Ship the adapter only
   if tool-call success ↑ and narration/round-count ↓ with **no** grounding
   regression. Keep the adapter swappable in LM Studio; A/B against the base model
   on live traffic before making it default.

1.4 **Shrink the scaffolding as the model internalizes it.** Once the fine-tune
   reliably decomposes, trim `BOARD_PROTOCOL`/system-prompt length and lower the
   round cap — *measured against the harness*, not by faith.

### Phase 2 — Preference alignment from feedback (KTO)

Once SFT lands and we have feedback volume:

2.1 **KTO on the fast tier** using `message_feedback` (explicit) + implicit signals
   from Phase 0. KTO because the data is unpaired binary — no need to manufacture
   chosen/rejected pairs. Apply as a *second, light* adapter pass on top of the SFT
   adapter; same MLX-LM toolchain.

2.2 **Guardrail:** preference tuning is easy to over-cook into sycophancy or
   verbosity. The eval harness from Phase 0 is the brake — a turn the user thumbed
   up that *narrated instead of acting* must not be rewarded. Weight explicit
   tool-success outcomes above raw thumbs.

### Phase 3 — Operationalize the loop (the "becomes everything we want" part)

3.1 **Nightly trajectory export** alongside the existing brain enrichment: same
   digest infra, new sink → on-device JSONL training shard + eval scoring of
   yesterday's traffic (regression watch on the live model).

3.2 **Periodic retrain cadence** (weekly/monthly, not nightly — adapters need
   volume and a human gate). Versioned adapters, one-click rollback in LM Studio.

3.3 **Promote the recipe up a tier** only after the fast tier is proven: the same
   pipeline can later fine-tune the 12B. The 26B stays a frozen teacher.

---

## 4. Risks, guardrails, and explicit non-goals

- **Non-goal (now):** training a model to *autonomously run code/actions*. The
  goal statement is explicit — we are not there. v1 improves *assistance quality*
  (right tool, right args, right decomposition, grounded answers), with the same
  human confirm-before-send gates the prompt already enforces.
- **Regression risk is the big one.** A bad adapter can quietly tank tool-calling.
  Mitigation: the Phase 0 eval gate, adapter (not weight) swaps, live A/B, instant
  rollback.
- **Catastrophic forgetting / over-fit to one user's style.** LoRA at low rank +
  keeping general-instruction data in the mix + the distillation set (not just our
  transcripts) keeps it from collapsing onto a narrow groove.
- **Privacy.** All training on-device (MLX-LM never phones home); redaction pass
  before any row enters a dataset; transcripts are real Moil/people data.
- **Confusing RAG enrichment with model training.** Keep both loops, label them
  distinctly, measure them separately.

---

## 5. What to build first (concrete next actions — all Phase 0, still no GPU)

1. **Trajectory persistence** — extend `save_message` + schema to store tool_calls,
   tool results, and route metadata (§2.3). *Single biggest unblock.*
2. **Outcome labels** — derive tool-success / next-turn-correction / confirm-honored
   per turn (§0.2).
3. **Eval harness** — freeze ~150 real requests with checkable tool/narration/
   grounding assertions, wired to the existing test validators (§0.4).
4. **Redaction pass** — deterministic PII scrubber on export (§0.5).
5. **Exporter** — one command: Supabase/trajectory store → redacted MLX-LM JSONL
   (chat+tools format) + a held-out eval split.

Only once 1–5 exist and we can *score the current model* do we cut the first LoRA
adapter (Phase 1). The fastest path to "really good assistants" is not a bigger
model or a cleverer prompt — it's capturing the trajectories we're currently
deleting, and teaching the small model the behaviors we're currently begging it
for in the system prompt.

---

### Appendix — sources for the 2026 training-stack claims

- MLX-LM LoRA/QLoRA/DoRA on Apple Silicon, tools data format, sub-hour small-model
  fine-tunes: [Markaicode — Run & fine-tune LLMs on Mac with MLX-LM (2026)](https://markaicode.com/run-fine-tune-llms-mac-mlx-lm/) ·
  [Fine-tuning LLMs with LoRA and MLX-LM](https://medium.com/@levchevajoana/fine-tuning-llms-with-lora-and-mlx-lm-c0b143642deb) ·
  [Apple Silicon LLMs complete guide 2026](https://codersera.com/blog/apple-silicon-llms-complete-guide-2026/) ·
  [MLX-LoRA-Studio (on-device fine-tuning app)](https://github.com/Goekdeniz-Guelmez/MLX-LoRA-Studio)
- KTO for unpaired thumbs-up/down feedback (vs. DPO's paired requirement):
  [HF TRL — DPO/KTO trainer docs](https://huggingface.co/docs/trl/main/en/dpo_trainer) ·
  [DPO fine-tuning guide 2026](https://www.spheron.network/blog/dpo-fine-tuning-gpu-cloud/) ·
  [Preference fine-tuning a small model with DPO/KTO](https://www.analyticsvidhya.com/blog/2026/01/lfm-2-preference-fine-tuning-using-dpo/)
</content>
</invoke>
