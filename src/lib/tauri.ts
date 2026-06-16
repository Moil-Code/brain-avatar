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
export const brainPage = (name: string) =>
  invoke<string>("brain_page", { name });
export const calendarEvents = (days?: number) =>
  invoke<string>("calendar_events", { days });
export const calendarCreate = (args: {
  subject: string;
  start: string;
  end: string;
  timeZone?: string;
  attendees?: string[];
  isTeams?: boolean;
  location?: string;
  body?: string;
}) => invoke<string>("calendar_create", args);
export const calendarUpdate = (args: {
  eventId: string;
  subject?: string;
  start?: string;
  end?: string;
  timeZone?: string;
  isTeams?: boolean;
  location?: string;
}) => invoke<string>("calendar_update", args);
export const calendarDelete = (eventId: string) =>
  invoke<string>("calendar_delete", { eventId });
export const createTeamsMeeting = (subject: string, start: string, end: string) =>
  invoke<string>("create_teams_meeting", { subject, start, end });
export const webSearch = (query: string) =>
  invoke<string>("web_search", { query });
export const fetchUrl = (url: string) => invoke<string>("fetch_url", { url });

// --- Voice ---
export const transcribeAudio = (audioBase64: string, mime: string) =>
  invoke<string>("transcribe_audio", { audioBase64, mime });
export const ttsSpeak = (text: string, voice?: string) =>
  invoke<void>("tts_speak", { text, voice });
export const ttsStop = () => invoke<void>("tts_stop");
export const listVoices = () => invoke<string[]>("list_voices");

// --- Computer access ---
export const findFiles = (query: string, scope?: string) =>
  invoke<string>("find_files", { query, scope });
export const readFile = (path: string, maxChars?: number) =>
  invoke<string>("read_file", { path, maxChars });
export const openFileCmd = (path: string) => invoke<string>("open_file", { path });
export const openApp = (name: string) => invoke<string>("open_app", { name });
export const listApps = () => invoke<string>("list_apps");
export const runAppleScript = (script: string) => invoke<string>("run_applescript", { script });

// --- History sync ---
export const saveMessage = (conversationId: string, role: string, content: string) =>
  invoke<void>("save_message", { conversationId, role, content });
export const fetchMessages = (conversationId: string, limit?: number) =>
  invoke<{ role: string; content: string; created_at?: string }[]>(
    "fetch_messages",
    { conversationId, limit }
  );
