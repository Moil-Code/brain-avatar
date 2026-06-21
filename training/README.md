# Training pipeline — local-only

The on-device path from real + synthetic usage to a fine-tuned fast-tier model.
Everything here runs on the Mac; nothing is synced. See
[`../docs/LOCAL_MODEL_TRAINING_PLAN.md`](../docs/LOCAL_MODEL_TRAINING_PLAN.md) for
the why.

```
 live capture            synthetic gold              teacher (later)
 (app, App.tsx)          (synthesize.ts)             (26B distillation)
        │                       │                          │
        └──────────┬────────────┴──────────────────────────┘
                   ▼
        trajectories/*.jsonl  (schema_version 1, source-tagged)
                   ▼   export.ts  (redact → normalize system → filter → split)
        train.jsonl / valid.jsonl   (MLX-LM sft | kto format)
                   ▼   train.sh  (mlx_lm.lora → fuse)
        fused adapter  ──►  eval/run.ts gate  ──►  load in LM Studio (A/B)
```

## The pieces

| File | What it does | Runs |
|---|---|---|
| `types.ts` | Shared trajectory + example types (mirrors `trajectory.rs`) | — |
| `synthesize.ts` | Generates ~135 gold trajectories (13 scenarios × entity pool × phrasings) for each documented failure mode against a mock tool env; `source:"synthetic"` | `node --experimental-strip-types training/synthesize.ts` |
| `mockenv.ts` | Deterministic, side-effect-free mock tool results (shared by distillation) | imported by distill |
| `distill.ts` | Teacher distillation: the 26B produces gold trajectories over seed tasks (mock tools, no side effects); `source:"distilled"` | `LMSTUDIO_URL=… MODEL=<26B> node --experimental-strip-types training/distill.ts` |
| `redact.ts` | Deterministic structured-PII scrubber (emails, tokens, paths, creds) | imported by export |
| `export.ts` | Fuse live+synthetic → redact → normalize system prompt → filter → train/valid split, in `sft` or `kto` mode | `node --experimental-strip-types training/export.ts --mode sft` |
| `eval/cases.ts` | Frozen eval suite + pure `scoreCase` (first-tool / no-narration / confirm-before-send) | — |
| `eval/run.ts` | Scores a model via an OpenAI-compatible endpoint; gates adapters | `LMSTUDIO_URL=… MODEL=… node --experimental-strip-types training/eval/run.ts` |
| `selftest.ts` | Offline checks for scorer, redactor, generator invariants | `node --experimental-strip-types training/selftest.ts` |
| `train.sh` | End-to-end on the Mac: export → `mlx_lm.lora` → `mlx_lm.fuse` → eval gate | `BASE_MODEL=… bash training/train.sh` |
| `system_prompt.txt` | Canonical system prompt every example is normalized to (keep in sync with `config.rs`) | — |

## Data sources & provenance

Every record carries `source`: **live** (real usage, captured by the app),
**synthetic** (generated here), or **distilled** (teacher model, later). The
exporter caps the synthetic share (`--max-synth-ratio`, default 0.6) once live
data exists, so the fine-tune doesn't overfit to templated phrasing.

- **Live** lands in `~/Library/Application Support/com.moil.brainavatar/trajectories/`.
  The exporter reads it by default. **Best signal — use the app and thumbs answers.**
- **Synthetic** covers the cold start and the rare-but-critical behaviors (decompose,
  confirm-before-send, grounding-refusal). Scale it by enlarging the entity pools in
  `synthesize.ts`.

## When does training run? (notify-when-ready)

Capture is automatic; **training is a manual command you run** — Brain never trains
itself. To tell you *when* it's worth running, the app checks on launch whether
enough **new** real data has accumulated since your last run (≥50 new live turns or
≥15 new rated turns) and fires a macOS notification — once per training "epoch", so
it won't nag. The 📈 tracker shows the same signal live (new-since-last-train + last
trained date). When it pings, run `training/train.sh` on the Mini.

## Two training modes

- **SFT** (`--mode sft`): supervised on gold trajectories — keeps only clean runs
  (all tool calls ok, not thumbed-down). The main behavioral fine-tune.
- **KTO** (`--mode kto`): preference tuning from thumbs. Emits `{prompt, completion,
  label}` (unpaired binary) — the correct shape for 👍/👎 (not DPO, which needs
  matched pairs). Run after SFT, once enough rated turns exist.

## Quick start (offline, no model)

```bash
node --experimental-strip-types training/selftest.ts        # all checks pass
node --experimental-strip-types training/synthesize.ts      # writes synthetic.jsonl
node --experimental-strip-types training/export.ts --mode sft
node --experimental-strip-types training/eval/run.ts        # lints the suite
```

## On the Mac Mini (the real run)

**Don't run `pip install mlx-lm` directly** — Homebrew's Python blocks it with
`externally-managed-environment` (PEP 668). `train.sh` handles this for you: it
creates a local venv at `training/.venv` and installs mlx-lm there. Just run it.

```bash
# 1. Baseline the current model so the tracker has a "before" number to beat:
LMSTUDIO_URL=http://localhost:1234/v1 MODEL=qwen3-8b \
  node --experimental-strip-types training/eval/run.ts

# 2. Train + fuse + gate (auto-creates the venv, installs mlx-lm):
BASE_MODEL=<qwen3-8b-mlx repo/path> bash training/train.sh

# then load the fused model in LM Studio and A/B before defaulting to it
```

If you ever want mlx-lm in your own shell (e.g. to poke at it):

```bash
python3 -m venv training/.venv && source training/.venv/bin/activate
python -m pip install mlx-lm
```

## Where do I see the dashboard?

It's **inside the Brain Avatar app** — the **📈 button in the title bar** (next to
⏰ Automations), which opens the **Training tracker** panel. It shows what's in the
local corpus (by source / task / tool, ratings, daily growth) and your training-run
history with eval before→after.

You need to be running the build that includes it (this branch). In the repo:

```bash
npm install
npm run tauri dev      # hot-reload dev build — fastest way to see the 📈 tab
# or: npm run tauri build   # then launch the packaged .app
```

The tracker reads `~/Library/Application Support/com.moil.brainavatar/` —
`trajectories/*.jsonl` (what to train on) and `training-runs.jsonl` (when you
trained, appended by `train.sh`). It's empty until you use the app a bit; run
`train.sh` once and a run row appears.

## Deliberate follow-ups (not yet done)

- **Name-level anonymization** needs an NER pass; `redact.ts` only catches
  structured identifiers today.
- **Teacher distillation** (`source:"distilled"`) — have the 26B generate gold
  trajectories for sampled tasks; same schema, fed through the same exporter.
- **Tool schemas in examples** — the exporter omits the `tools` array for now;
  attach `TOOL_DEFS` if eval shows the model needs the signatures during training.
