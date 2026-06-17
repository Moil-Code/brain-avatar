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

/** FAST model: the small Gemma 4 E-series (e.g. gemma-4-e4b). The day-to-day
 *  workhorse — tiny (~3GB) so it stays resident, and with thinking disabled it
 *  decides "which tool?" and emits tool_calls quickly instead of burning 60–120s
 *  like the 26B. Used for tool/action tasks (email, calendar, files, web, apps,
 *  quick answers). Falls back to the dense 12B, then any small/vision model, then
 *  the primary. */
function pickFast(models: string[]): string {
  return (
    models.find((m) => /gemma/.test(lc(m)) && /e[0-9]+b/.test(lc(m))) ??
    models.find((m) => /gemma/.test(lc(m)) && /1[0-9]b/.test(lc(m))) ??
    models.find((m) => /vl|vision/.test(lc(m))) ??
    models.find((m) => /(7b|8b|4b|3b|2b|mini)/.test(lc(m))) ??
    pickPrimary(models)
  );
}
/** Vision requests: prefer an explicit vision/VL model if one is loaded, otherwise
 *  the dense 12B (Gemma 4 is natively multimodal and the strongest vision tier we
 *  load), otherwise the fast fallback (the E-series is multimodal too). Checking the
 *  explicit vision model FIRST means a request with an image never lands on a
 *  weaker model when a real vision model is available. */
function pickVision(models: string[]): string {
  return (
    models.find((m) => /vl|vision/.test(lc(m))) ??
    models.find((m) => /gemma/.test(lc(m)) && /1[0-9]b/.test(lc(m))) ??
    pickFast(models)
  );
}

/** Signals that a request wants the slower-but-deeper 26B: multi-source synthesis,
 *  long-form writing, or code. Everything else stays on the fast E-series model.
 *
 *  Why a heuristic and not an LLM classifier: the deep model burns ~300 tokens
 *  "thinking" before it answers, so even a one-word classification call costs
 *  ~35s — it would *add* latency, not save it. A local regex is instant. It's
 *  deliberately conservative: when unsure we keep the fast model, and the
 *  title-bar model picker can always force a choice. */
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
 * routing is a local heuristic (default → fast E-series; deep work → 26B; image →
 * 12B vision), so it adds zero latency. The chosen model then runs the whole tool loop.
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
