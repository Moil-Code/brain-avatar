import { resolveEndpoint } from "./llm";
import {
  brainPage,
  brainSearch,
  calendarCreate,
  calendarDelete,
  calendarEvents,
  calendarUpdate,
  createTeamsMeeting,
  fetchUrl,
  findFiles,
  listApps,
  llmComplete,
  openApp,
  openFileCmd,
  readFile,
  runAppleScript,
  webSearch,
} from "./tauri";
import type { AvatarState, ChatMessage, Settings } from "./types";

const MAX_ROUNDS = 5;

/** Heuristic: does this query warrant the slower, deeper model (Gemma) vs the fast one? */
function isDeepQuery(text: string): boolean {
  if (text.length > 240) return true;
  return /\b(analy[sz]e|deep dive|in.?depth|thorough|strateg|draft|compose|write (me )?an? |essay|report|compare|synthesi|brainstorm|plan out)\b/i.test(
    text
  );
}

export const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "brain_page",
      description:
        "Get the AUTHORITATIVE, up-to-date compiled brain page for a specific named entity — " +
        "a person, company/org, project, or concept. ALWAYS use this (not brain_search) for " +
        "'who is X', 'what is X', 'tell me about X', or X's role/status/latest. Pass just the " +
        "entity's name (e.g. 'Jacob Oluwole', 'Alloy ATX'). Returns the current canonical " +
        "summary — far fresher and more accurate than raw meeting transcripts.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The entity's name (person, org, project, or concept)" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "brain_search",
      description:
        "Hybrid search across Andres' brain for BROAD or CONTEXTUAL questions not about one " +
        "named entity (e.g. 'what are my open commitments', 'recent marketing discussions'). " +
        "For a specific person/company/project/concept by name, prefer brain_page instead.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language search query" },
          limit: { type: "integer", description: "Max results (default 5)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar_events",
      description:
        "Read Andres' Microsoft 365 calendar. Returns upcoming events, each with an 'id' you " +
        "need for calendar_update/calendar_delete. Use for schedule, availability, conflict " +
        "checks, or 'what's on today/this week'.",
      parameters: {
        type: "object",
        properties: {
          days: {
            type: "integer",
            description: "How many days ahead to include from today (1 = today only, 7 = this week)",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar_create",
      description:
        "Create a calendar event on Andres' Microsoft 365 calendar. Set is_teams=true to make it " +
        "a real Microsoft Teams meeting (returns a join link). List attendee emails to email them " +
        "an invite. Times are local ISO without timezone suffix, e.g. '2026-06-17T10:00:00'. " +
        "Always CONFIRM the details (title, time, attendees, Teams yes/no) with Andres before calling.",
      parameters: {
        type: "object",
        properties: {
          subject: { type: "string" },
          start: { type: "string", description: "Local start, e.g. 2026-06-17T10:00:00" },
          end: { type: "string", description: "Local end, e.g. 2026-06-17T10:30:00" },
          time_zone: { type: "string", description: "Windows tz name, default 'Central Standard Time'" },
          attendees: { type: "array", items: { type: "string" }, description: "Attendee email addresses" },
          is_teams: { type: "boolean", description: "Make it a Teams online meeting" },
          location: { type: "string" },
          body: { type: "string", description: "Event description/notes" },
        },
        required: ["subject", "start", "end"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar_update",
      description:
        "Update an existing calendar event by id (from calendar_events). Use to make an event a " +
        "Teams meeting (is_teams=true), change its time, title, or location. Confirm with Andres first.",
      parameters: {
        type: "object",
        properties: {
          event_id: { type: "string" },
          subject: { type: "string" },
          start: { type: "string" },
          end: { type: "string" },
          time_zone: { type: "string" },
          is_teams: { type: "boolean" },
          location: { type: "string" },
        },
        required: ["event_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar_delete",
      description:
        "Delete a calendar event by id (from calendar_events). Always confirm with Andres before deleting.",
      parameters: {
        type: "object",
        properties: { event_id: { type: "string" } },
        required: ["event_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_teams_meeting",
      description:
        "Create a standalone Teams meeting (not on the calendar) and get its join link. Works even " +
        "without calendar-write permission. Times are ISO with offset, e.g. '2026-06-17T10:00:00-05:00'.",
      parameters: {
        type: "object",
        properties: {
          subject: { type: "string" },
          start: { type: "string", description: "e.g. 2026-06-17T10:00:00-05:00" },
          end: { type: "string", description: "e.g. 2026-06-17T10:30:00-05:00" },
        },
        required: ["subject", "start", "end"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the public web for general or current information NOT specific to Moil or " +
        "Andres' personal data. Only use when the brain is unlikely to have the answer.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Web search query" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description:
        "Open and read the text of a specific web page (a URL, e.g. from web_search results). " +
        "Use to actually read an article/page, not just search. Returns the page's readable text.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "The page URL to read" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_files",
      description:
        "Find files on Andres' Mac by name or content using Spotlight. Use for 'find my X', " +
        "'where is the Y file', 'do I have a doc about Z'. Returns matching file paths.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to search for (name or content)" },
          scope: { type: "string", description: "Optional folder to limit the search to, e.g. ~/Documents" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the text content of a file (txt, md, Word, RTF, HTML, PDF). Use when asked to " +
        "read a file, read it aloud, or summarize/answer questions about a specific file. " +
        "Pass the full path (from find_files). To read a file ALOUD, read it then reply with " +
        "its content so it can be spoken.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Full path to the file" },
          max_chars: { type: "integer", description: "Max characters to read (default 8000)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_file",
      description:
        "Open a file or folder in its default macOS app (e.g. open a PDF, doc, image, or app). " +
        "Use when Andres asks to open something.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Full path to open" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_app",
      description: "Launch or switch to a Mac application by name (e.g. 'Notes', 'Spotify', 'Calendar').",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Application name" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_apps",
      description: "List the applications installed on Andres' Mac (to know what can be opened/controlled).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "run_applescript",
      description:
        "Control a Mac app by running AppleScript — e.g. create a Note, add a Reminder/Calendar " +
        "event, get the current Safari URL, control Music. The FIRST time you control a given app, " +
        "macOS asks Andres to allow it (that's expected). For actions that SEND, post, delete, or " +
        "message on his behalf, confirm with Andres in your reply BEFORE running it.",
      parameters: {
        type: "object",
        properties: { script: { type: "string", description: "The AppleScript source to run" } },
        required: ["script"],
      },
    },
  },
];

async function executeTool(name: string, argsJson: string): Promise<string> {
  let args: any = {};
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    /* tolerate malformed args */
  }
  try {
    switch (name) {
      case "brain_page":
        return await brainPage(String(args.name ?? args.query ?? ""));
      case "brain_search":
        return await brainSearch(String(args.query ?? ""), args.limit);
      case "calendar_events":
        return await calendarEvents(args.days);
      case "calendar_create":
        return await calendarCreate({
          subject: String(args.subject ?? ""),
          start: String(args.start ?? ""),
          end: String(args.end ?? ""),
          timeZone: args.time_zone,
          attendees: Array.isArray(args.attendees) ? args.attendees : undefined,
          isTeams: Boolean(args.is_teams),
          location: args.location,
          body: args.body,
        });
      case "calendar_update":
        return await calendarUpdate({
          eventId: String(args.event_id ?? ""),
          subject: args.subject,
          start: args.start,
          end: args.end,
          timeZone: args.time_zone,
          isTeams: typeof args.is_teams === "boolean" ? args.is_teams : undefined,
          location: args.location,
        });
      case "calendar_delete":
        return await calendarDelete(String(args.event_id ?? ""));
      case "create_teams_meeting":
        return await createTeamsMeeting(
          String(args.subject ?? ""),
          String(args.start ?? ""),
          String(args.end ?? "")
        );
      case "web_search":
        return await webSearch(String(args.query ?? ""));
      case "fetch_url":
        return await fetchUrl(String(args.url ?? ""));
      case "find_files":
        return await findFiles(String(args.query ?? ""), args.scope ? String(args.scope) : undefined);
      case "read_file":
        return await readFile(String(args.path ?? ""), args.max_chars);
      case "open_file":
        return await openFileCmd(String(args.path ?? ""));
      case "open_app":
        return await openApp(String(args.name ?? ""));
      case "list_apps":
        return await listApps();
      case "run_applescript":
        return await runAppleScript(String(args.script ?? ""));
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (e) {
    return `Tool ${name} failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export interface RunAgentOpts {
  userText: string;
  history: ChatMessage[];
  settings: Settings;
  onState?: (s: AvatarState) => void;
  onToken?: (delta: string) => void;
  onToolStart?: (name: string) => void;
  signal?: AbortSignal;
}

export interface RunAgentResult {
  content: string;
  tools: string[];
}

/** Run the full tool-calling loop and return the final grounded answer. */
export async function runAgent(opts: RunAgentOpts): Promise<RunAgentResult> {
  const { userText, history, settings, onState, onToken, onToolStart, signal } = opts;
  onState?.("thinking");

  const endpoint = await resolveEndpoint(settings, { preferDeep: isDeepQuery(userText) });

  const messages: ChatMessage[] = [
    { role: "system", content: settings.system_prompt },
    ...history,
    { role: "user", content: userText },
  ];

  const toolsUsed: string[] = [];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (signal?.aborted) throw new Error("aborted");
    const res = await llmComplete(
      endpoint.baseUrl,
      endpoint.token,
      endpoint.model,
      messages,
      TOOL_DEFS,
      settings.max_tokens
    );
    const content = res.content ?? "";
    const toolCalls = Array.isArray(res.tool_calls) ? res.tool_calls : [];

    if (toolCalls.length === 0) {
      const answer = content.trim();
      onToken?.(answer);
      return { content: answer, tools: toolsUsed };
    }

    // Record the assistant's tool-call message, then run each tool.
    messages.push({ role: "assistant", content, tool_calls: toolCalls });
    for (const tc of toolCalls) {
      onToolStart?.(tc.function.name);
      if (!toolsUsed.includes(tc.function.name)) toolsUsed.push(tc.function.name);
      const result = await executeTool(tc.function.name, tc.function.arguments);
      messages.push({
        role: "tool",
        tool_call_id: tc.id || tc.function.name,
        name: tc.function.name,
        content: result,
      });
    }
    onState?.("thinking");
  }

  // Exhausted tool rounds — make one final answer attempt without tools.
  const final = await llmComplete(
    endpoint.baseUrl,
    endpoint.token,
    endpoint.model,
    messages,
    undefined,
    settings.max_tokens
  );
  const answer = (final.content ?? "").trim();
  onToken?.(answer);
  return { content: answer, tools: toolsUsed };
}
