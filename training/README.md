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

```bash
pip install mlx-lm
LMSTUDIO_URL=http://localhost:1234/v1 MODEL=qwen3-8b \
  node --experimental-strip-types training/eval/run.ts      # baseline the BASE model first
BASE_MODEL=<qwen3-8b-mlx repo/path> bash training/train.sh  # train + fuse + gate
# then load the fused model in LM Studio and A/B before defaulting to it
```

## Deliberate follow-ups (not yet done)

- **Name-level anonymization** needs an NER pass; `redact.ts` only catches
  structured identifiers today.
- **Teacher distillation** (`source:"distilled"`) — have the 26B generate gold
  trajectories for sampled tasks; same schema, fed through the same exporter.
- **Tool schemas in examples** — the exporter omits the `tools` array for now;
  attach `TOOL_DEFS` if eval shows the model needs the signatures during training.
