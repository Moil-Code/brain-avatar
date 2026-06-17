# Model & Inference Performance Audit — 24GB Mac Mini Brain

_Audit date: 2026-06-17. Scope: should we replace `qwen3-8b`, how to free unified
memory on the 24GB Mac Mini, and what the best-possible local setup looks like._

> **Confidence note on model names/benchmarks:** the 2026 release landscape
> (Qwen3.5 / 3.6, Granite 4.1, Gemma 4, Nemotron Nano, etc.) is moving fast and
> several figures below come from secondary sources. Treat exact version strings
> and tok/s numbers as _directional_ — confirm the specific build, quant, and
> size against the LM Studio model catalog at install time. The **architecture
> recommendations** (MoE for the deep tier, a tiny dense model for the fast tier,
> MLX runtime, KV-cache quant) are robust regardless of which exact 2026 point
> release you pick.

## 0. Executed outcome (2026-06-17) — read this first

The migration is done, and the "all-MLX" instinct turned out to be **wrong for this
hardware** (proven with LM Studio's memory estimator): Gemma 4's **MLX 4-bit** builds
are *heavier* in RAM than its **QAT GGUF** builds, so going all-MLX would have made the
24GB squeeze worse. Final state is a **hybrid**:

| Tier | Final model | Format | Size |
|------|-------------|--------|------|
| Tool / JSON (fast) | `qwen3-8b-mlx` | **MLX** | 4.62 GB |
| Heavy / workhorse | `google/gemma-4-12b-qat` | GGUF QAT | 7.15 GB |
| Deep / reasoning | `gemma-4-26b-a4b-it-qat` | GGUF QAT | 14.25 GB |
| Embeddings | `nomic` (→ `bge-m3` staged) | GGUF | 84 MB |
| Challenger (benched) | `gemma-4-e4b` | — | — |

- **Qwen3-8B (MLX) is the validated tool tier** — clean structured tool calls + coherent
  multi-turn. The Gemma 4 E-series is kept only as a documented challenger to benchmark later.
- **Balancing rule:** default resident set = 12B + qwen3-8b + embeddings ≈ **11.9 GB** (~12 GB
  headroom), covers ~95% of traffic with no swapping. The **12B and 26B never co-reside**
  (26+12+tool ≈ 26 GB > 24); the deep tier loads on demand, unloading the 12B first.
- **Safety net:** LM Studio's RAM guardrail refuses to co-load two big models (verified — it
  blocked a manual 26B load), and the avatar only ever requests already-loaded models, so it
  can't trigger a bad co-load.
- Deleted ~26 GB of superseded MLX downloads (a 26B MLX that wouldn't load, a bloated 12B MLX,
  a redundant MLX bge-m3) → 116 GB free.

The sections below are the original analysis that led here; the recommendation to "go MLX
across the board" is **superseded** by the hybrid above for the Gemma tiers.

## 1. Current setup (what we audited)

- **Host:** Mac Mini, **24GB unified memory** (Apple Silicon). Unified memory is
  shared by macOS + apps + GPU — realistically **~18GB usable** for model weights
  + KV cache once the OS and the Tauri app are accounted for.
- **Runtime:** LM Studio (OpenAI-compatible `:1234/v1`), fronted by `brain-daemon`
  (Rust, single-flight semaphore) over Tailscale, optional `lm-queue-proxy`.
- **Models in rotation (exact strings from `router.ts` / `llm.rs` / `agent.ts`):**
  - `qwen3-8b` — fast / primary tool-calling tier (~5GB @ Q4), `enable_thinking:false`.
    **Qwen3 (mid-2025) — the oldest model in the stack.**
  - **`gemma-4-12b`** — fast fallback / vision tier (~7–8GB @ Q4). **Gemma 4,
    released 2026-06-03**, 256K context, native multimodal (text/image/audio/video).
    Current-gen. _(Note: `router.ts:39` comment still says "Gemma 3" — stale comment.)_
  - **`gemma-4-26b-a4b`** — deep reasoning tier (slow first token, 60–120s).
    **Gemma 4 MoE, released 2026-04-02: 26B total / 4B active** — i.e. already a
    small-active MoE, the architecture this audit recommends. Current-gen.
- **Inference config:** temp `0.4` fixed, `max_tokens` 4096, **non-streaming**
  frontend, 300s timeout, 5-round agent loop. STT = Groq Whisper (cloud, **0 local
  VRAM** — good), TTS = macOS `say` (free).
- **Concurrency:** single-flight — only one generation at a time across the system.

### Key problems identified

1. **The Gemma models are NOT the problem — they're current-gen.** Both
   `gemma-4-12b` (2026-06-03) and `gemma-4-26b-a4b` (2026-04-02) are recent
   Gemma 4 releases. The 26B is already a small-active MoE (4B active) and the
   12B is the natively-multimodal vision tier. **Keep them.**
2. **`qwen3-8b` is the genuinely stale link.** Qwen3 dense 8B (mid-2025) is both
   bigger and slower than a modern ~4B for the fast/tool-routing job it actually
   does. This is the one model worth replacing.
3. **VRAM residency, not model age.** Three chat models means either model-swap
   latency or several resident at once — what historically stalled the box.
   Single-flight fixes _compute_ contention, not _memory_ residency.
4. **Likely on GGUF, not MLX.** On Apple Silicon, MLX is materially faster for
   decode (esp. MoE). If we're on llama.cpp/GGUF builds we're leaving 20–40% on
   the table for free.
5. **KV cache / context not tuned.** No explicit context cap or KV-cache quant —
   and Gemma 4 ships a **256K** window, so an uncapped context can balloon the KV
   cache and silently eat VRAM. This matters more than weights here.
6. **Non-streaming UI** hurts perceived latency even when throughput is fine.

## 2. What to replace — just the 8B fast tier.

Keep both Gemma 4 models. The only worthwhile model swap is the fast tier:

| Tier | Today | Recommendation | Why |
|------|-------|----------------|-----|
| Fast / tool-routing | `qwen3-8b` (~5GB, mid-2025) | **a 2026 ~4B** — `gemma-4-e4b` (~4.5B eff) _or_ Qwen3.5-4B-class | ~95–97% tool-calling at <½ the size & faster TTFT; frees ~2GB. |
| Vision / fast-fallback | `gemma-4-12b` (2026-06) | **keep** | Current, native multimodal, 256K ctx — load-bearing for the vision route. |
| Deep reasoning | `gemma-4-26b-a4b` (2026-04) | **keep** | Already a 26B/4B-active MoE; current-gen. |

**Recommended fast-tier pick: `gemma-4-e4b`.** It keeps the whole stack on one
Gemma 4 family (consistent tokenizer/template/multimodal behavior, one set of
quirks to manage) and is natively multimodal, so it can even serve light vision
without falling back to the 12B. Choose Qwen3.5-4B instead only if A/B testing
shows it meaningfully wins on _your_ tool-calling traffic.

**Optional, only if deep-tier agentic/coding quality is a priority:** independent
2026 comparisons report **Qwen3.6-35B-A3B** beating Gemma 4 26B-A4B on coding and
MCP tool-use (e.g. SWE-bench, ~2× MCP tool use). But your deep tier does synthesis
/ long-form writing, and swapping it loses Gemma 4's multimodal. Treat this as an
experiment, not a default — and not a reason to drop the Gemma family.

## 3. The 24GB memory tension (the real engineering decision)

The constraint was never model age — it's residency. Even all-current models
can't all stay loaded: `gemma-4-e4b` (~3GB) + `gemma-4-12b` (~7–8GB) +
`gemma-4-26b-a4b` (~15–16GB @ Q4) ≈ 25GB+ before KV cache and macOS. So:

- **Recommended — Tiered JIT eviction.** Keep the **fast ~4B always resident**
  (~3GB → lots of headroom most of the time). Load the **12B** and **26B-A4B**
  on demand with an idle TTL and let them evict. Single-flight already serializes
  generations, so the only cost is a model-swap on the first heavy request after
  idle. Everyday footprint drops to ~3GB instead of 15–25GB.
- **If swap latency annoys you:** keep `gemma-4-e4b` + `gemma-4-12b` co-resident
  (~11GB, fits with headroom) and JIT-load only the 26B-A4B for deep tasks. The
  12B "nearly matches the 26B across benchmarks," so it covers most non-deep work
  without paying for the MoE swap.

## 4. Performance audit — VRAM/latency wins (independent of model choice)

Apply these regardless of which models you land on:

1. **Switch to MLX builds** of every model (LM Studio supports MLX). 20–40% faster
   decode on Apple Silicon; MoE benefits most. Near-free win.
2. **Flash Attention on** (default on Metal since LM Studio v0.3.32 — verify it's
   enabled). Lower attention memory + faster at long context.
3. **KV-cache quantization → Q8_0.** Roughly halves context memory with negligible
   quality loss. The single biggest "free VRAM" lever for an agent with long tool
   transcripts.
4. **Cap context length** to what the 5-round agent loop actually needs (likely
   16–32K, not 128K+). KV cache scales linearly with context; capping reclaims GB.
5. **LM Studio JIT load + idle TTL auto-evict.** Guarantees only the active model
   is resident — directly fixes the historic multi-model stall.
6. **Speculative decoding** helps _dense_ models most (a small draft → 1.5–3×).
   `gemma-4-26b-a4b` already decodes ~4B-fast as an MoE, so spec-decode adds
   little there; it's more useful if you ever lean on a dense deep model.
7. **Enable streaming in the frontend.** `brain-daemon` already relays SSE; the UI
   currently batches non-streaming. Streaming cuts _perceived_ latency on long
   answers with zero throughput cost.
8. **Right-size `max_tokens`.** 4096 default is generous for an avatar; lowering the
   default (with per-task override) caps worst-case latency.
9. **Quant sweet spot:** 4-bit MLX / Q4_K_M is the value pick. Reserve Q8 for cases
   where quality is critical _and_ it still fits.

## 5. Recommended target setup

```
Fast tier  : gemma-4-e4b            MLX 4-bit   (~3GB, always resident)
Vision/mid : gemma-4-12b            MLX 4-bit   (~7-8GB, JIT + idle TTL)   [keep]
Deep tier  : gemma-4-26b-a4b MoE    MLX 4-bit   (~15-16GB, JIT + idle TTL) [keep]
Runtime    : MLX, Flash Attention ON, KV-cache Q8_0, context capped ~32K
UI         : streaming completions
STT/TTS    : unchanged (Groq Whisper cloud + macOS say) — already 0 local VRAM
```

Outcome vs today: one stale model retired, the whole stack on current Gemma 4 +
one tiny fast tier, and in the common (fast-tier-only) case the box sits at ~3GB
resident instead of juggling 15–25GB — i.e. **most of the 24GB is freed** for KV
cache / headroom. The big wins here are the runtime/KV/context/JIT changes, not
swapping good models for the sake of it.

## 6. Suggested rollout order (low-risk → high-leverage)

1. Turn on **MLX + Flash Attention + KV-cache Q8 + context cap (~32K)** and
   **JIT load + idle TTL** on the _current_ models. Measure tok/s, TTFT, and
   resident memory. (Pure config; no model change — this is the bulk of the win.)
2. Swap `qwen3-8b` → **`gemma-4-e4b`** (or Qwen3.5-4B); A/B the tool-calling
   success rate against current usage. Update the router's fast-tier pick.
3. Enable **frontend streaming**; right-size the 4096 `max_tokens` default.
4. Fix the stale "Gemma 3" comment in `router.ts:39` (it's Gemma 4 now).
5. (Optional experiment) trial `Qwen3.6-35B-A3B` against `gemma-4-26b-a4b` on
   real deep-tier tasks — adopt only if it wins enough to justify losing multimodal.

Each step is independently revertible and measurable. Note: steps 1 and 3 deliver
most of the performance/VRAM gain without changing any model.

---

### Sources

- [BentoML — Best open-source SLMs 2026](https://www.bentoml.com/blog/the-best-open-source-small-language-models)
- [SiliconFlow — Best open-source LLM for agent workflow 2026](https://www.siliconflow.com/articles/en/best-open-source-LLM-for-Agent-Workflow)
- [Local LLMs on tool calling — 2026 eval](https://www.jdhodges.com/blog/local-llms-on-tool-calling-2026-pt1-local-lm/)
- [Qwen3 lineup guide 2026](https://baeseokjae.github.io/posts/qwen-3-full-lineup-guide-2026/) · [Qwen3-30B-A3B which version](https://blog.laozhang.ai/en/posts/qwen3-30b-a3b) · [apxml Qwen3-30B-A3B specs](https://apxml.com/models/qwen3-30b-a3b)
- [Qwen3.5 medium series benchmarks](https://www.digitalapplied.com/blog/qwen-3-5-medium-model-series-benchmarks-pricing-guide) · [BFCL-V4 leaderboard](https://llm-stats.com/benchmarks/bfcl-v4)
- [Granite 4.1 vs Gemma 4](https://www.aimadetools.com/blog/granite-4-1-vs-gemma-4/) · [7 best SLMs under 10B 2026](https://www.labellerr.com/blog/best-small-language-models-under-10b-parameters/)
- **Gemma 4 (verifying the current models):** [Google: Gemma 4 launch](https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/) · [Engadget: Gemma 4 family off Gemini 3](https://www.engadget.com/ai/google-releases-gemma-4-a-family-of-open-models-built-off-of-gemini-3-160000332.html) · [Gemma 4 12B (2026-06-03) specs](https://www.buildfastwithai.com/blogs/gemma-4-12b-guide) · [Gemma 3 12B vs Gemma 4 12B](https://www.llmreference.com/compare/gemma-3-12b-it/gemma-4-12b-it)
- **Gemma 4 26B-A4B vs Qwen3.6-35B-A3B:** [Towards AI head-to-head](https://pub.towardsai.net/i-tested-alibaba-qwen3-6-35b-a3b-30cc4658a382) · [grigio coding benchmark](https://grigio.org/can-i-really-code-on-my-pc-gemma4-26b-a4b-vs-qwen3-6-35b-a3b-coding-benchmark/) · [KV-cache quant KL-divergence (Gemma 4 / Qwen 3.6)](https://localbench.substack.com/p/kv-cache-quantization-benchmark)
- [Best local LLMs for 24GB Apple Silicon](https://willitrunai.com/macs/m4-pro-24gb) · [Apple Silicon LLM guide 2026](https://codersera.com/blog/apple-silicon-llms-complete-guide-2026/)
- [MLX vs llama.cpp on Apple Silicon (Ollama switch, M5)](https://yage.ai/share/mlx-apple-silicon-en-20260331.html) · [MLX 3x faster until 40K context](https://pub.towardsai.net/apples-mlx-runs-local-llms-3x-faster-than-llama-cpp-until-your-context-hits-40k-715ec441afbb)
- [LM Studio speculative decoding](https://lmstudio.ai/docs/app/advanced/speculative-decoding) · [LLM quantization 2026 (KV cache, Q4 vs Q8)](https://www.promptquorum.com/local-llms/llm-quantization-explained) · [LM Studio tips (flash attn / KV quant)](https://insiderllm.com/guides/lm-studio-tips-and-tricks/)
</content>
</invoke>
