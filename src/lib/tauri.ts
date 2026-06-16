import { invoke } from "@tauri-apps/api/core";
import type { FeatureFlags, Settings } from "./types";

export const getSettings = () => invoke<Settings>("get_settings");
export const setSettings = (newSettings: Settings) =>
  invoke<void>("set_settings", { newSettings });
export const featureFlags = () => invoke<FeatureFlags>("feature_flags");

export interface ProbeResult {
  ok: boolean;
  models: string[];
  error: string | null;
}
export const llmProbe = (baseUrl: string, token?: string) =>
  invoke<ProbeResult>("llm_probe", { baseUrl, token });

import type { ToolCall } from "./types";
export const llmComplete = (
  baseUrl: string,
  token: string | undefined,
  model: string,
  messages: unknown,
  tools?: unknown,
  maxTokens?: number
) =>
  invoke<{ content: string; tool_calls: ToolCall[] | null }>("llm_complete", {
    baseUrl,
    token,
    model,
    messages,
    tools,
    maxTokens,
  });

// --- Tools (executed in Rust, results fed back to the model) ---
export const brainSearch = (query: string, limit?: number) =>
  invoke<string>("brain_search", { query, limit });
export const calendarEvents = (days?: number) =>
  invoke<string>("calendar_events", { days });
export const webSearch = (query: string) =>
  invoke<string>("web_search", { query });

// --- Voice ---
export const transcribeAudio = (audioBase64: string, mime: string) =>
  invoke<string>("transcribe_audio", { audioBase64, mime });

// --- History sync ---
export const saveMessage = (conversationId: string, role: string, content: string) =>
  invoke<void>("save_message", { conversationId, role, content });
export const fetchMessages = (conversationId: string, limit?: number) =>
  invoke<{ role: string; content: string; created_at?: string }[]>(
    "fetch_messages",
    { conversationId, limit }
  );
