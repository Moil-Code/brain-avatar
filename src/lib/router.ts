import { llmComplete } from "./tauri";
import type { BaseEndpoint } from "./llm";

export interface Route {
  modelId: string;
  taskType: string;
  enhanced: string; // optimized instruction for the executor model
  routed: boolean; // false = single model, no real routing happened
}

/** Describe each loaded model's strengths so the router can choose well. */
function modelStrengths(models: string[]): string {
  return models
    .map((m) => {
      const l = m.toLowerCase();
      if (l.includes("qwen"))
        return `- ${m}: FAST. Best for tool use + multi-step actions (email, calendar, files, web, apps), structured/JSON, and quick factual answers.`;
      if (l.includes("gemma") && /(2[4-9]b|3[0-9]b)/.test(l))
        return `- ${m}: DEEP. Best for high-quality summarization, writing, nuanced analysis & synthesis, careful reasoning. Slower.`;
      if ((l.includes("gemma") && /1[0-9]b/.test(l)) || l.includes("vl") || l.includes("vision"))
        return `- ${m}: VISION + balanced. Use when the request involves an image/screenshot, or for solid general reasoning.`;
      return `- ${m}: general-purpose.`;
    })
    .join("\n");
}

function pickFast(models: string[]): string {
  return models.find((m) => m.toLowerCase().includes("qwen")) ?? models[0] ?? "";
}
function pickDeep(models: string[]): string {
  return models.find((m) => /gemma|2[4-9]b|3[0-9]b/.test(m.toLowerCase())) ?? pickFast(models);
}

/** Heuristic fallback if the LLM router fails. */
function heuristicRoute(userText: string, models: string[]): Route {
  const deep =
    userText.length > 240 ||
    /\b(summar[iy]|analy[sz]e|draft|write (me )?an?|essay|report|compare|deep|in.?depth|strateg|nuanc)\b/i.test(
      userText
    );
  return {
    modelId: deep ? pickDeep(models) : pickFast(models),
    taskType: deep ? "deep_analysis" : "general",
    enhanced: userText,
    routed: true,
  };
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

  const routerModel = pickFast(models); // run the cheap classification on the fast model
  const sys = `You are the routing layer for Andres' (CEO of Moil) personal AI assistant.
Decide how to best handle his request and reply with ONLY one JSON object:
{"task_type":"<one of: email, calendar, research_web, deep_analysis, quick_answer, vision, file, app_control, writing, coding, brain_lookup, general>","model_id":"<an id copied EXACTLY from the list below>","enhanced_instruction":"<a precise, high-quality instruction for the chosen model>"}

Available models (pick the best fit, id verbatim):
${modelStrengths(models)}
${opts.hasImage ? "The request includes an IMAGE — you MUST pick a vision model." : ""}

Guidance: use the FAST model for tool/action tasks and quick answers (reading email, calendar, files, web lookups, scheduling); use the DEEP model for summarizing, writing, or nuanced analysis; use VISION only for images.
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
    const modelId = models.includes(j.model_id) ? j.model_id : pickFast(models);
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
