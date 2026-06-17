import { llmProbe } from "./tauri";
import type { ChatMessage, LlmEndpoint, Settings, ToolCall } from "./types";

/**
 * Pick a healthy LM Studio endpoint. Inference runs on the remote 24GB Mac
 * (Mac-mini.local), so it is always tried FIRST. (A local endpoint is only used
 * if one ever happens to be running — none runs on this machine by default.)
 */
export async function resolveEndpoint(
  settings: Settings,
  opts: { preferDeep?: boolean } = {}
): Promise<LlmEndpoint> {
  const pickModel = (models: string[]) => {
    if (settings.model && models.includes(settings.model)) return settings.model;
    if (settings.model && models.length === 0) return settings.model;
    const find = (re: RegExp) => models.find((m) => re.test(m.toLowerCase()));
    if (opts.preferDeep) {
      return find(/a4b|a3b|moe/) ?? find(/2[4-9]b|3[0-9]b/) ?? find(/gemma/) ?? models[0] ?? settings.model ?? "";
    }
    return find(/gemma.*e[0-9]+b/) ?? find(/(8b|7b|4b|3b|2b|mini)/) ?? models[0] ?? settings.model ?? "";
  };

  const tryLocal = async (): Promise<LlmEndpoint | null> => {
    if (!settings.lm_studio_local_url) return null;
    const p = await llmProbe(settings.lm_studio_local_url).catch(() => null);
    return p?.ok ? { baseUrl: settings.lm_studio_local_url, model: pickModel(p.models) } : null;
  };
  const tryRemote = async (): Promise<LlmEndpoint | null> => {
    if (!settings.lm_studio_remote_url) return null;
    const p = await llmProbe(settings.lm_studio_remote_url, settings.lm_studio_remote_token).catch(
      () => null
    );
    return p?.ok
      ? {
          baseUrl: settings.lm_studio_remote_url,
          token: settings.lm_studio_remote_token,
          model: pickModel(p.models),
        }
      : null;
  };

  // Always prefer the remote 24GB Mac; local is only a safety net if one is up.
  for (const attempt of [tryRemote, tryLocal]) {
    const ep = await attempt();
    if (ep) return ep;
  }

  throw new Error(
    "Can't reach the 24GB Mac. 1) Make sure it's awake and LM Studio is serving. " +
      "2) Grant this app Local Network access — System Settings → Privacy & Security → " +
      "Local Network → enable Brain Avatar. macOS blocks apps from reaching Mac-mini.local " +
      "until you allow it; the app is now signed so this only needs to be done once."
  );
}

export interface BaseEndpoint {
  baseUrl: string;
  token?: string;
  models: string[];
}

/** Resolve a reachable endpoint and return the models LOADED there (for the router). */
export async function resolveBaseEndpoint(settings: Settings): Promise<BaseEndpoint> {
  if (settings.lm_studio_remote_url) {
    const p = await llmProbe(settings.lm_studio_remote_url, settings.lm_studio_remote_token).catch(
      () => null
    );
    if (p?.ok) {
      return {
        baseUrl: settings.lm_studio_remote_url,
        token: settings.lm_studio_remote_token,
        models: p.models,
      };
    }
  }
  if (settings.lm_studio_local_url) {
    const p = await llmProbe(settings.lm_studio_local_url).catch(() => null);
    if (p?.ok) return { baseUrl: settings.lm_studio_local_url, models: p.models };
  }
  throw new Error(
    "Can't reach the 24GB Mac. 1) Make sure it's awake and LM Studio is serving. " +
      "2) Grant this app Local Network access — System Settings → Privacy & Security → " +
      "Local Network → enable Brain Avatar."
  );
}

/** List the models loaded on the reachable endpoint (remote first), or [] if
 *  none reachable. Used to populate the model-picker menu. Never throws. */
export async function probeModels(settings: Settings): Promise<string[]> {
  if (settings.lm_studio_remote_url) {
    const p = await llmProbe(settings.lm_studio_remote_url, settings.lm_studio_remote_token).catch(
      () => null
    );
    if (p?.ok && p.models.length) return p.models;
  }
  if (settings.lm_studio_local_url) {
    const p = await llmProbe(settings.lm_studio_local_url).catch(() => null);
    if (p?.ok) return p.models;
  }
  return [];
}

export interface StreamResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
}

interface StreamOpts {
  endpoint: LlmEndpoint;
  messages: ChatMessage[];
  tools?: unknown[];
  onToken?: (delta: string) => void;
  signal?: AbortSignal;
}

/** Stream one chat completion, accumulating content + any tool calls. */
export async function streamChat(opts: StreamOpts): Promise<StreamResult> {
  const { endpoint, messages, tools, onToken, signal } = opts;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (endpoint.token) headers.Authorization = `Bearer ${endpoint.token}`;

  const body: Record<string, unknown> = {
    model: endpoint.model,
    messages,
    stream: true,
    temperature: 0.4,
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const resp = await fetch(`${endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => "");
    throw new Error(`LLM HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason: string | null = null;
  const toolAcc: Record<number, ToolCall> = {};

  const handleChoice = (choice: any) => {
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content.length) {
      content += delta.content;
      onToken?.(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const acc = (toolAcc[idx] ??= {
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        });
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.function.name = tc.function.name;
        if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const json = JSON.parse(data);
        const choice = json.choices?.[0];
        if (choice) handleChoice(choice);
      } catch {
        /* ignore partial/keepalive lines */
      }
    }
  }

  const toolCalls = Object.values(toolAcc).filter((t) => t.function.name);
  return { content, toolCalls, finishReason };
}
