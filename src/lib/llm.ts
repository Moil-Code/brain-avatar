import { llmProbe } from "./tauri";
import type { ChatMessage, LlmEndpoint, Settings, ToolCall } from "./types";

/** Pick a healthy LM Studio endpoint: local first, remote (Mac-mini) as fallback. */
export async function resolveEndpoint(settings: Settings): Promise<LlmEndpoint> {
  const pickModel = (models: string[]) => {
    if (settings.model && models.includes(settings.model)) return settings.model;
    if (settings.model && models.length === 0) return settings.model;
    return models[0] ?? settings.model ?? "";
  };

  const local = await llmProbe(settings.lm_studio_local_url).catch(() => null);
  if (local?.ok) {
    return { baseUrl: settings.lm_studio_local_url, model: pickModel(local.models) };
  }

  if (settings.lm_studio_remote_url) {
    const remote = await llmProbe(
      settings.lm_studio_remote_url,
      settings.lm_studio_remote_token
    ).catch(() => null);
    if (remote?.ok) {
      return {
        baseUrl: settings.lm_studio_remote_url,
        token: settings.lm_studio_remote_token,
        model: pickModel(remote.models),
      };
    }
  }

  throw new Error(
    "No LM Studio endpoint is reachable. Make sure LM Studio is running locally on " +
      `${settings.lm_studio_local_url}, or that the remote host is up and the token is set.`
  );
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
