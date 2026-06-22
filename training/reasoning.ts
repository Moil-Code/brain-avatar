// Reasoning/thinking trace handling for the training pipeline.
//
// Local reasoning models (the 26B teacher, Gemma 4, Qwen3 with thinking on) emit
// their chain-of-thought either in a SEPARATE `reasoning_content` field or INLINE in
// `content` as <think>…</think> or harmony <|channel|>analysis<|message|>… markup.
//
// Production strips all of this in Rust (llm.rs `strip_reasoning`) before it reaches
// the app, so the *answer* shown/spoken is clean — but the distiller (distill.ts)
// talks to LM Studio directly in Node and never went through that stripper. That had
// two consequences: the teacher's raw <think> markup could leak into the distilled
// FINAL answer, and the teacher's reasoning was discarded entirely. This module is
// the shared fix: `splitReasoning` separates the trace from the clean answer (mirrors
// the Rust logic) and `withThink` re-emits it in the canonical reasoning-SFT shape
// for the exporter. Capture stays faithful (the trace is kept on the message); the
// exporter decides per run whether to train on it.

export interface ReasoningSplit {
  /** The model's chain-of-thought, concatenated and trimmed ("" if none). */
  reasoning: string;
  /** The clean, user-facing answer with all reasoning markup removed. */
  content: string;
}

const THINK_BLOCK = /<think>([\s\S]*?)<\/think>/gi;
// Harmony channel: <|channel|>analysis<|message|>…  up to the next channel/end.
const HARMONY_CHANNEL = /<\|channel\|>\s*(\w+)\s*<\|message\|>([\s\S]*?)(?=<\|channel\|>|<\|end\|>|<\|return\|>|$)/gi;
const STRAY_TOKEN = /<\|[^|]*?\|>/g; // leftover control tokens, e.g. <|message|>
const STRAY_MARKER = /\b(?:analysis|thought|commentary|final)\|>/gi; // e.g. "thought|>"

/**
 * Split a model message into its reasoning trace and its clean answer.
 *
 * @param content        the message `content` (may carry inline reasoning markup)
 * @param reasoningField an explicit `reasoning_content`/`reasoning` field, if the API
 *                       returned the trace out-of-band (preferred when present)
 */
export function splitReasoning(content: string, reasoningField?: string): ReasoningSplit {
  const parts: string[] = [];
  if (reasoningField && reasoningField.trim()) parts.push(reasoningField.trim());

  let text = content ?? "";

  // 1) <think>…</think> blocks → reasoning; remove from the answer.
  text = text.replace(THINK_BLOCK, (_m, inner: string) => {
    if (inner.trim()) parts.push(inner.trim());
    return "";
  });

  // 2) Harmony channels: keep only the `final` channel as the answer; the rest
  //    (analysis/thought/commentary) is reasoning. Only override the answer when a
  //    final channel is actually present, so a non-harmony "<|...|>" never blanks it.
  if (text.includes("<|channel|>")) {
    const segs = [...text.matchAll(HARMONY_CHANNEL)];
    if (segs.length) {
      const finals: string[] = [];
      for (const s of segs) {
        const name = s[1].toLowerCase();
        const body = s[2];
        if (name === "final") finals.push(body);
        else if (body.trim()) parts.push(body.trim());
      }
      if (finals.length) text = finals.join("");
    }
  }

  // 3) Scrub any leftover control tokens / stray markers from the answer.
  const clean = text.replace(STRAY_TOKEN, "").replace(STRAY_MARKER, "").trim();

  return { reasoning: parts.join("\n\n").trim(), content: clean };
}

/** Render a reasoning-distillation training turn: a <think> block, then the answer.
 *  Returns the plain answer unchanged when there's no reasoning to fold in. */
export function withThink(reasoning: string, content: string): string {
  const r = (reasoning ?? "").trim();
  const c = (content ?? "").trim();
  if (!r) return c;
  return `<think>\n${r}\n</think>\n\n${c}`.trim();
}
