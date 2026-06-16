import { invoke } from "@tauri-apps/api/core";
import type { FeatureFlags, Settings } from "./types";

export const getSettings = () => invoke<Settings>("get_settings");
export const setSettings = (newSettings: Settings) =>
  invoke<void>("set_settings", { newSettings });
export const featureFlags = () => invoke<FeatureFlags>("feature_flags");

/** Test the remote brain-daemon (Settings → Remote brain): reachable + token ok. */
export const daemonProbe = (url: string, token: string) =>
  invoke<string>("daemon_probe", { url, token });

/** Transient/cold-start network failures worth one automatic retry. The remote
 *  24GB Mac often misses the very first request after launch (mDNS resolve +
 *  wake), then is fine — so we retry once before surfacing an error. */
const TRANSIENT = /tim(e|ed)?\s*out|connect|sending request|reset|refused|unreachable|network|broken pipe|eof/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, tries = 2, delayMs = 800): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (i === tries - 1 || !TRANSIENT.test(msg)) throw e;
      await sleep(delayMs);
    }
  }
  throw last;
}

export interface ProbeResult {
  ok: boolean;
  models: string[];
  error: string | null;
}
/** Probe with a single warm-up retry: llm_probe returns {ok:false} rather than
 *  throwing, so a transient first-probe miss is retried explicitly here. */
export const llmProbe = async (baseUrl: string, token?: string): Promise<ProbeResult> => {
  let r = await invoke<ProbeResult>("llm_probe", { baseUrl, token });
  if (!r.ok) {
    await sleep(600);
    r = await invoke<ProbeResult>("llm_probe", { baseUrl, token });
  }
  return r;
};

import type { ToolCall } from "./types";
export const llmComplete = (
  baseUrl: string,
  token: string | undefined,
  model: string,
  messages: unknown,
  tools?: unknown,
  maxTokens?: number
) =>
  withRetry(() =>
    invoke<{ content: string; tool_calls: ToolCall[] | null }>("llm_complete", {
      baseUrl,
      token,
      model,
      messages,
      tools,
      maxTokens,
    })
  );

export const extractDocText = (name: string, base64: string) =>
  invoke<string>("extract_doc_text", { name, base64 });

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
export const sendEmail = (to: string[], subject: string, body: string, cc?: string[]) =>
  invoke<string>("send_email", { to, subject, body, cc });
export const readEmails = (count?: number) => invoke<string>("read_emails", { count });
export const emailDetails = (query: string) => invoke<string>("email_details", { query });
export const createReminder = (title: string, due?: string, remindAt?: string) =>
  invoke<string>("create_reminder", { title, due, remindAt });
export const sendTeamsMessage = (recipientEmail: string, message: string) =>
  invoke<string>("send_teams_message", { recipientEmail, message });

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
