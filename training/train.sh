#!/usr/bin/env bash
# MLX-LM LoRA fine-tune of the fast tier (qwen3-8b) — RUN ON THE MAC MINI.
#
# This container can't reach LM Studio/MLX, so this script is the "you run" half
# of the loop: it exports the corpus, trains a LoRA adapter, fuses it, and gates
# the result against the frozen eval suite. Nothing here touches production until
# you load the fused model in LM Studio yourself.
#
# Prereqs (one-time):  pip install mlx-lm
# Usage:               bash training/train.sh
#
# Knobs (env):
#   BASE_MODEL   HF/MLX repo or local path of the qwen3-8b base   (required)
#   MODE         sft | kto                                        (default sft)
#   ITERS        training iterations                              (default 600)
#   LMSTUDIO_URL endpoint for the eval gate (e.g. http://localhost:1234/v1)
#   MODEL        model id served by LM Studio for the eval gate

set -euo pipefail
cd "$(dirname "$0")/.."

BASE_MODEL="${BASE_MODEL:?set BASE_MODEL to the qwen3-8b base (MLX repo or local path)}"
MODE="${MODE:-sft}"
ITERS="${ITERS:-600}"
DATA_DIR="training/data/mlx-${MODE}"
ADAPTER_DIR="training/adapters/${MODE}-$(date +%Y%m%d-%H%M%S)"
FUSED_DIR="${ADAPTER_DIR}/fused"

echo "==> 1/5  Generate synthetic gold trajectories"
node --experimental-strip-types training/synthesize.ts

# Optional: distill gold trajectories from the 26B teacher. Set DISTILL_MODEL to
# the deep model id served by LM Studio (needs LMSTUDIO_URL too).
if [[ -n "${LMSTUDIO_URL:-}" && -n "${DISTILL_MODEL:-}" ]]; then
  echo "==> 1b/5  Distill from teacher (${DISTILL_MODEL})"
  MODEL="${DISTILL_MODEL}" node --experimental-strip-types training/distill.ts
fi

echo "==> 2/5  Export corpus (live + distilled + synthetic → MLX ${MODE} format)"
# MLX-LM expects train.jsonl / valid.jsonl in one dir.
node --experimental-strip-types training/export.ts --mode "${MODE}" --out "${DATA_DIR}"

echo "==> 3/5  LoRA train (${MODE}, ${ITERS} iters)"
mkdir -p "${ADAPTER_DIR}"
mlx_lm.lora \
  --model "${BASE_MODEL}" \
  --train \
  --data "${DATA_DIR}" \
  --iters "${ITERS}" \
  --batch-size 1 \
  --num-layers 8 \
  --adapter-path "${ADAPTER_DIR}"

echo "==> 4/5  Fuse adapter into a standalone model"
mlx_lm.fuse \
  --model "${BASE_MODEL}" \
  --adapter-path "${ADAPTER_DIR}" \
  --save-path "${FUSED_DIR}"

echo "==> 5/5  Eval gate (frozen suite)"
if [[ -n "${LMSTUDIO_URL:-}" && -n "${MODEL:-}" ]]; then
  # Load ${FUSED_DIR} in LM Studio and serve it as ${MODEL}, then this gates it.
  node --experimental-strip-types training/eval/run.ts || {
    echo "EVAL GATE FAILED — do not ship this adapter."; exit 1; }
else
  echo "skip: set LMSTUDIO_URL and MODEL (serving the fused model) to run the gate."
fi

# Log the run so the in-app Training tracker can show it ("when we train").
RUNS_LOG="${HOME}/Library/Application Support/com.moil.brainavatar/training-runs.jsonl"
EXAMPLES=$(grep -c . "${DATA_DIR}/train.jsonl" 2>/dev/null || echo 0)
mkdir -p "$(dirname "${RUNS_LOG}")"
printf '{"started_at":"%s","mode":"%s","base_model":"%s","iters":%s,"examples":%s,"adapter_path":"%s","status":"done"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${MODE}" "${BASE_MODEL}" "${ITERS}" "${EXAMPLES}" "${FUSED_DIR}" \
  >> "${RUNS_LOG}"

echo
echo "Done. Fused model: ${FUSED_DIR}"
echo "Next: load it in LM Studio, A/B it against the base on real traffic, and only"
echo "make it the fast-tier default if it beats the base on the eval gate."
