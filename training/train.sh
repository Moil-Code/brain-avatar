#!/usr/bin/env bash
# MLX-LM LoRA fine-tune of the mid/vision tier (gemma-4-12b) — RUN ON THE MAC MINI.
#
# This container can't reach LM Studio/MLX, so this script is the "you run" half
# of the loop: it exports the corpus, trains a LoRA adapter, fuses it, and gates
# the result against the frozen eval suite. Nothing here touches production until
# you load the fused model in LM Studio yourself.
#
# Prereqs:  Python 3 (Homebrew is fine). This script creates a local venv at
#           training/.venv and installs mlx-lm into it automatically — so you do
#           NOT run `pip install mlx-lm` yourself (Homebrew's Python blocks that
#           with "externally-managed-environment"; the venv sidesteps it cleanly).
# Usage:    bash training/train.sh
#
# Knobs (env):
#   BASE_MODEL   HF/MLX repo or local path of the gemma-4-12b base (required)
#   MODE         sft | kto                                        (default sft)
#   ITERS        training iterations                              (default 600)
#   NUM_LAYERS   how many top layers get a LoRA adapter           (default 8)
#   LMSTUDIO_URL endpoint for the eval gate (e.g. http://localhost:1234/v1)
#   MODEL        model id served by LM Studio for the eval gate

set -euo pipefail
cd "$(dirname "$0")/.."

BASE_MODEL="${BASE_MODEL:?set BASE_MODEL to the gemma-4-12b base (MLX repo or local path)}"
MODE="${MODE:-sft}"
ITERS="${ITERS:-600}"
NUM_LAYERS="${NUM_LAYERS:-8}"
DATA_DIR="training/data/mlx-${MODE}"
ADAPTER_DIR="training/adapters/${MODE}-$(date +%Y%m%d-%H%M%S)"
FUSED_DIR="${ADAPTER_DIR}/fused"

echo "==> 0/5  Python venv + mlx-lm (avoids Homebrew's externally-managed error)"
VENV="training/.venv"
if [[ ! -d "${VENV}" ]]; then
  python3 -m venv "${VENV}"
fi
# shellcheck disable=SC1091
source "${VENV}/bin/activate"
python -m pip install --quiet --upgrade pip
python -m pip install --quiet mlx-lm
echo "    mlx-lm ready: $(python -c 'import mlx_lm; print(mlx_lm.__version__)' 2>/dev/null || echo installed)"

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
  --num-layers "${NUM_LAYERS}" \
  --adapter-path "${ADAPTER_DIR}"

echo "==> 4/5  Fuse adapter into a standalone model"
mlx_lm.fuse \
  --model "${BASE_MODEL}" \
  --adapter-path "${ADAPTER_DIR}" \
  --save-path "${FUSED_DIR}"

# Optional: export a lean quantized GGUF of the fused model so it can be SERVED on
# the 24GB Mini (MLX fused weights are RAM-heavy; the box serves Gemma as GGUF QAT).
# Best-effort via llama.cpp — never aborts an otherwise-good run if tooling is absent.
# Enable with EXPORT_GGUF=1; point LLAMACPP_DIR at your llama.cpp if not on PATH.
if [[ -n "${EXPORT_GGUF:-}" ]]; then
  echo "==> 4b/5  Export fused model → quantized GGUF (best-effort)"
  GGUF_F16="${FUSED_DIR}/model-f16.gguf"
  GGUF_Q4="${FUSED_DIR}/model-Q4_K_M.gguf"
  CONVERT=""
  for c in "${LLAMACPP_DIR:-}/convert_hf_to_gguf.py" "$(command -v convert_hf_to_gguf.py 2>/dev/null || true)"; do
    [[ -n "${c}" && -f "${c}" ]] && CONVERT="${c}" && break
  done
  QUANT="$(command -v llama-quantize 2>/dev/null || true)"
  [[ -z "${QUANT}" && -x "${LLAMACPP_DIR:-}/llama-quantize" ]] && QUANT="${LLAMACPP_DIR}/llama-quantize"
  if [[ -n "${CONVERT}" && -n "${QUANT}" ]]; then
    if python "${CONVERT}" "${FUSED_DIR}" --outfile "${GGUF_F16}" --outtype f16 \
       && "${QUANT}" "${GGUF_F16}" "${GGUF_Q4}" Q4_K_M; then
      rm -f "${GGUF_F16}"
      echo "    GGUF ready: ${GGUF_Q4} — import it into LM Studio to serve."
    else
      echo "    GGUF export failed (arch may be unsupported by this llama.cpp). Serving the MLX fused model still works."
    fi
  else
    echo "    Skipped GGUF export: need llama.cpp's convert_hf_to_gguf.py + llama-quantize."
    echo "    Install llama.cpp and set LLAMACPP_DIR, or convert manually:"
    echo "      python convert_hf_to_gguf.py '${FUSED_DIR}' --outfile out-f16.gguf --outtype f16"
    echo "      llama-quantize out-f16.gguf '${GGUF_Q4}' Q4_K_M"
  fi
fi

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
echo "make it the new default if it beats the base on the eval gate."
