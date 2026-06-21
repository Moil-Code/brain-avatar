import type { BaseEndpoint } from "./llm";

export interface Route {
  modelId: string;
  taskType: string;
  enhanced: string; // optimized instruction for the executor model
  routed: boolean; // false = single model, no real routing happened
}

const lc = (m: string) => m.toLowerCase();

/** Heavy tiers (deep MoE / dense 12B+). Used both to PICK them for deep/vision work
 *  and to keep them OUT of the fast tool tier. */
const BIG_RE = /a4b|a3b|moe|1[2-9]b|[2-9][0-9]b/;

/** Embedding models — never chat candidates. */
const EMBED_RE = /embed|bge|nomic/;

/** Experimental / non-stack builds that must NEVER be auto-selected: community
 *  fine-tunes, speculative-decode drafts, and oversized one-offs that don't fit the
 *  24GB box (e.g. `qwen3.6-27b-mtp-pi-tune` — a 27B that fails to load). The validated
 *  stack is qwen3-8b (tool) + gemma-4-12b (mid/vision) + gemma-4-26b-a4b (deep). These
 *  are dropped from routing and from the picker; nothing here is a model we run. */
const DENY_RE = /mtp|pi-?tune|abliterated|uncensored|-draft\b|\bdraft\b|distill/;

/** Drop embeddings and denied experimental builds from any candidate list, so the
 *  router and the model picker only ever consider models we actually run. Falls back
 *  to the raw list if filtering would leave nothing (never strand the avatar). */
export function usableModels(models: string[]): string[] {
  const kept = models.filter((m) => {
    const l = lc(m);
    return !EMBED_RE.test(l) && !DENY_RE.test(l);
  });
  return kept.length ? kept : models.filter((m) => !EMBED_RE.test(lc(m)));
}

/** DEEP model: the 26B-A4B MoE. A *reasoning* model — emits a long think phase, so
 *  it's slow to first token (60–120s) but best at synthesis, long-form writing, and
 *  nuanced analysis. Reserve it for tasks that genuinely need depth. Falls back to
 *  any big dense model, then the fast model. */
function pickPrimary(models: string[]): string {
  const ms = usableModels(models);
  return (
    ms.find((m) => /a4b|a3b|moe/.test(lc(m))) ??
    ms.find((m) => /2[4-9]b|3[0-9]b/.test(lc(m))) ??
    ms.find((m) => !EMBED_RE.test(lc(m))) ??
    ms[0] ??
    models[0] ??
    ""
  );
}

/** FAST model: the tool/JSON tier — qwen3-8b (MLX). Validated for clean structured
 *  tool calls and coherent multi-turn round-trips, and with thinking disabled it
 *  routes tools quickly instead of burning 60–120s like the 26B. Used for tool/action
 *  tasks (email, calendar, files, web, apps, quick answers). MUST stay small — a big
 *  qwen variant (e.g. a 27B fine-tune) is explicitly excluded so it can't hijack the
 *  fast tier. The Gemma 4 E-series (e4b) is the benched challenger; the dense 12B is
 *  the heavier fallback. */
function pickFast(models: string[]): string {
  const ms = usableModels(models);
  return (
    ms.find((m) => /qwen/.test(lc(m)) && !BIG_RE.test(lc(m))) ??
    ms.find((m) => /gemma/.test(lc(m)) && /e[0-9]+b/.test(lc(m))) ??
    ms.find((m) => /(7b|8b|4b|3b|2b|mini)/.test(lc(m)) && !BIG_RE.test(lc(m))) ??
    ms.find((m) => /gemma/.test(lc(m)) && /1[0-9]b/.test(lc(m))) ??
    ms.find((m) => /vl|vision/.test(lc(m))) ??
    pickPrimary(models)
  );
}
/** Vision requests: prefer an explicit vision/VL model if one is loaded, otherwise
 *  the dense 12B (Gemma 4 is natively multimodal and the strongest vision tier we
 *  load), otherwise the fast fallback (the E-series is multimodal too). Checking the
 *  explicit vision model FIRST means a request with an image never lands on a
 *  weaker model when a real vision model is available. */
function pickVision(models: string[]): string {
  const ms = usableModels(models);
  return (
    ms.find((m) => /vl|vision/.test(lc(m))) ??
    ms.find((m) => /gemma/.test(lc(m)) && /1[0-9]b/.test(lc(m))) ??
    pickFast(models)
  );
}

/** Signals that a request wants the slower-but-deeper 26B: multi-source synthesis,
 *  long-form writing, or code. Everything else stays on the fast tool tier (qwen3-8b).
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

/** Signals the request needs TOOLS (watch a video, email, calendar, files, web,
 *  device control…). The deep 26B reasoning model is fragile inside the tool loop
 *  — it leaks tool-call markup and stalls — so even when a request also reads as
 *  "deep" (it says "analyze"/"summarize"), keep anything tool-driven on the fast
 *  qwen3-8b tier, which emits clean structured tool calls. */
const ACTION_RE =
  /\b(watch|video|youtube|play|pause|open|launch|app|email|e-?mail|inbox|mail|reply|forward|send|message|text|teams|call|schedule|calendar|meeting|invite|remind|reminder|file|files|folder|find|locate|search|google|browse|website|url|link|fetch|download|post|publish|tweet|facebook|instagram|crm|attachment|automation|volume|brightness|screenshot|shell|run\s+command)\b/i;

function isDeep(text: string): boolean {
  if (ACTION_RE.test(text)) return false; // tool task → fast tier, never the 26B
  return DEEP_RE.test(text) || WRITE_RE.test(text) || LONG_RE.test(text);
}

// --- Missing-input preflight -----------------------------------------------
// A reference to a video/link the user wants the avatar to CONSUME ("watch this
// video", "summarize that link"). Requires a consume-verb so it doesn't fire on
// "make this video go viral" (a reference with no intent for us to open it).
const CONSUME_RE =
  /\b(watch|transcrib(?:e|ing)|summari[sz]e|analy[sz]e|review|recap|critique|break\s?down|look at|go over|tell me (?:what|about)|what(?:'?s| is| does| it about))\b/i;
const VIDEO_REF_RE =
  /\b(?:this|that|the|attached|following|above|below|my)\s+(?:video|youtube(?:\s*video)?|clip|recording|reel|short|webinar|livestream|stream|footage)\b/i;
const LINK_REF_RE = /\b(?:this|that|the|following|above)\s+(?:link|url)\b/i;

// A locator the avatar can actually act on: an http(s)/www URL, a bare YouTube
// id, or a local video file path. If ANY of these is present we have what we
// need — never ask.
const LOCATOR_RE =
  /\bhttps?:\/\/|\bwww\.\S+\.\w|\b(?:youtu\.be\/|youtube\.com\/(?:watch|shorts))|\S+\.(?:mp4|mov|mkv|webm|avi|m4v)\b/i;

/**
 * Instant, model-free check for the one missing-input case nothing else can
 * recover: the user wants us to watch/read a video or link but supplied no
 * locator anywhere in this turn OR the recent thread, and attached no file.
 * Returns a ready-to-send clarifying question, or null to proceed normally.
 *
 * Deliberately NARROW (video/link only, consume-verb required). Files and emails
 * are intentionally excluded — find_files and the email search tools can resolve
 * those by name, so blocking them would manufacture false "I need a path" asks.
 * Everything this doesn't catch is handled by the model-driven ask_user tool.
 */
export function missingInput(
  userText: string,
  opts?: { priorText?: string; hasAttachment?: boolean }
): string | null {
  if (opts?.hasAttachment) return null;
  const text = userText ?? "";
  if (!CONSUME_RE.test(text)) return null;
  const wantsVideo = VIDEO_REF_RE.test(text);
  const wantsLink = LINK_REF_RE.test(text);
  if (!wantsVideo && !wantsLink) return null;
  // A locator in THIS turn or earlier in the conversation means we can proceed.
  if (LOCATOR_RE.test(text) || (opts?.priorText && LOCATOR_RE.test(opts.priorText))) return null;
  return wantsVideo
    ? "Happy to — paste the video link (a YouTube URL or any video URL) and I'll watch it and tell you what works, what doesn't, and how to improve it."
    : "Sure — send me the link (a URL) and I'll take a look.";
}

// --- Trivial-turn fast lane -------------------------------------------------
// Pure social turns — greetings, thanks, acknowledgements, sign-offs — need no
// tools and no task board. Detecting them lets runAgent skip the ~31-tool schema
// prefill, MCP discovery, and the whole decomposition loop, so "hey how are you"
// doesn't pay the full agent tax. (FunctionGemma was evaluated for this dispatch
// role and rejected: it's explicitly NOT a dialogue model and needs per-toolset
// fine-tuning that fights our runtime-dynamic MCP tools — a deterministic gate is
// simpler and carries zero accuracy risk.)
//
// HIGH precision is the priority: a false positive would strip tools off a real
// request. So the ENTIRE normalized message must be social — it must START with a
// greeting/affirmation core and contain only cores + harmless fillers. Affirmative
// CONTINUATIONS ("yes", "sure", "go ahead", "continue") are deliberately excluded:
// those advance work, they aren't chit-chat.
const CHAT_CORES = [
  "good morning", "good afternoon", "good evening", "good day", "good night", "goodnight",
  "how are", "how is", "how's", "hows", "how have", "how you", "how goes",
  "how's it going", "hows it going", "what's up", "whats up", "whatcha",
  "thank you", "thanks", "thank", "thx", "ty", "cheers", "appreciate", "appreciated",
  "got it", "sounds good", "sounds great", "makes sense", "fair enough",
  "no worries", "no problem", "all good", "see you", "see ya", "talk later",
  "talk to you later", "take care", "good to know",
  "hi", "hello", "hey", "heya", "hiya", "yo", "howdy", "hola", "greetings",
  "sup", "wassup", "whatsup", "mornin", "evenin",
  "ok", "okay", "kk", "cool", "nice", "great", "awesome", "perfect", "sweet",
  "wonderful", "excellent", "fantastic", "np", "bye", "goodbye", "later", "night",
  "lol", "lmao", "haha", "hahaha", "hehe", "ha",
];
// Connective words allowed AFTER a core ("hey there", "thanks so much", "how are
// you doing today"). Kept free of any action verb so a request can never sneak in.
const CHAT_FILLERS = [
  "there", "buddy", "man", "dude", "friend", "pal", "brain", "jarvis", "again",
  "today", "tonight", "please", "you", "it", "ya", "things", "doing", "going",
  "been", "everything", "goes", "so", "much", "a", "lot", "my", "and",
];
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const coreAlt = CHAT_CORES.slice()
  .sort((a, b) => b.length - a.length)
  .map(escapeRe)
  .join("|");
const fillAlt = CHAT_FILLERS.map(escapeRe).join("|");
const TRIVIAL_CHAT_RE = new RegExp(
  `^(?:${coreAlt})(?:\\s+(?:${coreAlt}|${fillAlt}))*$`,
  "i"
);

/**
 * True only when the WHOLE message is social small-talk that needs no tool — a
 * greeting, thanks, acknowledgement, or sign-off. Conservative by design: short
 * (≤6 words), must start with a social core, and may only carry harmless fillers.
 * Anything actionable ("hey can you check my email", "how do I reset my password",
 * "thanks, also send it") falls through to the normal tool path.
 */
export function isTrivialChat(text: string): boolean {
  const t = (text ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return false;
  if (t.split(" ").length > 6) return false;
  return TRIVIAL_CHAT_RE.test(t);
}

/**
 * The routing layer: pick the best LOADED model for the request. No network call —
 * routing is a local heuristic (default → fast tool tier qwen3-8b; deep work → 26B;
 * image → 12B vision), so it adds zero latency. The chosen model then runs the tool loop.
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
