import { invoke } from "@tauri-apps/api/core";
import type { Automation, FeatureFlags, McpServer, Settings, TaskBoard, TaskInput } from "./types";

// --- Proactive automations (scheduler store + native notifications) ---
export const getAutomations = () => invoke<Automation[]>("get_automations");
export const setAutomations = (automations: Automation[]) =>
  invoke<void>("set_automations", { automations });
/** Post a native macOS notification (used by automation delivery). */
export const notify = (title: string, body: string) =>
  invoke<void>("notify", { title, body });

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
  maxTokens?: number,
  // Optional OpenAI tool_choice override (default "auto" in Rust). The agent loop
  // forces the first decompose call on multi-task requests by passing "required"
  // (LM Studio rejects the named-function object form).
  toolChoice?: unknown
) =>
  withRetry(() =>
    invoke<{ content: string; tool_calls: ToolCall[] | null }>("llm_complete", {
      baseUrl,
      token,
      model,
      messages,
      tools,
      maxTokens,
      toolChoice,
    })
  );

export const extractDocText = (name: string, base64: string) =>
  invoke<string>("extract_doc_text", { name, base64 });

/** Stop all in-flight model generations now (drops the request → LM Studio stops). */
export const cancelGeneration = () => invoke<void>("cancel_generation").catch(() => {});

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
export const webTask = (intent: string) => invoke<string>("web_task", { intent });
export const sendEmail = (to: string[], subject: string, body: string, cc?: string[]) =>
  invoke<string>("send_email", { to, subject, body, cc });
export const readEmails = (count?: number) => invoke<string>("read_emails", { count });
export const readTeams = (count?: number) => invoke<string>("read_teams", { count });
export const emailDetails = (query: string) => invoke<string>("email_details", { query });
export const listAttachments = (query: string) =>
  invoke<string>("list_attachments", { query });
export const readAttachment = (query: string, name?: string) =>
  invoke<string>("read_attachment", { query, name });
export const replyEmail = (query: string, body: string, replyAll?: boolean) =>
  invoke<string>("reply_email", { query, body, replyAll });
export const emailAction = (query: string, action: string) =>
  invoke<string>("email_action", { query, action });
export const xBookmarks = (count?: number) => invoke<string>("x_bookmarks", { count });
export const generateImage = (prompt: string, size?: string, steps?: number) =>
  invoke<string>("generate_image", { prompt, size, steps });
export const postToFacebook = (imagePath: string, caption: string, page?: string) =>
  invoke<string>("post_to_facebook", { imagePath, caption, page });
export const facebookInsights = (page?: string) =>
  invoke<string>("facebook_insights", { page });
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
/** Open macOS System Settings → Spoken Content to download a natural voice. */
export const openVoiceDownload = () => invoke<void>("open_voice_download");

// --- Computer access ---
export const findFiles = (query: string, scope?: string) =>
  invoke<string>("find_files", { query, scope });
export const readFile = (path: string, maxChars?: number) =>
  invoke<string>("read_file", { path, maxChars });
export const openFileCmd = (path: string) => invoke<string>("open_file", { path });
export const openApp = (name: string) => invoke<string>("open_app", { name });
export const listApps = () => invoke<string>("list_apps");
export const runAppleScript = (script: string) => invoke<string>("run_applescript", { script });
/** Curated macOS system controls: volume/mute/brightness/media/display sleep/lock. */
export const systemControl = (action: string, value?: number) =>
  invoke<string>("system_control", { action, value });
/** Send an iMessage. Pass confirm=true only after Andres approves recipient + text. */
export const sendImessage = (to: string, body: string, confirm?: boolean) =>
  invoke<string>("send_imessage", { to, body, confirm });
/** Read recent iMessage/SMS history (optionally filtered to one contact). Read-only. */
export const readImessage = (contact?: string, limit?: number) =>
  invoke<string>("read_imessage", { contact, limit });
/** Run a shell command. Hard deny-list + confirm=true gate (set only after Andres approves). */
export const runShell = (command: string, confirm?: boolean) =>
  invoke<string>("run_shell", { command, confirm });
/** Curated Google Chrome controls (open_url, current_url, list_tabs, read_page, click_text, run_js). */
export const browserControl = (action: string, target?: string, text?: string) =>
  invoke<string>("browser_control", { action, target, text });
/** Watch a video (URL or local path): transcribe it, return transcript + metadata to analyze. */
export const watchVideo = (source: string, question?: string) =>
  invoke<string>("watch_video", { source, question });

// --- MCP (Model Context Protocol) servers ---
export interface McpToolInfo {
  server: string;
  name: string;
  description: string;
  inputSchema: unknown;
}
/** Discover the tools exposed by every enabled MCP server (spawns each briefly). */
export const mcpListTools = () =>
  invoke<{ tools: McpToolInfo[]; errors: string[] }>("mcp_list_tools");
/** Call a tool on a configured MCP server; returns the tool's text output. */
export const mcpCallTool = (server: string, tool: string, args: unknown) =>
  invoke<string>("mcp_call_tool", { server, tool, args });
/** Settings "Test" — probe one (possibly unsaved) server and report its tools. */
export const mcpProbe = (server: McpServer) => invoke<string>("mcp_probe", { server });

// --- History sync (optional Supabase mirror) ---
export const saveMessage = (
  conversationId: string,
  role: string,
  content: string,
  messageId: string
) => invoke<void>("save_message", { conversationId, role, content, messageId });
export const fetchMessages = (conversationId: string, limit?: number) =>
  invoke<{ role: string; content: string; created_at?: string }[]>(
    "fetch_messages",
    { conversationId, limit }
  );
/** Conversations created on ANY device (cloud history). Merge with listConversations()
 *  by id for a unified, cross-device recent-chats list. [] when sync isn't configured. */
export const fetchConversations = (limit?: number) =>
  invoke<ConvSummary[]>("fetch_conversations", { limit });
/** Fetch all conversations for a given date as raw JSON for brain enrichment.
 *  Returns "{}" when sync isn't configured. Date defaults to today when omitted. */
export const fetchDailyDigest = (date?: string) =>
  invoke<string>("fetch_daily_digest", { date: date ?? "" });

// --- On-device training corpus (local-only; never synced) ---
/** One captured turn appended to the daily trajectory shard. Mirrors the Rust
 *  `Trajectory` struct (src-tauri/src/trajectory.rs). */
export interface TrajectoryRecord {
  schema_version: number;
  conversation_id: string;
  turn_id: string;
  created_at: string;
  model_id: string;
  task_type: string;
  routed: boolean;
  user: string;
  messages: unknown[];
  tool_events: { round: number; name: string; arguments: string; ok: boolean }[];
  tools_used: string[];
  rounds: number;
  final_answer: string;
  rating: number | null;
  /** Provenance: "live" | "synthetic" | "distilled". Live capture sends "live". */
  source: string;
}
/** Append one completed turn to today's local training shard. Best-effort. */
export const saveTrajectory = (trajectory: TrajectoryRecord) =>
  invoke<void>("save_trajectory", { trajectory });
/** Attach a thumbs rating (-1/1) to an already-captured turn (the KTO label). */
export const rateTrajectory = (turnId: string, rating: -1 | 1) =>
  invoke<void>("rate_trajectory", { turnId, rating });

export interface Count {
  name: string;
  count: number;
}
export interface TrajectoryStats {
  total: number;
  by_source: Count[];
  by_task: Count[];
  by_tool: Count[];
  by_day: Count[];
  ratings: { up: number; down: number; unrated: number };
  live: number;
  rated_live: number;
}
export interface TrainingRun {
  started_at: string;
  mode: string;
  base_model: string;
  iters: number;
  examples: number;
  eval_before: number | null;
  eval_after: number | null;
  adapter_path: string;
  status: string;
}
export interface Readiness {
  ready: boolean;
  new_live: number;
  new_rated: number;
  live_threshold: number;
  rated_threshold: number;
  last_trained: string | null;
}
/** Is enough new real data captured since the last run to be worth training? */
export const trainingReadiness = () => invoke<Readiness>("training_readiness");

/** Aggregate the local trajectory corpus (what we'd train on). */
export const trajectoryStats = () => invoke<TrajectoryStats>("trajectory_stats");
/** The log of training runs, newest first (when we've trained). */
export const listTrainingRuns = () => invoke<TrainingRun[]>("list_training_runs");

// --- Local conversation store (durable "recent chats") ---
export interface ConvSummary {
  id: string;
  title: string;
  updated_at: string;
  message_count: number;
}
export const listConversations = () => invoke<ConvSummary[]>("list_conversations");
export const getConversation = (conversationId: string) =>
  invoke<{ role: string; content: string; ts: string }[]>("get_conversation", { conversationId });
export const appendTurn = (conversationId: string, role: string, content: string) =>
  invoke<void>("append_turn", { conversationId, role, content });
/** Cache a (cloud+local) merged conversation into the local store so it survives
 *  offline and appears in recent chats. Replaces the conversation's messages. */
export const replaceConversation = (
  conversationId: string,
  title: string,
  messages: { role: string; content: string; ts: string }[]
) => invoke<void>("replace_conversation", { conversationId, title, messages });
// Cross-machine: pushes the turn to the brain-daemon (no-op when no daemon configured).
export const pushChat = (conversationId: string, title: string, role: string, content: string) =>
  invoke<void>("push_chat", { conversationId, title, role, content });
export const deleteConversation = (conversationId: string) =>
  invoke<void>("delete_conversation", { conversationId });

// --- Kanban task board (per-conversation, persisted in task_boards.json) ---
/** Load a conversation's board, or null if it has never had one. */
export const getTaskBoard = (conversationId: string) =>
  invoke<TaskBoard | null>("get_task_board", { conversationId });
/** Overwrite a conversation's board with the full task list. Rejects (throws)
 *  when a card is done without evidence or blocked without a blocker. */
export const setTaskBoard = (conversationId: string, tasks: TaskInput[]) =>
  invoke<TaskBoard>("set_task_board", { conversationId, tasks });
/** Remove a conversation's board entirely (user abandoned the plan). */
export const clearTaskBoard = (conversationId: string) =>
  invoke<void>("clear_task_board", { conversationId });
export interface BoardSummary {
  conversation_id: string;
  updated_at: string;
  total: number;
  todo: number;
  in_progress: number;
  done: number;
  blocked: number;
}
export const listTaskBoards = () => invoke<BoardSummary[]>("list_task_boards");
