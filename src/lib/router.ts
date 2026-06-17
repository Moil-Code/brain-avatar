import type { BaseEndpoint } from "./llm";

export interface Route {
  modelId: string;
  taskType: string;
  enhanced: string; // optimized instruction for the executor model
  routed: boolean; // false = single model, no real routing happened
}

const lc = (m: string) => m.toLowerCase();

/** DEEP model: the 26B-A4B MoE. A *reasoning* model — emits a long think phase, so
 *  it's slow to first token (60–120s) but best at synthesis, long-form writing, and
 *  nuanced analysis. Reserve it for tasks that genuinely need depth. Falls back to
 *  any big dense model, then the fast model. */
function pickPrimary(models: string[]): string {
  return (
    models.find((m) => /a4b|a3b|moe/.test(lc(m))) ??
    models.find((m) => /2[4-9]b|3[0-9]b/.test(lc(m))) ??
    models.find((m) => !/embed/.test(lc(m))) ??
    models[0] ??
    ""
  );
}

/** FAST model: the dense 12B (Gemma). The day-to-day workhorse — it reasons only
 *  briefly, so it decides "which tool?" and emits tool_calls in ~9s vs the 26B's
 *  60–120s. Used for tool/action tasks (email, calendar, files, web, apps, quick
 *  answers) and for vision. Falls back to any small dense model, then the primary. */
function pickFast(models: string[]): string {
  return (
    models.find((m) => /gemma/.test(lc(m)) && /1[0-9]b/.test(lc(m))) ??
    models.find((m) => /vl|vision/.test(lc(m))) ??
    models.find((m) => /qwen|(7b|8b|4b|3b|2b|mini)/.test(lc(m))) ??
    pickPrimary(models)
  );
}
/** Vision requests use the same dense 12B. */
const pickVision = pickFast;

/** Signals that a request wants the slower-but-deeper 26B: multi-source synthesis,
 *  long-form writing, or code. Everything else stays on the fast 12B.
 *
 *  Why a heuristic and not an LLM classifier: BOTH loaded models are reasoning
 *  models that burn ~300 tokens "thinking" before they answer, so even a one-word
 *  classification call costs ~35s — it would *add* latency, not save it. A local
 *  regex is instant. It's deliberately conservative: when unsure we keep the fast
 *  model, and the title-bar model picker can always force a choice. */
const DEEP_RE =
  /\b(analy[sz]e|analysis|summari[sz]e|summary|compare|contrast|critique|strateg|brainstorm|pros and cons|trade[- ]?offs?|deep[- ]?dive|in[- ]depth|thorough|rationale|essay|article|blog\s*post|white\s*paper|report|proposal|memo|outline|refactor|debug|\bcode\b|codebase|function|algorithm|poem|story|script)\b/i;
const WRITE_RE =
  /\b(write|draft|compose|rewrite|expand|polish)\b.{0,40}\b(post|email|letter|essay|article|report|proposal|memo|script|story|poem|blog|thread|bio|summary)\b/i;
const LONG_RE = /\b\d{3,}[\s-]?(?:word|words|char)/i;

function isDeep(text: string): boolean {
  return DEEP_RE.test(text) || WRITE_RE.test(text) || LONG_RE.test(text);
}

/**
 * The routing layer: pick the best LOADED model for the request. No network call —
 * routing is a local heuristic (default → fast 12B; deep work → 26B; image → 12B
 * vision), so it adds zero latency. The chosen model then runs the whole tool loop.
 */
export async function routeTask(opts: {
  userText: string;
  endpoint: BaseEndpoint;
  hasImage?: boolean;
}): Promise<Route> {
  const { userText, endpoint } = opts;
  const models = endpoint.models;

  // Nothing loaded → leave model empty; the caller surfaces the unreachable error.
  if (models.length === 0) {
    return { modelId: "", taskType: "general", enhanced: userText, routed: false };
  }

  // Images hard-force the vision (12B) model.
  if (opts.hasImage) {
    return {
      modelId: pickVision(models),
      taskType: "vision",
      enhanced: userText,
      routed: models.length > 1,
    };
  }

  const deep = isDeep(userText);
  return {
    modelId: deep ? pickPrimary(models) : pickFast(models),
    taskType: deep ? "deep" : "action",
    enhanced: userText,
    routed: models.length > 1,
  };
}
