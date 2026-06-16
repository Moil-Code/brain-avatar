import { llmComplete } from "./tauri";
import type { BaseEndpoint } from "./llm";

export interface Route {
  modelId: string;
  taskType: string;
  enhanced: string; // optimized instruction for the executor model
  routed: boolean; // false = single model, no real routing happened
}

const lc = (m: string) => m.toLowerCase();

/** The do-everything model: the 26B-A4B MoE is large-but-fast (≈4B active params)
 *  with a big context window, so it's the default for almost everything — tool use
 *  AND deep synthesis. Falls back to any large dense model, then qwen, then first. */
function pickPrimary(models: string[]): string {
  return (
    models.find((m) => /a4b|a3b|moe/.test(lc(m))) ??
    models.find((m) => /2[4-9]b|3[0-9]b/.test(lc(m))) ??
    models.find((m) => /qwen/.test(lc(m))) ??
    models.find((m) => !/embed/.test(lc(m))) ??
    models[0] ??
    ""
  );
}
/** A vision-capable model for image/screenshot requests (e.g. Gemma 12B). */
function pickVision(models: string[]): string {
  return (
    models.find((m) => /vl|vision/.test(lc(m))) ??
    models.find((m) => /gemma/.test(lc(m)) && /1[0-9]b/.test(lc(m))) ??
    models.find((m) => /1[0-9]b/.test(lc(m))) ??
    pickPrimary(models)
  );
}

/** Describe each loaded model's strengths so the router can choose well. */
function modelStrengths(models: string[]): string {
  return models
    .map((m) => {
      const l = lc(m);
      if (/a4b|a3b|moe/.test(l))
        return `- ${m}: PRIMARY (MoE — large but fast, big context). Best all-rounder: tool use + multi-step actions (email, calendar, files, web, apps) AND deep summarization, writing, analysis, reasoning. Prefer this for almost everything.`;
      if ((/gemma/.test(l) && /1[0-9]b/.test(l)) || /vl|vision/.test(l))
        return `- ${m}: VISION. Use ONLY when the request involves an image/screenshot/photo, or as a balanced general fallback.`;
      if (/2[4-9]b|3[0-9]b/.test(l))
        return `- ${m}: DEEP. High-quality summarization, writing, nuanced analysis. Slower.`;
      if (/qwen/.test(l))
        return `- ${m}: FAST. Quick tool/action tasks and short answers.`;
      return `- ${m}: general-purpose.`;
    })
    .join("\n");
}

/** Heuristic fallback if the LLM router fails. With the 26B-A4B primary doing
 *  both fast and deep work, routing is simple: vision for images, else primary. */
function heuristicRoute(userText: string, models: string[], hasImage = false): Route {
  if (hasImage)
    return { modelId: pickVision(models), taskType: "vision", enhanced: userText, routed: true };
  return { modelId: pickPrimary(models), taskType: "general", enhanced: userText, routed: true };
}

function extractJson(text: string): any | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * The routing layer: classify the request, pick the best LOADED model for it, and
 * rewrite the request into a sharper instruction that gets better execution.
 */
export async function routeTask(opts: {
  userText: string;
  endpoint: BaseEndpoint;
  hasImage?: boolean;
}): Promise<Route> {
  const { userText, endpoint } = opts;
  const models = endpoint.models;

  // Nothing to route between → use the single model, no extra LLM call.
  if (models.length <= 1) {
    return {
      modelId: models[0] ?? "",
      taskType: opts.hasImage ? "vision" : "general",
      enhanced: userText,
      routed: false,
    };
  }

  // An image hard-forces the vision model; no need to spend a classification call.
  if (opts.hasImage) {
    return { modelId: pickVision(models), taskType: "vision", enhanced: userText, routed: true };
  }

  const routerModel = pickPrimary(models); // classify on the fast primary (A4B)
  const sys = `You are the routing layer for Andres' (CEO of Moil) personal AI assistant.
Decide how to best handle his request and reply with ONLY one JSON object:
{"task_type":"<one of: email, calendar, research_web, deep_analysis, quick_answer, vision, file, app_control, writing, coding, brain_lookup, general>","model_id":"<an id copied EXACTLY from the list below>","enhanced_instruction":"<a precise, high-quality instruction for the chosen model>"}

Available models (pick the best fit, id verbatim):
${modelStrengths(models)}

Guidance: PREFER the PRIMARY model for almost everything — it handles both tool/action tasks (email, calendar, files, web, apps, scheduling) and deep work (summarizing, writing, analysis) quickly. Only pick VISION when the request involves an image/screenshot.
For enhanced_instruction: rewrite Andres' request into the clearest possible instruction — name the exact tools to call (read_emails, brain_page, calendar_events, fetch_url, etc.), the steps, and the ideal output format. Keep it tight.`;

  try {
    const res = await llmComplete(
      endpoint.baseUrl,
      endpoint.token,
      routerModel,
      [
        { role: "system", content: sys },
        { role: "user", content: userText },
      ],
      undefined,
      700
    );
    const j = extractJson(res.content);
    if (!j) return heuristicRoute(userText, models);
    const modelId = models.includes(j.model_id) ? j.model_id : pickPrimary(models);
    return {
      modelId,
      taskType: String(j.task_type ?? "general"),
      enhanced: String(j.enhanced_instruction ?? userText),
      routed: true,
    };
  } catch {
    return heuristicRoute(userText, models);
  }
}
