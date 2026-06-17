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

## 1. Current setup (what we audited)

- **Host:** Mac Mini, **24GB unified memory** (Apple Silicon). Unified memory is
  shared by macOS + apps + GPU — realistically **~18GB usable** for model weights
  + KV cache once the OS and the Tauri app are accounted for.
- **Runtime:** LM Studio (OpenAI-compatible `:1234/v1`), fronted by `brain-daemon`
  (Rust, single-flight semaphore) over Tailscale, optional `lm-queue-proxy`.
- **Models in rotation:**
  - `qwen3-8b` — fast / primary tool-calling tier (~5GB @ Q4), `enable_thinking:false`.
  - `gemma-*-12b` — fast fallback / multimodal (~7–8GB @ Q4).
  - `gemma-…-26b` MoE — deep reasoning tier (slow first token, 60–120s).
  - optional VL/vision model.
- **Inference config:** temp `0.4` fixed, `max_tokens` 4096, **non-streaming**
  frontend, 300s timeout, 5-round agent loop. STT = Groq Whisper (cloud, **0 local
  VRAM** — good), TTS = macOS `say` (free).
- **Concurrency:** single-flight — only one generation at a time across the system.

### Key problems identified

1. **VRAM juggling.** Three+ chat models (8B, 12B, 26B) means either model-swap
   latency or — worse — several resident at once, which is what historically
   stalled the box. Single-flight fixes _compute_ contention, not _memory_
   residency.
2. **Dense 8B is no longer the efficiency frontier.** In 2026 a 3–4B dense model
   matches the old 8B on tool-calling, and small-active MoEs (≈3B active) beat it
   on quality at similar speed.
3. **Likely on GGUF, not MLX.** On Apple Silicon, MLX is materially faster for
   decode (esp. MoE). If we're on llama.cpp/GGUF builds we're leaving 20–40% on
   the table for free.
4. **KV cache / context not tuned.** No explicit context cap or KV-cache quant.
   Context memory is often the silent VRAM hog, not weights.
5. **Non-streaming UI** hurts perceived latency even when throughput is fine.

## 2. Should we replace the 8B? — Yes.

The 8B dense model is the weakest link on two fronts: it's bigger and slower than
a modern 4B for the same tool-calling job, and it's weaker than a small MoE for
reasoning. The 2026 frontier for this exact use case (agentic tool-calling, local,
memory-constrained) is:

| Tier | Old | 2026 replacement | Why |
|------|-----|------------------|-----|
| Fast / tool-routing | `qwen3-8b` (~5GB) | **~4B dense** (Qwen3.5-4B-class / Nemotron Nano 4B / Granite 4 ~4B), ~3GB | ~97% tool-calling accuracy at <½ the size & faster TTFT. Frees ~2GB. |
| Deep reasoning | 12B + 26B MoE | **one small-active MoE** (Qwen3-30B-A3B-class, ~18GB @ Q4) | 30B total / **3B active** → ~3B-dense speed, ~8B+ quality, strong BFCL tool-use. Collapses two models into one better one. |

**Net effect:** 4 chat models → **2**. Newer, more capable, and far more free
memory in the common case.

## 3. The 24GB memory tension (the real engineering decision)

A 4B (3GB) + a 30B-A3B (18GB) cannot _both_ stay resident on 24GB alongside macOS.
Two viable shapes:

- **Option A — Two-tier with JIT eviction (recommended).** Keep the **4B always
  resident** (~3GB → lots of headroom most of the time). The MoE is **JIT-loaded
  with an idle TTL** and only loads when the router picks a deep task; it evicts
  after idle. Single-flight already serializes generations, so the only cost is a
  model-swap on the first deep request after idle. Best everyday memory profile.
- **Option B — Single MoE for everything.** Run only the 30B-A3B (thinking-mode
  toggled per task). Simplest mentally, top quality, but ~18–20GB resident is
  _tight_ on 24GB — long contexts + KV cache can tip it into swap. Use only if you
  rarely need the snappiest tool-routing latency.
- **Option C — Two-tier that co-resides.** 4B (3GB) + a **14B dense or smaller MoE
  @ Q4 (~9–10GB)** → both fit (~13GB) with headroom, no swap latency, but you give
  up some of the 30B-A3B's deep-reasoning quality.

Recommendation: **Option A** matches the app's "fast tool calls + occasional deep
work" profile and single-flight design best. Fall back to **C** if model-swap
latency on deep tasks proves annoying.

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
6. **Speculative decoding** for any _dense_ deep model (4B or a 0.6B draft → 1.5–3×).
   Note: a 30B-**A3B** MoE already decodes ~3B-fast, so spec-decode adds little
   there — apply it to dense models (Option C's 14B), not the A3B.
7. **Enable streaming in the frontend.** `brain-daemon` already relays SSE; the UI
   currently batches non-streaming. Streaming cuts _perceived_ latency on long
   answers with zero throughput cost.
8. **Right-size `max_tokens`.** 4096 default is generous for an avatar; lowering the
   default (with per-task override) caps worst-case latency.
9. **Quant sweet spot:** 4-bit MLX / Q4_K_M is the value pick. Reserve Q8 for cases
   where quality is critical _and_ it still fits.

## 5. Recommended target setup

```
Fast tier  : <model>-4B            MLX 4-bit   (~3GB, always resident)
Deep tier  : <model>-30B-A3B MoE   MLX 4-bit   (~18GB, JIT + idle TTL)
Vision     : reuse deep tier if multimodal, else a small VL model JIT-loaded
Runtime    : MLX, Flash Attention ON, KV-cache Q8_0, context capped ~32K
UI         : streaming completions
STT/TTS    : unchanged (Groq Whisper cloud + macOS say) — already 0 local VRAM
```

Outcome vs today: fewer models, newer + more capable per GB, snappier tool calls,
and in the common (fast-tier-only) case the box sits at ~3GB resident instead of
juggling 12–26GB — i.e. **most of the 24GB is freed** for KV cache / headroom.

## 6. Suggested rollout order (low-risk → high-leverage)

1. Turn on **MLX + Flash Attention + KV-cache Q8 + context cap** on the _current_
   models. Measure tok/s and TTFT. (Pure config; no model change.)
2. Swap `qwen3-8b` → a **4B** MLX model; A/B the tool-calling success rate against
   the existing eval/usage. Keep the router's fast-tier regex pointed at it.
3. Replace 12B + 26B with **one 30B-A3B MoE** (JIT + TTL); update `router.ts`
   `pickPrimary`/`pickFast` patterns and remove the now-unused tiers.
4. Enable **frontend streaming**; right-size `max_tokens`.
5. (Optional) speculative decoding if you adopt a dense deep model.

Each step is independently revertible and measurable.

---

### Sources

- [BentoML — Best open-source SLMs 2026](https://www.bentoml.com/blog/the-best-open-source-small-language-models)
- [SiliconFlow — Best open-source LLM for agent workflow 2026](https://www.siliconflow.com/articles/en/best-open-source-LLM-for-Agent-Workflow)
- [Local LLMs on tool calling — 2026 eval](https://www.jdhodges.com/blog/local-llms-on-tool-calling-2026-pt1-local-lm/)
- [Qwen3 lineup guide 2026](https://baeseokjae.github.io/posts/qwen-3-full-lineup-guide-2026/) · [Qwen3-30B-A3B which version](https://blog.laozhang.ai/en/posts/qwen3-30b-a3b) · [apxml Qwen3-30B-A3B specs](https://apxml.com/models/qwen3-30b-a3b)
- [Qwen3.5 medium series benchmarks](https://www.digitalapplied.com/blog/qwen-3-5-medium-model-series-benchmarks-pricing-guide) · [BFCL-V4 leaderboard](https://llm-stats.com/benchmarks/bfcl-v4)
- [Granite 4.1 vs Gemma 4](https://www.aimadetools.com/blog/granite-4-1-vs-gemma-4/) · [7 best SLMs under 10B 2026](https://www.labellerr.com/blog/best-small-language-models-under-10b-parameters/)
- [Best local LLMs for 24GB Apple Silicon](https://willitrunai.com/macs/m4-pro-24gb) · [Apple Silicon LLM guide 2026](https://codersera.com/blog/apple-silicon-llms-complete-guide-2026/)
- [MLX vs llama.cpp on Apple Silicon (Ollama switch, M5)](https://yage.ai/share/mlx-apple-silicon-en-20260331.html) · [MLX 3x faster until 40K context](https://pub.towardsai.net/apples-mlx-runs-local-llms-3x-faster-than-llama-cpp-until-your-context-hits-40k-715ec441afbb)
- [LM Studio speculative decoding](https://lmstudio.ai/docs/app/advanced/speculative-decoding) · [LLM quantization 2026 (KV cache, Q4 vs Q8)](https://www.promptquorum.com/local-llms/llm-quantization-explained) · [LM Studio tips (flash attn / KV quant)](https://insiderllm.com/guides/lm-studio-tips-and-tricks/)
</content>
</invoke>
