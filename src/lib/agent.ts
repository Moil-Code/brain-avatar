import { resolveBaseEndpoint } from "./llm";
import { isTrivialChat, missingInput, routeTask, type Route } from "./router";
import {
  brainPage,
  brainSearch,
  calendarCreate,
  calendarDelete,
  calendarEvents,
  calendarUpdate,
  createReminder,
  createTeamsMeeting,
  emailDetails,
  listAttachments,
  readAttachment,
  replyEmail,
  emailAction,
  fetchDailyDigest,
  fetchUrl,
  generateImage,
  webTask,
  postToFacebook,
  findFiles,
  listApps,
  llmComplete,
  openApp,
  openFileCmd,
  readEmails,
  readTeams,
  readFile,
  runAppleScript,
  systemControl,
  sendImessage,
  readImessage,
  runShell,
  browserControl,
  watchVideo,
  sendEmail,
  sendTeamsMessage,
  webSearch,
  xBookmarks,
  facebookInsights,
} from "./tauri";
import {
  describeSchedule,
  loadAutomations,
  makeAutomation,
  summarizeAutomations,
  upsertAutomation,
} from "./automations";
import { clearTaskBoard, getTaskBoard, setTaskBoard } from "./tauri";
import { mcpCallTool, mcpListTools, type McpToolInfo } from "./tauri";
import {
  detectNarration,
  estimateTaskCount,
  isMultiTask,
  openCardCount,
  renderBoardSnapshot,
  validateEvidence,
} from "./kanban";
import type {
  Attachment,
  AutomationSchedule,
  AvatarState,
  ChatMessage,
  Settings,
  TaskBoard,
  TaskCard,
  TaskInput,
  ToolCall,
  UiStep,
} from "./types";

// Round budget scales with task count: 5 rounds only covers a ~2-task request,
// which is what let the TEDC multi-task request run out of rounds mid-plan.
const BASE_ROUNDS = 5;
// Headroom matters: a small local model burns rounds on retries, nudges, and
// re-sends, so budget generously above the raw task count (cap keeps it bounded).
const MAX_ROUNDS_CAP = 20;

// The board protocol is injected as a dedicated system message every multi-task
// turn — NOT baked into settings.system_prompt, because users customize that and
// existing installs never get the update. The worked example (literal cards array)
// is what keeps decompose reliable on small models (measured 1/5 -> 5/5).
const BOARD_PROTOCOL =
  "TASK BOARD PROTOCOL — when a request has multiple steps (3+ actions, a numbered/bulleted list, " +
  "or 'do A, then B, then C'):\n" +
  "1. FIRST call manage_tasks to create one card per task — the FIRST card status 'in_progress', the rest 'todo'.\n" +
  "2. Then do the work with real tools. The board advances as you go; mark each card 'done' (with an 'evidence' " +
  "field naming the tool you used) and set the next card 'in_progress' when you can. Always re-send the COMPLETE card list.\n" +
  "3. Only give your final prose answer once every card is done or blocked. Never write the plan in prose.\n" +
  'EXAMPLE — user: "pull Josh, summarize the deck, email Maria": your FIRST action is manage_tasks with cards: ' +
  '[{"title":"Pull Josh","status":"in_progress"},{"title":"Summarize deck","status":"todo"},' +
  '{"title":"Email Maria","status":"todo"}]. Then call brain_page, then manage_tasks marking card 1 done with ' +
  "evidence, and so on until all are done.";

// Injected EVERY turn as its own system message — NOT baked into settings.system_prompt,
// because users customize that and existing installs never get prompt updates (same
// reasoning as BOARD_PROTOCOL). This keeps the model aware of the newer tools regardless
// of a stale saved prompt — it's why "find my last text" was wrongly refused as
// "I can't access SMS" when read_imessage was right there.
const CAPABILITIES_NOTE: ChatMessage = {
  role: "system",
  content:
    "You DO have these tools — never claim you can't do them; call the tool instead:\n" +
    "• read_imessage / send_imessage — read and send iMessage/SMS via Messages. For 'find/read my " +
    "texts', 'my last text message', 'what did X text me', use read_imessage (NOT Teams/email).\n" +
    "• browser_control — drive Google Chrome: open_url, current_url, list_tabs, read_page, click_text, run_js.\n" +
    "• run_shell — run a shell command on the Mac for anything the dedicated tools don't cover.\n" +
    "• watch_video — transcribe and analyze a video from a URL or local file path.\n" +
    "• plus any tools from connected MCP servers (shown alongside the built-ins).\n" +
    "• ask_user — when a request is missing something you NEED (a video/link URL, which file, a " +
    "recipient, a date), call ask_user with one specific question and stop. Don't guess, don't build " +
    "a task board around the gap, don't do partial work — ask first.\n" +
    "Confirm before send_imessage, run_shell, and page-mutating browser actions (click_text/run_js).",
};

function basename(p?: string): string {
  if (!p) return "";
  return p.split("/").filter(Boolean).pop() ?? p;
}
function shortUrl(u?: string): string {
  if (!u) return "the link";
  const s = u.replace(/^https?:\/\//, "").replace(/^www\./, "");
  return s.length > 42 ? s.slice(0, 42) + "…" : s;
}

/** A human, present-tense description of what a tool call is doing — for the step feed. */
function toolStepLabel(name: string, a: any): string {
  switch (name) {
    case "read_emails":
      return "Reading your inbox";
    case "read_teams":
      return "Checking your Teams chats";
    case "email_details":
      return a.query ? `Opening the “${a.query}” email` : "Opening the email";
    case "list_attachments":
      return "Checking the email's attachments";
    case "read_attachment":
      return a.name ? `Reading the attachment “${a.name}”` : "Reading the attachment";
    case "reply_email":
      return "Preparing the reply";
    case "email_action":
      return a.action ? `Email: ${String(a.action).replace(/_/g, " ")}` : "Updating the email";
    case "brain_page":
      return `Looking up ${a.name ?? a.query ?? "your brain"}`;
    case "brain_search":
      return a.query ? `Searching your brain for “${a.query}”` : "Searching your brain";
    case "calendar_events":
      return "Checking your calendar";
    case "calendar_create":
      return "Creating the event";
    case "calendar_update":
      return "Updating the event";
    case "calendar_delete":
      return "Deleting the event";
    case "create_teams_meeting":
      return "Setting up the Teams meeting";
    case "generate_image":
      return a.prompt ? `Painting “${a.prompt}”` : "Generating an image";
    case "post_to_facebook":
      return `Posting to Facebook (${a.page ?? "moil"})`;
    case "facebook_insights":
      return `Pulling Facebook metrics (${a.page ?? "moil"})`;
    case "create_automation":
      return a.name ? `Setting up automation: ${a.name}` : "Setting up an automation";
    case "list_automations":
      return "Listing your automations";
    case "x_bookmarks":
      return "Fetching your X bookmarks";
    case "web_search":
      return a.query ? `Searching the web for “${a.query}”` : "Searching the web";
    case "web_task":
      return a.intent ? `Browser: ${String(a.intent).slice(0, 40)}…` : "Working in the browser";
    case "fetch_url":
      return `Opening ${shortUrl(a.url)}`;
    case "find_files":
      return a.query ? `Finding files: “${a.query}”` : "Searching your files";
    case "read_file":
      return `Reading ${basename(a.path)}`;
    case "open_file":
      return `Opening ${basename(a.path)}`;
    case "open_app":
      return `Opening ${a.name ?? "the app"}`;
    case "list_apps":
      return "Listing your apps";
    case "run_applescript":
      return "Controlling the app";
    case "send_imessage":
      return a.to ? `Texting ${a.to}` : "Sending an iMessage";
    case "read_imessage":
      return a.contact ? `Reading messages with ${a.contact}` : "Reading recent messages";
    case "run_shell":
      return a.command ? `Running: ${String(a.command).slice(0, 40)}…` : "Running a shell command";
    case "browser_control": {
      const map: Record<string, string> = {
        open_url: a.target ? `Opening ${shortUrl(a.target)} in Chrome` : "Opening Chrome",
        current_url: "Checking the active tab",
        active_tab: "Checking the active tab",
        list_tabs: "Listing Chrome tabs",
        read_page: "Reading the page",
        read_page_text: "Reading the page",
        click_text: a.target ? `Clicking “${a.target}”` : "Clicking in Chrome",
        run_js: "Running JavaScript in Chrome",
      };
      return map[String(a.action)] ?? "Controlling Chrome";
    }
    case "watch_video":
      return a.source || a.url ? `Watching ${shortUrl(a.source ?? a.url)}` : "Watching the video";
    case "system_control": {
      const map: Record<string, string> = {
        volume_get: "Checking the volume",
        volume_set: "Setting the volume",
        volume_up: "Turning the volume up",
        volume_down: "Turning the volume down",
        mute: "Muting system audio",
        unmute: "Unmuting system audio",
        brightness_up: "Raising brightness",
        brightness_down: "Lowering brightness",
        media_playpause: "Play/pausing media",
        media_next: "Skipping to next track",
        media_prev: "Going to previous track",
        media_previous: "Going to previous track",
        sleep_display: "Putting the display to sleep",
        lock_screen: "Locking the screen",
      };
      return map[String(a.action)] ?? "Adjusting a system setting";
    }
    case "send_email":
      return "Preparing the email";
    case "create_reminder":
      return "Adding the reminder";
    case "send_teams_message":
      return "Preparing the Teams message";
    case "manage_tasks":
      return "Updating the task board";
    case "fetch_daily_conversations":
      return a.date ? `Fetching conversations for ${a.date}` : "Fetching today's conversations";
    default: {
      const mcp = mcpRouting.get(name);
      if (mcp) return `Using ${mcp.server}: ${mcp.tool}`;
      return name;
    }
  }
}

// --- Dynamic MCP tools ------------------------------------------------------
// Tools from configured MCP servers are discovered at runtime and merged into
// the list handed to the model — so adding a server adds capabilities with no
// code change. `mcpRouting` maps the (sanitized) function name the model emits
// back to the server+tool it came from, so executeTool can dispatch it.
let mcpToolDefs: any[] = [];
const mcpRouting = new Map<string, { server: string; tool: string }>();
let mcpLoadedAt = 0;
const MCP_TTL_MS = 60_000;

/** OpenAI function names must match /^[A-Za-z0-9_-]{1,64}$/ — sanitize and cap. */
function mcpFnName(server: string, tool: string): string {
  return `mcp_${server}_${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

/** Discover MCP tools (cached briefly). Failures degrade to built-in tools only. */
async function loadMcpTools(force = false): Promise<any[]> {
  const now = Date.now();
  if (!force && mcpLoadedAt !== 0 && now - mcpLoadedAt < MCP_TTL_MS) return mcpToolDefs;
  try {
    const { tools } = await mcpListTools();
    const seen = new Set<string>();
    mcpRouting.clear();
    mcpToolDefs = tools.map((t: McpToolInfo) => {
      let fn = mcpFnName(t.server, t.name);
      // Guard against name collisions after sanitizing/truncation.
      while (seen.has(fn)) fn = fn.slice(0, 60) + Math.floor(Math.random() * 9000 + 1000);
      seen.add(fn);
      mcpRouting.set(fn, { server: t.server, tool: t.name });
      const schema =
        t.inputSchema && typeof t.inputSchema === "object"
          ? t.inputSchema
          : { type: "object", properties: {} };
      return {
        type: "function",
        function: {
          name: fn,
          description: `[${t.server}] ${t.description || t.name}`,
          parameters: schema,
        },
      };
    });
    mcpLoadedAt = now;
  } catch {
    /* MCP unavailable — fall back to built-in tools only */
  }
  return mcpToolDefs;
}

export const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "Ask Andres for a piece of information you NEED but don't have, then STOP and wait for his " +
        "reply. Use this the MOMENT a request is missing something you can't infer or look up — a " +
        "video/link URL, which of several files he means, a recipient, a date, an amount. Do NOT " +
        "guess, do NOT start a task board, and do NOT do partial work around the gap: ask first. " +
        "Pass a single, specific question. This ends your turn; he'll answer and you'll continue.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The specific thing you need from Andres, phrased as a short question.",
          },
        },
        required: ["question"],
      },
    },
  },
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
      name: "generate_image",
      description:
        "Generate an image LOCALLY from a text prompt using Bonsai. Use when Andres asks to " +
        "create/make/draw/generate an image, picture, logo, or illustration. The image is shown " +
        "to him automatically — after calling, just confirm briefly; do NOT try to describe the " +
        "pixels. Write a vivid, detailed prompt for best results.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Detailed description of the image to generate" },
          size: { type: "string", description: "WxH, default 512x512" },
          steps: { type: "integer", description: "Diffusion steps (default 4)" },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "post_to_facebook",
      description:
        "Publish an image to one of Andres' Facebook Pages: 'moil' (Moil by Jarvis) or 'jarvis_tx' " +
        "(Jarvis AI TX). Use after generate_image to post a created image — pass the image_path from " +
        "generate_image's result, a caption, and the page. THIS POSTS PUBLICLY: you MUST first show " +
        "Andres the image + caption + which page, and get his explicit 'yes' before calling. Never " +
        "post without confirmation.",
      parameters: {
        type: "object",
        properties: {
          image_path: { type: "string", description: "Full path to the image (e.g. from generate_image)" },
          caption: { type: "string", description: "The post caption/message" },
          page: { type: "string", description: "'moil' or 'jarvis_tx' (default moil)" },
        },
        required: ["image_path", "caption"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "facebook_insights",
      description:
        "Read engagement METRICS for one of Andres' Facebook Pages — follower count, " +
        "28-day reach, impressions, post engagement, and how the last few posts performed. " +
        "Use for 'how's the Facebook page doing', 'check my FB metrics', 'reach this month'. " +
        "page = 'moil' (Moil by Jarvis) or 'jarvis_tx' (Jarvis AI TX), default moil. This is " +
        "READ-ONLY (it does not post). Summarize the numbers conversationally.",
      parameters: {
        type: "object",
        properties: {
          page: { type: "string", description: "'moil' or 'jarvis_tx' (default moil)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_automation",
      description:
        "Set up a RECURRING automation — a task Brain runs ON ITS OWN on a schedule and " +
        "delivers to Andres. Use when he says 'every Monday…', 'each morning…', 'remind me " +
        "weekly to…', 'automatically check… and tell me'. The `prompt` is the instruction Brain " +
        "will run each time, written as if Andres asked it live (e.g. 'Check my Facebook metrics " +
        "for the moil page and summarize what changed this week'). Pick schedule_kind: 'daily' " +
        "(needs time), 'weekly' (needs weekday 0=Sun..6=Sat and time), 'hourly' (needs minute), " +
        "or 'interval' (needs every_minutes). time is 24h 'HH:MM' local. deliver is how the result " +
        "reaches him: any of 'notify','speak','email','brain' (default notify+speak). Confirm the " +
        "schedule and what it will do with Andres, then call this.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short label, e.g. 'Weekly FB metrics'" },
          prompt: {
            type: "string",
            description: "The instruction Brain runs each time (a full natural-language request)",
          },
          schedule_kind: {
            type: "string",
            description: "'daily' | 'weekly' | 'hourly' | 'interval'",
          },
          time: { type: "string", description: "Local 24h time 'HH:MM' (daily/weekly)" },
          weekday: { type: "integer", description: "0=Sunday .. 6=Saturday (weekly)" },
          minute: { type: "integer", description: "Minute of the hour 0-59 (hourly)" },
          every_minutes: { type: "integer", description: "Run every N minutes (interval)" },
          deliver: {
            type: "array",
            items: { type: "string" },
            description: "Channels: 'notify','speak','email','brain' (default ['notify','speak'])",
          },
        },
        required: ["name", "prompt", "schedule_kind"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_automations",
      description:
        "List the recurring automations Brain currently has set up (name, schedule, on/off, " +
        "delivery). Use for 'what automations do I have', 'what are you running for me'.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "x_bookmarks",
      description:
        "Get Andres' most recent X (Twitter) bookmarks. Use for 'my bookmarks', 'my last N " +
        "X/Twitter bookmarks', 'what did I bookmark'. Returns each bookmark's author, text, tweet " +
        "URL, and any outbound article links. To 'actually read' a bookmark before summarizing, " +
        "call fetch_url on its link(s), then summarize. If the result says it's not activated, " +
        "relay the activation steps to Andres.",
      parameters: {
        type: "object",
        properties: {
          count: { type: "integer", description: "How many recent bookmarks (default 5, max 25)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the public web (Brave) for general or current information NOT specific to Moil or " +
        "Andres' personal data. This is the PRIMARY web-lookup tool — use it FIRST for anything you'd " +
        "'look something up online' for, then fetch_url to read a specific result. Only skip it when " +
        "the brain clearly already has the answer.",
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
      name: "web_task",
      description:
        "Drive a REAL logged-in browser to do a web task: log into a site, navigate it, " +
        "read an authenticated page, fill a form, click through a flow. Use this for anything that " +
        "needs a real session — especially 'log into moilapp.com', 'open my Moil dashboard' — OR as a " +
        "FALLBACK when web_search is unavailable or didn't find it. For plain public lookups prefer " +
        "web_search + fetch_url (faster and lighter). fetch_url only gets public page text and can't " +
        "log in. Pass a clear, specific natural-language instruction including the site/URL. " +
        "Sites Andres logged into once stay logged in. If the result mentions a login wall, tell him " +
        "to run the one-time login. For any task that POSTS/SUBMITS/sends, confirm with Andres first.",
      parameters: {
        type: "object",
        properties: {
          intent: {
            type: "string",
            description: "The browser task, e.g. 'Log into moilapp.com and read my dashboard'",
          },
        },
        required: ["intent"],
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
  {
    type: "function",
    function: {
      name: "system_control",
      description:
        "Control the Mac's SYSTEM settings reliably. Use this (not run_applescript) for: " +
        "volume ('turn it down/up', 'set volume to 30', 'how loud is it', 'mute'/'unmute' — this " +
        "mutes the WHOLE Mac, not just the avatar's voice), screen brightness, media playback " +
        "(play/pause, next/previous track in Spotify or Music), putting the display to sleep, and " +
        "locking the screen. Pick the matching `action`. For volume_set pass `value` 0–100; for " +
        "volume_up/volume_down `value` is the optional step (default 10). Confirm before " +
        "sleep_display or lock_screen.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description:
              "One of: volume_get, volume_set, volume_up, volume_down, mute, unmute, " +
              "brightness_up, brightness_down, media_playpause, media_next, media_prev, " +
              "sleep_display, lock_screen",
          },
          value: {
            type: "integer",
            description: "For volume_set: 0–100. For volume_up/volume_down: step size (default 10).",
          },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_imessage",
      description:
        "Send an iMessage/SMS to a phone number or Apple ID email via Messages. Use for 'text X', " +
        "'iMessage X', 'send a message to X'. This MESSAGES on Andres' behalf: FIRST show him the " +
        "recipient and exact text and get his explicit 'yes', THEN call again with confirm=true. " +
        "Calling without confirm=true returns a confirmation prompt instead of sending.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Phone number (e.g. +15125551234) or Apple ID email" },
          body: { type: "string", description: "The message text" },
          confirm: { type: "boolean", description: "Set true ONLY after Andres approves; otherwise omit" },
        },
        required: ["to", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_imessage",
      description:
        "Read Andres' recent iMessage/SMS history from the Messages database. Use for 'what did X " +
        "text me', 'read my messages', 'my last texts with X'. Pass `contact` (a phone number or " +
        "email substring) to filter to one person, or omit it for the most recent across everyone. " +
        "Read-only; needs Full Disk Access.",
      parameters: {
        type: "object",
        properties: {
          contact: { type: "string", description: "Optional phone/email substring to filter by" },
          limit: { type: "integer", description: "How many recent messages (default 20, max 50)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      description:
        "Run a shell command on Andres' Mac (zsh/sh via /bin/sh -c). This is the broad 'do almost " +
        "anything on the Mac' tool — use it for tasks the dedicated tools don't cover (file ops, git, " +
        "scripts, CLI utilities). A hard safety deny-list blocks destructive/credential commands no " +
        "matter what. Because it is powerful, it is CONFIRM-GATED: call it FIRST without confirm to " +
        "get back the exact command, show that to Andres, get his explicit 'yes', then call again with " +
        "confirm=true. NEVER set confirm=true on your own. Output (stdout+stderr) is returned, capped.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to run" },
          confirm: { type: "boolean", description: "Set true ONLY after Andres approves; otherwise omit" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_control",
      description:
        "Control Andres' actual Google Chrome. Use for 'open X in Chrome', 'what tab am I on', " +
        "'read this page', 'click the X button/link', 'list my tabs'. `action` is one of: " +
        "open_url (needs target=URL), current_url, list_tabs, read_page (returns the active tab's " +
        "visible text), click_text (needs target=the visible link/button text), run_js (needs " +
        "text=JavaScript — advanced). read_page/current_url/list_tabs are read-only; click_text and " +
        "run_js act on the page, so Andres is asked to approve them first.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "open_url | current_url | list_tabs | read_page | click_text | run_js",
          },
          target: { type: "string", description: "URL (open_url) or visible text to click (click_text)" },
          text: { type: "string", description: "JavaScript source (run_js)" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "watch_video",
      description:
        "Watch and analyze a video by transcribing its audio — use for 'summarize this YouTube " +
        "video', 'what does this video say', 'watch this and tell me X'. `source` is a video URL " +
        "(YouTube, etc.) or a local file path. Optionally pass `question` to answer something " +
        "specific; otherwise it summarizes. Returns the transcript for you to analyze, so base your " +
        "answer on it. (Online videos need yt-dlp; local files need ffmpeg.)",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "Video URL or local file path" },
          question: { type: "string", description: "Optional specific question about the video" },
        },
        required: ["source"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_emails",
      description:
        "Read Andres' most recent inbox emails (sender, subject, date, preview). Use for 'read/" +
        "check/summarize my emails', 'any new email from X', 'what's in my inbox'.",
      parameters: {
        type: "object",
        properties: {
          count: { type: "integer", description: "How many recent emails (default 10, max 25)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_teams",
      description:
        "Check Andres' UNREAD Microsoft Teams chat messages (chat/topic, sender, preview, time). Use " +
        "for 'any unread messages in my team chats', 'do I have new Teams messages', 'what's unread on " +
        "Teams', 'check my team chats'. Returns only unread chats, newest first.",
      parameters: {
        type: "object",
        properties: {
          count: { type: "integer", description: "How many recent chats to scan (default 20, max 50)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "email_details",
      description:
        "Find and open ONE specific email — its FULL body and the links inside it. ALWAYS use this " +
        "(not read_emails) to find an email FROM a person or about a topic. To find the latest email " +
        "from someone, pass JUST THEIR NAME (e.g. 'Tonya'); it searches ALL mail by sender — including " +
        "older messages not in the recent list — and ignores Andres' own self-sent 'Brain Briefing' " +
        "emails. You can also pass a subject or keyword. read_emails only shows the most recent inbox " +
        "and will MISS emails pushed down the list — prefer email_details when looking for a specific one. " +
        "After it returns, use fetch_url on a link to read where it goes.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Sender, subject, or keyword identifying the email (e.g. 'BudaEDC')",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_attachments",
      description:
        "List the attachments on a specific email (name, type, size). Identify the email with a " +
        "natural-language query — the sender's name, subject, or a keyword (e.g. 'Monica Davidson'). " +
        "Use when an email mentions a document, or read_emails/email_details showed a 📎.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Sender, subject, or keyword identifying the email" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_attachment",
      description:
        "Read the TEXT of an email attachment (Word, PDF, RTF, HTML, or text). This is how you read " +
        "the actual content when it lives in an attached document, not the email body. Identify the " +
        "email with `query` (sender/subject/keyword); optionally pass `name` to pick a specific " +
        "attachment (substring is fine) — otherwise the first readable document is read. Often the " +
        "real details (a program, proposal, contract) are in the attachment, so reach for this.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Sender, subject, or keyword identifying the email" },
          name: { type: "string", description: "Optional: which attachment to read (name substring)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reply_email",
      description:
        "Reply IN-THREAD to an email (keeps the conversation, unlike send_email which starts a new " +
        "one). Identify the email with `query` (sender/subject/keyword); `body` is your reply text; " +
        "set reply_all=true to reply to everyone. ALWAYS confirm the recipient and wording with " +
        "Andres before calling.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Sender, subject, or keyword identifying the email" },
          body: { type: "string", description: "The reply message text" },
          reply_all: { type: "boolean", description: "Reply to all recipients (default false)" },
        },
        required: ["query", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "email_action",
      description:
        "Triage an email: mark_read, mark_unread, flag, unflag, archive, or delete (delete = move to " +
        "Deleted Items). Identify the email with `query` (sender/subject/keyword). Confirm with Andres " +
        "before archive/delete. (Mutating actions may need the Mail.ReadWrite scope; it'll say so if not.)",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Sender, subject, or keyword identifying the email" },
          action: {
            type: "string",
            description: "mark_read | mark_unread | flag | unflag | archive | delete",
          },
        },
        required: ["query", "action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_email",
      description:
        "Send an email from Andres' Microsoft 365 account. CONFIRM recipients, subject, and body " +
        "with Andres before sending.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "array", items: { type: "string" }, description: "Recipient email addresses" },
          subject: { type: "string" },
          body: { type: "string", description: "Email body (HTML or plain text)" },
          cc: { type: "array", items: { type: "string" } },
        },
        required: ["to", "subject", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_reminder",
      description:
        "Add a reminder/task to Andres' Microsoft To Do. due/remind_at are local ISO datetimes " +
        "like '2026-06-18T09:00:00'.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          due: { type: "string", description: "Optional due datetime" },
          remind_at: { type: "string", description: "Optional reminder datetime" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_teams_message",
      description:
        "Send a 1:1 Microsoft Teams chat message to someone by email. CONFIRM the recipient and " +
        "message with Andres before sending.",
      parameters: {
        type: "object",
        properties: {
          recipient_email: { type: "string" },
          message: { type: "string" },
        },
        required: ["recipient_email", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage_tasks",
      description:
        "Maintain the persistent kanban board for THIS conversation. Call this FIRST when the " +
        "request has 3+ steps, is numbered/bulleted, or says 'do A and then B'. Pass the COMPLETE " +
        "current task list every time — this OVERWRITES the board. Status flows todo → in_progress " +
        "→ done (or blocked). Exactly ONE card may be in_progress. To mark a card done you MUST set " +
        "'evidence' referencing the non-board tool you just called THIS turn (e.g. 'send_email " +
        "returned msg_abc123'); marking done without a real tool call this round is REJECTED. Use " +
        "'blocked' with a 'blocker' string when you need Andres' input. Returns the persisted board.",
      parameters: {
        type: "object",
        properties: {
          cards: {
            type: "array",
            description: "The complete, current list of cards (overwrites the board).",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description: "Reuse an existing card's id to update it; empty string for a new card.",
                },
                title: { type: "string" },
                status: { type: "string", enum: ["todo", "in_progress", "done", "blocked"] },
                evidence: {
                  type: "string",
                  description: "REQUIRED for status='done'. Name the tool that ran this round and what it returned.",
                },
                blocker: {
                  type: "string",
                  description: "REQUIRED for status='blocked'. What is needed to unblock.",
                },
              },
              required: ["title", "status"],
            },
          },
        },
        required: ["cards"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_daily_conversations",
      description:
        "Retrieve today's (or any past date's) full conversation transcripts from the cloud " +
        "history. Returns all conversations for that date with their messages, formatted for " +
        "reading. Use this as the primary data source for the nightly brain enrichment automation — " +
        "call it first, then extract key insights (decisions, people, projects, commitments, " +
        "lessons learned) and push each new insight to gbrain with push_chat. Date defaults to today.",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "Date in YYYY-MM-DD format. Omit or leave empty for today.",
          },
        },
      },
    },
  },
];

/** Map the flat create_automation args into a typed schedule. */
function buildSchedule(args: any): AutomationSchedule {
  const kind = String(args.schedule_kind ?? "daily");
  if (kind === "weekly")
    return { kind: "weekly", weekday: Number(args.weekday ?? 1), time: String(args.time ?? "09:00") };
  if (kind === "hourly") return { kind: "hourly", minute: Number(args.minute ?? 0) };
  if (kind === "interval")
    return { kind: "interval", everyMinutes: Math.max(1, Number(args.every_minutes ?? 60)) };
  return { kind: "daily", time: String(args.time ?? "09:00") };
}

/** Build the approval request for a side-effecting call, or null if the call
 *  needs no confirmation (read-only / non-mutating). */
function confirmRequestFor(name: string, args: any): ConfirmRequest | null {
  if (name === "run_shell")
    return { tool: name, title: "Run this shell command?", detail: String(args.command ?? "") };
  if (name === "send_imessage")
    return {
      tool: name,
      title: "Send this iMessage?",
      detail: `To: ${String(args.to ?? "")}\n\n${String(args.body ?? "")}`,
    };
  if (name === "browser_control") {
    const a = String(args.action ?? "").toLowerCase();
    if (a === "click_text")
      return { tool: name, title: "Click in Chrome?", detail: `Click: “${String(args.target ?? "")}”` };
    if (a === "run_js")
      return {
        tool: name,
        title: "Run JavaScript in Chrome?",
        detail: String(args.text ?? args.target ?? ""),
      };
  }
  return null;
}

async function executeTool(
  name: string,
  argsJson: string,
  onConfirm?: (req: ConfirmRequest) => Promise<boolean>
): Promise<string> {
  let args: any = {};
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    /* tolerate malformed args */
  }

  // Hard UI gate for side-effecting local tools. When the UI provides onConfirm,
  // it is AUTHORITATIVE: we show the user the exact action and only run it on an
  // explicit approval — ignoring whatever `confirm` the model passed (so a prompt-
  // injected confirm=true can't self-approve).
  if (onConfirm) {
    const req = confirmRequestFor(name, args);
    if (req) {
      let approved = false;
      try {
        approved = await onConfirm(req);
      } catch {
        approved = false;
      }
      if (!approved) {
        return `Andres declined this action. Do not run it; ask him what he'd like instead.`;
      }
      // Shell/iMessage have a Rust-side confirm gate — pass confirm=true now that
      // he approved. Browser actions have no such arg, so fall through to dispatch.
      try {
        if (name === "run_shell") return await runShell(String(args.command ?? ""), true);
        if (name === "send_imessage")
          return await sendImessage(String(args.to ?? ""), String(args.body ?? ""), true);
      } catch (e) {
        return `Tool ${name} failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }
  // MCP tools are dynamic, so route them before the static switch.
  const mcp = mcpRouting.get(name);
  if (mcp) {
    try {
      return await mcpCallTool(mcp.server, mcp.tool, args);
    } catch (e) {
      return `Tool ${name} failed: ${e instanceof Error ? e.message : String(e)}`;
    }
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
      case "generate_image":
        return await generateImage(String(args.prompt ?? ""), args.size, args.steps);
      case "post_to_facebook":
        return await postToFacebook(
          String(args.image_path ?? ""),
          String(args.caption ?? ""),
          args.page ? String(args.page) : undefined
        );
      case "facebook_insights":
        return await facebookInsights(args.page ? String(args.page) : undefined);
      case "create_automation": {
        const dv: string[] = Array.isArray(args.deliver)
          ? args.deliver.map((x: unknown) => String(x))
          : ["notify", "speak"];
        const automation = makeAutomation({
          name: String(args.name ?? ""),
          prompt: String(args.prompt ?? ""),
          schedule: buildSchedule(args),
          delivery: {
            speak: dv.includes("speak"),
            notify: dv.includes("notify"),
            email: dv.includes("email"),
            brain: dv.includes("brain"),
          },
        });
        await upsertAutomation(automation);
        const ch =
          dv.filter((x) => ["notify", "speak", "email", "brain"].includes(x)).join(", ") ||
          "notify, speak";
        return `Automation "${automation.name}" created — runs ${describeSchedule(
          automation.schedule
        )}, delivered via ${ch}. It's active now.`;
      }
      case "list_automations":
        return summarizeAutomations(await loadAutomations());
      case "x_bookmarks":
        return await xBookmarks(args.count);
      case "web_search":
        return await webSearch(String(args.query ?? ""));
      case "web_task":
        return await webTask(String(args.intent ?? ""));
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
      case "system_control":
        return await systemControl(
          String(args.action ?? ""),
          typeof args.value === "number" ? args.value : undefined
        );
      case "send_imessage":
        return await sendImessage(
          String(args.to ?? ""),
          String(args.body ?? ""),
          typeof args.confirm === "boolean" ? args.confirm : undefined
        );
      case "read_imessage":
        return await readImessage(args.contact ? String(args.contact) : undefined, args.limit);
      case "run_shell":
        return await runShell(
          String(args.command ?? ""),
          typeof args.confirm === "boolean" ? args.confirm : undefined
        );
      case "browser_control":
        return await browserControl(
          String(args.action ?? ""),
          args.target != null ? String(args.target) : undefined,
          args.text != null ? String(args.text) : undefined
        );
      case "watch_video":
        return await watchVideo(
          String(args.source ?? args.url ?? ""),
          args.question ? String(args.question) : undefined
        );
      case "read_emails":
        return await readEmails(args.count);
      case "read_teams":
        return await readTeams(args.count);
      case "email_details":
        return await emailDetails(String(args.query ?? ""));
      case "list_attachments":
        return await listAttachments(String(args.query ?? ""));
      case "read_attachment":
        return await readAttachment(
          String(args.query ?? ""),
          args.name ? String(args.name) : undefined
        );
      case "reply_email":
        return await replyEmail(
          String(args.query ?? ""),
          String(args.body ?? ""),
          typeof args.reply_all === "boolean" ? args.reply_all : undefined
        );
      case "email_action":
        return await emailAction(String(args.query ?? ""), String(args.action ?? ""));
      case "send_email":
        return await sendEmail(
          Array.isArray(args.to) ? args.to : [String(args.to ?? "")],
          String(args.subject ?? ""),
          String(args.body ?? ""),
          Array.isArray(args.cc) ? args.cc : undefined
        );
      case "create_reminder":
        return await createReminder(String(args.title ?? ""), args.due, args.remind_at);
      case "send_teams_message":
        return await sendTeamsMessage(
          String(args.recipient_email ?? ""),
          String(args.message ?? "")
        );
      case "fetch_daily_conversations": {
        const raw = await fetchDailyDigest(args.date ? String(args.date) : undefined);
        try {
          const digest = JSON.parse(raw);
          const convs: any[] = digest.conversations ?? [];
          if (convs.length === 0) return `No conversations found for ${digest.date ?? "that date"}.`;
          const lines: string[] = [`${convs.length} conversation(s) on ${digest.date}:\n`];
          for (const c of convs) {
            lines.push(`--- Conversation ${c.conversation_id} ---`);
            for (const m of c.messages ?? []) {
              const ts = m.created_at ? new Date(m.created_at).toLocaleTimeString() : "";
              lines.push(`[${String(m.role).toUpperCase()}${ts ? " " + ts : ""}]: ${m.content}`);
            }
            lines.push("");
          }
          return lines.join("\n");
        } catch {
          return raw;
        }
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (e) {
    return `Tool ${name} failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** A user-facing approval request raised by a side-effecting tool. The UI shows
 *  it as a modal; resolving true runs the action, false declines it. */
export interface ConfirmRequest {
  /** The tool asking for approval (e.g. "run_shell", "send_imessage"). */
  tool: string;
  /** Short heading, e.g. "Run this shell command?". */
  title: string;
  /** The exact thing that will happen (command text, or recipient + message). */
  detail: string;
}

export interface RunAgentOpts {
  userText: string;
  history: ChatMessage[];
  settings: Settings;
  /** Files the user attached to this turn (images → vision, docs → text). */
  attachments?: Attachment[];
  /** Force a specific model and skip routing (from the model-picker menu). */
  modelOverride?: string | null;
  /** Conversation id — enables the persistent kanban board for multi-task
   *  requests. Omitted by background automations, which run board-less. */
  conversationId?: string;
  onState?: (s: AvatarState) => void;
  onToken?: (delta: string) => void;
  onToolStart?: (name: string) => void;
  onRoute?: (route: Route) => void;
  /** Live progress steps (routing, each tool, composing) for perceived speed. */
  onStep?: (step: UiStep) => void;
  /** Fired once at turn start with the conversation's existing board (or null). */
  onBoardLoad?: (board: TaskBoard | null) => void;
  /** Fired after every successful board write so the UI can animate the cards. */
  onBoardUpdate?: (board: TaskBoard) => void;
  /** Ask the user to approve a side-effecting action (shell, iMessage). Returns
   *  true to run it, false to decline. When absent (e.g. headless automations),
   *  these tools fall back to their built-in confirm-arg gate. */
  onConfirm?: (req: ConfirmRequest) => Promise<boolean>;
  signal?: AbortSignal;
}

/** One tool the model invoked, with the raw args it emitted and whether the
 *  executor accepted it — the structured tool-use signal for training capture. */
export interface ToolEvent {
  round: number;
  name: string;
  arguments: string;
  ok: boolean;
}

/** Everything a training export needs from one turn: the exact messages the model
 *  saw, the tool calls it chose, and how many rounds it took. Captured locally by
 *  the caller (App.tsx → save_trajectory); never synced. */
export interface Trajectory {
  messages: unknown[];
  toolEvents: ToolEvent[];
  rounds: number;
}

export interface RunAgentResult {
  content: string;
  tools: string[];
  route?: Route;
  /** The full turn trajectory for the on-device training corpus. */
  trajectory?: Trajectory;
}

/** Ensure exactly one card is in_progress while work remains: if none is and a
 *  todo exists, promote the first todo. Keeps the board showing live progress
 *  (DOING ≥ 1) even when the model dumps every card as todo. Mutates in place. */
function ensureOneInProgress(cards: TaskInput[]): void {
  if (cards.some((c) => c.status === "in_progress")) return;
  const next = cards.find((c) => c.status === "todo");
  if (next) next.status = "in_progress";
}

/** Harness-driven board advance. Small local models reliably CREATE the board but
 *  won't keep calling manage_tasks to move cards — they batch the real tools and
 *  leave the board frozen at todo. So when real tools ran and the model didn't
 *  update the board itself, WE advance it: mark the front-most open card(s) done
 *  (one per tool that ran, evidence = that tool) and put the next card
 *  in_progress. This makes the board track actual work regardless of the model. */
function advanceBoardByTools(board: TaskBoard, toolsRan: string[]): TaskInput[] {
  const cards: TaskInput[] = board.tasks.map((c) => ({
    id: c.id,
    title: c.title,
    status: c.status,
    evidence: c.evidence,
    blocker: c.blocker,
  }));
  let ti = 0;
  for (const c of cards) {
    if (ti >= toolsRan.length) break;
    if (c.status === "todo" || c.status === "in_progress") {
      c.status = "done";
      if (!c.evidence || !c.evidence.trim()) c.evidence = `${toolsRan[ti]} ran for this card`;
      ti++;
    }
  }
  ensureOneInProgress(cards);
  return cards;
}

/** Apply one manage_tasks call: sanitize, run the harness-side evidence gate,
 *  then persist. Returns the model-facing tool result text and (on success) the
 *  new board. `toolsSinceUpdate` is the set of real tools run since the last
 *  board write — a card can only go done if one of those backs its evidence,
 *  which stops "done without doing the work" without forcing the tool call and
 *  the board update into the same round (real models split them). */
async function applyBoardUpdate(
  tc: ToolCall,
  conversationId: string,
  board: TaskBoard | null,
  toolsSinceUpdate: Set<string>
): Promise<{ text: string; board?: TaskBoard }> {
  let args: any = {};
  try {
    args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
  } catch {
    return { text: "manage_tasks arguments were not valid JSON. Resend the full 'cards' array." };
  }
  const incoming: Array<Partial<TaskCard>> = Array.isArray(args.cards) ? args.cards : [];
  if (incoming.length === 0) {
    return { text: "manage_tasks called with no cards. Pass the COMPLETE current 'cards' array." };
  }

  // Collapse extra in_progress → todo (first wins), mirroring the Rust guard so
  // the model sees the same discipline before persistence.
  let sawInProgress = false;
  const sanitized: TaskInput[] = incoming.map((c) => {
    let status = (c.status ?? "todo") as TaskCard["status"];
    if (status === "in_progress") {
      if (sawInProgress) status = "todo";
      else sawInProgress = true;
    }
    return {
      id: typeof c.id === "string" ? c.id : "",
      title: String(c.title ?? "").trim() || "(untitled)",
      status,
      evidence: typeof c.evidence === "string" ? c.evidence : undefined,
      blocker: typeof c.blocker === "string" ? c.blocker : undefined,
    };
  });
  // Show live progress: if the model dumped every card as todo, promote the first.
  ensureOneInProgress(sanitized);

  // Evidence gate: a card NEWLY transitioning to done must be backed by a real
  // (non-board) tool run since the last board write, whose result the evidence
  // references.
  const rejected: string[] = [];
  for (const c of sanitized) {
    if (c.status !== "done") continue;
    const prev = c.id ? board?.tasks.find((x) => x.id === c.id) : undefined;
    if (prev?.status === "done") continue; // already done — idempotent
    if (toolsSinceUpdate.size === 0) {
      rejected.push(`'${c.title}' marked done but no tool has run yet — call the tool first`);
      continue;
    }
    const ev = validateEvidence(c.evidence, toolsSinceUpdate);
    if (!ev.ok) rejected.push(`'${c.title}' evidence rejected: ${ev.reason}`);
  }
  if (rejected.length > 0) {
    return {
      text:
        `REJECTED — board NOT updated:\n- ${rejected.join("\n- ")}\n` +
        `Run the missing tool now, or set that card back to in_progress and try again next round.`,
    };
  }

  // Merge, don't blind-overwrite. Whole-board replacement is a footgun for small
  // models: they routinely re-send the board minus a card or two, which would
  // silently drop tracked work. Preserve any existing card the model omitted (by
  // id) so the board only ever grows or changes status — never loses a card. To
  // abandon a plan the model/user clears the whole board explicitly.
  const incomingIds = new Set(sanitized.map((c) => c.id).filter(Boolean));
  const preserved: TaskInput[] = (board?.tasks ?? [])
    .filter((t) => !incomingIds.has(t.id))
    .map((t) => ({ id: t.id, title: t.title, status: t.status, evidence: t.evidence, blocker: t.blocker }));
  const merged = [...sanitized, ...preserved];
  const dropped = preserved.length;

  try {
    const updated = await setTaskBoard(conversationId, merged);
    const note = dropped > 0 ? ` (kept ${dropped} card(s) you omitted — resend the FULL list next time)` : "";
    return { text: `OK (v${updated.version})${note}:\n${renderBoardSnapshot(updated)}`, board: updated };
  } catch (e: any) {
    // Rust rejected it (e.g. done-without-evidence slipped past, or schema guard).
    return { text: `manage_tasks rejected by store: ${e?.message ?? String(e)}` };
  }
}

/** Built-in tool names — the allowlist for salvaging degraded tool-call leaks.
 *  We only reconstruct a call for a name the model could actually invoke; a
 *  hallucinated name (e.g. `open_url`) is never turned into a real call. */
const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_DEFS.map((d) => d.function.name)
);

/** A real tool name used as a bare pseudo-call: `fetch_url(`, `run_shell,`, … */
const TOOL_NAME_CALL_RE = new RegExp(
  `\\b(?:${[...BUILTIN_TOOL_NAMES].join("|")})\\s*[,(:{]`
);

/** Heuristic: does this content look like a tool call the model wrote as TEXT
 *  (leaked markup, a pseudo-call for a real tool, or a bare shell command)
 *  rather than a genuine prose answer? Triggers ONE self-repair re-prompt
 *  instead of surfacing the dangling text. */
export function looksLikeLeakedToolCall(content: string): boolean {
  if (!content) return false;
  if (/<\|?tool[_a-z]*\|?>|<\/?tool_call/i.test(content)) return true;
  if (TOOL_NAME_CALL_RE.test(content)) return true;
  // A shell command emitted as text, usually with a trailing `}` from the
  // leaked call wrapper (e.g. `sed -i '…' file}`).
  if (/\b(sed|grep|awk|rm|mv|cp|cat|ls|git|curl|chmod|mkdir|echo)\b[^\n]*\}\s*$/m.test(content))
    return true;
  return false;
}

/** Recover tool calls a model emitted as TEXT instead of in the structured
 *  `tool_calls` field. Some models/templates (notably the 26B reasoning model, or
 *  any model whose tool-call parser LM Studio doesn't recognize) leak
 *  `<tool_call>{json}</tool_call>` — or a garbled variant — into `content`.
 *  Pass 1 parses well-formed blocks (any tool name). Pass 2 salvages a
 *  `knownTool{json}` leak (real tool name + valid JSON args, garbled wrapper).
 *  Freeform leaks with no name (bare `sed …}`) or a hallucinated name are NOT
 *  recovered (too risky to auto-execute) — they go to the self-repair re-prompt
 *  / stripToolMarkup. */
export function recoverToolCalls(content: string): ToolCall[] {
  if (!content) return [];
  const out: ToolCall[] = [];
  const push = (name: unknown, args: unknown) => {
    if (!name || typeof name !== "string") return;
    out.push({
      id: `recovered-${out.length}-${Date.now().toString(36)}`,
      type: "function",
      function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) },
    });
  };

  // Pass 1: well-formed <tool_call>{json}</tool_call> blocks (any tool name).
  if (content.includes("<tool_call")) {
    const re = /<tool_call[^>]*>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      try {
        const obj = JSON.parse(m[1]);
        push(
          obj.name ?? obj.function?.name,
          obj.arguments ?? obj.parameters ?? obj.function?.arguments ?? {}
        );
      } catch {
        /* not valid JSON — leave it for stripToolMarkup */
      }
    }
  }
  if (out.length) return out;

  // Pass 2: a KNOWN tool name immediately followed by a valid JSON argument
  // object, with a missing/garbled wrapper (e.g. `fetch_url{"url":"…"}`). Known
  // names only — never fabricate a call for an unknown/hallucinated name.
  const named = /\b([a-z][a-z0-9_]{1,40})\s*(\{[\s\S]*?\})/g;
  let m: RegExpExecArray | null;
  while ((m = named.exec(content)) !== null) {
    if (!BUILTIN_TOOL_NAMES.has(m[1])) continue;
    try {
      push(m[1], JSON.parse(m[2]));
    } catch {
      /* not valid JSON — leave for self-repair */
    }
  }
  return out;
}

/** Remove tool-call / tool-response protocol markup from text destined for the
 *  user, so a leaked `<tool_call|>`, `</tool_call>`, etc. is never shown or spoken.
 *  Reasoning/harmony markup is already stripped Rust-side; this is the tool-call
 *  safety net the Rust sanitizer's `<|…|>` gate doesn't cover. */
export function stripToolMarkup(s: string): string {
  return s
    .replace(/<tool_call[^>]*>[\s\S]*?<\/tool_call>/g, "") // full blocks
    .replace(/<\/?tool_call[^>]*>/g, "") // stray open/close tags
    .replace(/<\/?tool_response[^>]*>/g, "")
    .replace(/<\|?tool[_a-z]*\|?>/gi, "") // <tool_call|>, <|tool_calls|>, …
    .replace(/\|>/g, "")
    .trim();
}

/** Run the full tool-calling loop and return the final grounded answer. */
export async function runAgent(opts: RunAgentOpts): Promise<RunAgentResult> {
  const { userText, history, settings, onState, onToken, onToolStart, onRoute, onStep, signal } =
    opts;
  onState?.("thinking");

  const attachments = opts.attachments ?? [];
  const images = attachments.filter((a) => a.kind === "image" && a.dataUrl);
  const docs = attachments.filter((a) => a.kind === "doc" && a.text);
  const hasImage = images.length > 0;

  // Instant missing-input preflight (no model round, no endpoint load). If the user
  // clearly wants the avatar to consume a video or link but gave no locator here OR
  // earlier in the thread, ask for it immediately. Without this, "watch this video"
  // with no URL gets forced through the multi-task board loop and burns minutes on a
  // slow model before it thinks to ask. Narrow by design; the ask_user tool is the
  // general fallback for missing inputs this doesn't catch.
  const priorText = history
    .slice(-6)
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
  const clarify = missingInput(userText, { priorText, hasAttachment: attachments.length > 0 });
  if (clarify) {
    onStep?.({ id: "answer", label: "Asking for a detail", done: true });
    onToken?.(clarify);
    return {
      content: clarify,
      tools: [],
      route: { modelId: "", taskType: "clarify", enhanced: userText, routed: false },
    };
  }

  const base = await resolveBaseEndpoint(settings);

  // Trivial-turn fast lane. A pure greeting/acknowledgement ("hey how are you",
  // "thanks!") needs no tools and no board, so skip the ~31-tool schema prefill,
  // MCP discovery, and the whole decomposition loop: one no-tools completion on the
  // fast tier. This is the non-thinking-task speedup — such turns shouldn't pay the
  // full agent tax. Guarded to text-only turns (an attachment may want vision) and
  // skipped if no model is loaded (the normal path surfaces the unreachable error).
  if (!hasImage && attachments.length === 0 && base.models.length > 0 && isTrivialChat(userText)) {
    const picked = opts.modelOverride ?? (await routeTask({ userText, endpoint: base })).modelId;
    const chatRoute: Route = { modelId: picked, taskType: "chat", enhanced: userText, routed: false };
    onRoute?.(chatRoute);
    const shortM = picked.split("/").pop() ?? picked;
    onStep?.({ id: "route", label: `Using ${shortM}`, done: true });
    onStep?.({ id: "answer", label: "Writing the answer", done: false });
    const chatMsgs: ChatMessage[] = [
      { role: "system", content: settings.system_prompt },
      ...history.slice(-12),
      { role: "user", content: userText },
    ];
    const r = await llmComplete(base.baseUrl, base.token, picked, chatMsgs, undefined, settings.max_tokens);
    const answer = (r.content ?? "").trim();
    onStep?.({ id: "answer", label: "Writing the answer", done: true });
    onToken?.(answer);
    // Capture the fast lane too — trivial turns are still real-usage persona/style
    // data, and skipping them left the training tracker empty for chatty sessions.
    return {
      content: answer,
      tools: [],
      route: chatRoute,
      trajectory: {
        messages: [...chatMsgs, { role: "assistant", content: answer }],
        toolEvents: [],
        rounds: 1,
      },
    };
  }

  // Routing layer: find the reachable endpoint + its loaded models, classify the
  // task, pick the best model, and rewrite the request into a sharper instruction.
  // A model picked from the menu (modelOverride) bypasses routing entirely.
  const route: Route = opts.modelOverride
    ? { modelId: opts.modelOverride, taskType: "manual", enhanced: userText, routed: true }
    : await routeTask({ userText, endpoint: base, hasImage });
  onRoute?.(route);
  const shortModel = route.modelId.split("/").pop() ?? route.modelId;
  onStep?.({
    id: "route",
    label: route.routed ? `Routing to ${shortModel} · ${route.taskType}` : `Using ${shortModel}`,
    done: true,
  });
  const endpoint = { baseUrl: base.baseUrl, token: base.token, model: route.modelId };

  // Attached docs are extracted to text and appended; images become image_url parts.
  const docText = docs.map((d) => `\n\n[Attached file: ${d.name}]\n${d.text}`).join("");
  const userContent: unknown = hasImage
    ? [
        { type: "text", text: userText + docText },
        ...images.map((a) => ({ type: "image_url", image_url: { url: a.dataUrl } })),
      ]
    : userText + docText;

  const planMsg: ChatMessage[] =
    route.enhanced && route.enhanced.trim() !== userText.trim()
      ? [{ role: "system", content: `Execution plan for this request (follow it): ${route.enhanced}` }]
      : [];
  // Date grounding: the model's training data is older than today, so without an
  // explicit "now" anchor it answers time-sensitive questions (dates, events, prices,
  // news) from stale memory. Inject the real current date EVERY turn (computed fresh,
  // so it's always accurate) and steer it to live tools for anything current.
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const dateMsg: ChatMessage = {
    role: "system",
    content:
      `Today's date is ${today}. Treat this as the present moment. Your training data ends well before today, ` +
      `so it is OUT OF DATE: never state dates, schedules, events, prices, headlines, or "latest/current/upcoming" ` +
      `facts from memory. For anything time-sensitive or recent, call web_search (then fetch_url) and answer ONLY ` +
      `from the live results — if a tool returns nothing, say so plainly rather than guessing from training data.`,
  };
  // Recency-window the history. Re-sending the ENTIRE conversation every turn lets a
  // long thread accumulate narration/refusal turns that few-shot-teach the small tool
  // model (qwen3-8b) to stop calling tools and just narrate — the spiral behind the
  // "it won't actually do anything" reports. The brain holds long-term memory, so the
  // model only needs the recent exchanges. Keep the last N messages, starting on a user
  // turn so role alternation stays clean.
  const MAX_HISTORY_MSGS = 12;
  let recentHistory = history.slice(-MAX_HISTORY_MSGS);
  if (recentHistory.length && recentHistory[0].role === "assistant") {
    recentHistory = recentHistory.slice(1);
  }
  const messages: ChatMessage[] = [
    { role: "system", content: settings.system_prompt },
    dateMsg,
    CAPABILITIES_NOTE,
    ...recentHistory,
    ...planMsg,
    { role: "user", content: userContent as string },
  ];

  const toolsUsed: string[] = [];
  // Structured tool-use log for the local training corpus: one entry per tool call
  // the model made, with the raw args and whether the executor accepted it.
  const toolEvents: ToolEvent[] = [];

  // Merge any MCP server tools into the set offered to the model this turn.
  const mcpDefs = await loadMcpTools();
  const toolDefs = mcpDefs.length ? [...TOOL_DEFS, ...mcpDefs] : TOOL_DEFS;

  // --- Kanban board layer ----------------------------------------------------
  // A multi-task request is decomposed onto a persistent, per-conversation board
  // and worked card by card, so the model can't "queue a plan" in prose and drop
  // it. Background automations run board-less (no conversationId).
  const conversationId = opts.conversationId;
  const boardEnabled = typeof conversationId === "string" && conversationId.length > 0;
  let board: TaskBoard | null = null;
  if (boardEnabled) {
    board = await getTaskBoard(conversationId).catch(() => null);
    // The board persists per-conversation, but a NEW request must start fresh —
    // don't inherit a stale/half-finished board from a PREVIOUS request in this
    // chat (that bled old cards into unrelated new asks). Only a short, explicit
    // continuation ("continue", "keep going", "finish those") resumes a board.
    const t = userText.trim();
    const isContinuation =
      t.length <= 40 &&
      /^(continue|keep going|go on|carry on|proceed|resume|next|finish( (it|them|those|up))?|go ahead|yes,? (continue|keep going|proceed|go))\b/i.test(
        t
      );
    if (board && openCardCount(board) > 0 && !isContinuation) {
      await clearTaskBoard(conversationId).catch(() => {});
      board = null;
    }
    opts.onBoardLoad?.(board);
  }
  const taskCount = estimateTaskCount(userText);
  const hasOpenBoard = openCardCount(board) > 0;
  const mustDecompose = boardEnabled && (isMultiTask(userText) || hasOpenBoard);
  // 5 rounds only covers a ~2-task request — too few for the TEDC failure. Scale
  // with task count, and grow again if the model adds cards mid-flow (below).
  let maxRounds = mustDecompose
    ? Math.min(MAX_ROUNDS_CAP, Math.max(BASE_ROUNDS, 3 * taskCount + 4))
    : BASE_ROUNDS;

  // The board snapshot is ONE system message kept current by overwrite, so it
  // never bloats the context across many rounds. boardSnapIdx is its slot.
  let boardSnapIdx = -1;
  const reinjectBoard = () => {
    if (!board || board.tasks.length === 0) return;
    const snap: ChatMessage = {
      role: "system",
      content:
        `CURRENT TASK BOARD (v${board.version}):\n${renderBoardSnapshot(board)}\n` +
        `Work the board until every card is done or blocked. Exactly ONE card in_progress at a ` +
        `time. Mark a card done only with evidence from a tool you called THIS round.`,
    };
    if (boardSnapIdx >= 0) messages[boardSnapIdx] = snap;
    else {
      messages.push(snap);
      boardSnapIdx = messages.length - 1;
    }
  };
  // Inject the board protocol (rules + worked example) directly — the user's saved
  // system_prompt does NOT contain it, so config.rs's default never reaches existing
  // installs. This is what teaches the model the board exists and how to use it.
  if (boardEnabled && (mustDecompose || hasOpenBoard)) {
    messages.push({ role: "system", content: BOARD_PROTOCOL });
  }
  if (mustDecompose && !hasOpenBoard) {
    messages.push({
      role: "system",
      content:
        `This request has about ${taskCount} distinct tasks. FIRST call manage_tasks to create one ` +
        `card per task (set the first to in_progress); then work them one at a time with real tools. ` +
        `Do not write the plan in prose. BUT if a required input is missing (a link/file/recipient you ` +
        `weren't given), call ask_user for it instead of building a board around the gap.`,
    });
  }
  reinjectBoard();

  // Spiral-breaker: small models sometimes narrate work ("I'll search…", "here's
  // the breakdown") with NO tool_call. Returning that both misleads the user and
  // poisons history (it few-shot-teaches more narrating). On a no-tool reply that
  // reads as an unexecuted plan, nudge ONCE to force a real call (or the board).
  let nudged = false;
  // One-shot self-repair when a tool call leaks as text we can't safely rebuild.
  let repaired = false;
  // tool_choice "required" isn't always honored by LM Studio, so bound how many
  // times we re-prompt for the initial decomposition before giving up.
  let decomposeRetries = 0;

  // Successful (non-board) tools accumulate ACROSS rounds until a board write
  // consumes them. Real models split the work: round N calls brain_page, round
  // N+1 calls manage_tasks to mark that card done. A per-round set would reject
  // that legitimate sequence and stall the model — so the evidence gate looks at
  // every real tool run since the last successful board update.
  const toolsSinceBoardUpdate = new Set<string>();

  for (let round = 0; round < maxRounds; round++) {
    if (signal?.aborted) throw new Error("aborted");
    const thinkId = `think-${round}`;
    const thinkLabel = round === 0 ? "Reading your request" : "Reviewing and composing";
    onStep?.({ id: thinkId, label: thinkLabel, done: false });
    // Round 0 of a multi-task request: force a tool call so the model can't open
    // with prose. Use the STRING "required" (force any tool) — LM Studio/llama.cpp
    // reject the named-function object form ("Invalid tool_choice type: 'object'").
    // Combined with the TASK BOARD system prompt the model reliably picks
    // manage_tasks first (verified live against qwen3-8b). Falls back to auto once
    // if some endpoint rejects "required" too.
    const forceDecompose = round === 0 && mustDecompose && !hasOpenBoard;
    const toolChoice: unknown = forceDecompose ? "required" : undefined;
    let res;
    try {
      res = await llmComplete(
        endpoint.baseUrl,
        endpoint.token,
        endpoint.model,
        messages,
        toolDefs,
        settings.max_tokens,
        toolChoice
      );
    } catch (e) {
      if (forceDecompose) {
        res = await llmComplete(
          endpoint.baseUrl,
          endpoint.token,
          endpoint.model,
          messages,
          toolDefs,
          settings.max_tokens
        );
      } else {
        throw e;
      }
    }
    onStep?.({ id: thinkId, label: thinkLabel, done: true });
    // The LLM call above can run 60–120s; honor a Stop pressed during it before
    // we commit to running this round's (possibly side-effecting) tools.
    if (signal?.aborted) throw new Error("aborted");
    const content = res.content ?? "";
    let toolCalls = Array.isArray(res.tool_calls) ? res.tool_calls : [];
    // A model may have emitted a tool call as TEXT (leaked markup) rather than in
    // the structured field — recover it so the action runs instead of being shown.
    if (toolCalls.length === 0) {
      const recovered = recoverToolCalls(content);
      if (recovered.length) toolCalls = recovered;
    }

    if (toolCalls.length === 0) {
      // Narration guard: the model described work instead of doing it. Nudge once.
      if (!nudged) {
        const pattern = detectNarration(content);
        if (pattern) {
          nudged = true;
          messages.push({
            role: "system",
            content:
              `You did NOT call any tool (matched: ${pattern}). Describing a plan is not doing it. ` +
              (boardEnabled
                ? "If this needs multiple steps, call manage_tasks NOW to lay out the cards; otherwise call the real tool. "
                : "Emit the actual tool call NOW (web_search/fetch_url, files, calendar, email, or the brain) — do not narrate or invent results. ") +
              "If genuinely no tool is needed, answer directly.",
          });
          continue;
        }
      }
      // Decompose-retry: this is a multi-task request but the board still doesn't
      // exist — the model failed to decompose. tool_choice "required" is NOT always
      // honored by LM Studio/MLX (it returns prose ~1 in 3), and the narration
      // regex won't catch every such reply. Rather than return that prose, firmly
      // re-instruct and retry a bounded number of times so a flaky force can't sink
      // the whole request.
      if (mustDecompose && (!board || board.tasks.length === 0) && decomposeRetries < 2) {
        decomposeRetries++;
        messages.push({
          role: "system",
          content:
            "You did not call manage_tasks. This request has multiple steps — call manage_tasks NOW " +
            "with one card per task (first card in_progress). Do not reply in prose until the board exists.",
        });
        continue;
      }
      // If the board still has open cards, keep working rather than replying.
      const open = openCardCount(board);
      if (open > 0) {
        messages.push({
          role: "system",
          content:
            `The board still has ${open} open card(s). Continue: take the in_progress card, do its ` +
            `work with a tool, then update the board. Do not reply until every card is done or blocked.`,
        });
        continue;
      }
      // Self-repair: the model wrote a tool call as TEXT (leaked markup, a
      // pseudo-call for a real tool, or a bare shell command) that we couldn't
      // safely reconstruct. Rather than surface the dangling text and stop, ask
      // it ONCE to re-emit a proper structured call. Catches `open_url,url:…}`
      // (→ a real web tool) and `sed …}` (→ run_shell) — audit 2026-06-21.
      if (!repaired && looksLikeLeakedToolCall(content)) {
        repaired = true;
        messages.push({
          role: "system",
          content:
            "Your last reply was a tool call written as plain text, so nothing ran. " +
            "Re-issue it as a real structured tool call (the tool_calls field), not prose. " +
            'Use an actual tool name — e.g. run_shell (with a "command" argument) to run a ' +
            "shell command, fetch_url or browser_control to open a URL, web_search to search. " +
            "If no tool is genuinely needed, answer directly with no tool-call markup.",
        });
        continue;
      }
      const answer = stripToolMarkup(content.trim());
      onStep?.({ id: "answer", label: "Writing the answer", done: true });
      onToken?.(answer);
      return {
        content: answer,
        tools: toolsUsed,
        route,
        trajectory: { messages, toolEvents, rounds: round + 1 },
      };
    }

    // Clarify-and-stop. If the model asked for a missing input, surface that
    // question and END the turn — before running any other tool or spinning up a
    // board around a request it can't complete. This is the model-driven complement
    // to the deterministic preflight: it catches gaps no regex can (a missing
    // recipient, which of two files, an ambiguous date). Checked FIRST so an
    // ask_user emitted alongside a premature watch_video/send_email wins.
    const askCall = toolCalls.find((tc) => tc.function.name === "ask_user");
    if (askCall) {
      let question = "";
      try {
        const a = askCall.function.arguments ? JSON.parse(askCall.function.arguments) : {};
        question = String(a.question ?? "").trim();
      } catch {
        /* fall through to the default prompt */
      }
      if (!question) question = "I need a bit more information to do that — could you clarify?";
      if (!toolsUsed.includes("ask_user")) toolsUsed.push("ask_user");
      onStep?.({ id: "answer", label: "Asking for a detail", done: true });
      onToken?.(question);
      return { content: question, tools: toolsUsed, route };
    }

    // Board-from-tools fallback. On a multi-task request the model SHOULD call
    // manage_tasks first, but small models relentlessly batch the domain tools
    // instead and can't be argued out of it (deferring just loops). So when the
    // model ran domain tools without ever laying out a board, BUILD the board from
    // those tool calls — one readable card per tool — then let them execute and the
    // harness advance the cards. This guarantees a visible, moving board even when
    // the model never decomposes. (If it DID call manage_tasks, use that instead.)
    const hasBoardCall = toolCalls.some((tc) => tc.function.name === "manage_tasks");
    if (boardEnabled && mustDecompose && (!board || board.tasks.length === 0) && !hasBoardCall) {
      const cards: TaskInput[] = toolCalls.map((tc, i) => {
        let a: any = {};
        try {
          a = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          /* tolerate malformed args for the label */
        }
        return {
          id: "",
          title: toolStepLabel(tc.function.name, a),
          status: i === 0 ? "in_progress" : "todo",
        };
      });
      try {
        board = await setTaskBoard(conversationId, cards);
        opts.onBoardUpdate?.(board);
        maxRounds = Math.min(MAX_ROUNDS_CAP, Math.max(maxRounds, 4 + 3 * board.tasks.length));
        reinjectBoard();
      } catch {
        /* if the store rejects, just proceed without a board this turn */
      }
      // Fall through: execute the tools this round; harness-advance moves the cards.
    }

    // Record the assistant's tool-call message, then run each tool.
    // IMPORTANT: re-feed ONLY the tool_calls, never the model's reasoning content.
    // Reasoning models (e.g. gemma-4-26b-a4b) emit harmony tokens like
    // "<|channel|>thought|>…" in content; re-submitting that markup crashes LM
    // Studio's template parser ("Failed to parse input at pos 0"). The tool_calls
    // carry everything the next round needs.
    messages.push({ role: "assistant", content: "", tool_calls: toolCalls });

    // Run domain tools FIRST so the evidence accumulator is populated before we
    // evaluate any manage_tasks "done" transitions. Board calls are deferred to
    // the second pass below.
    const pendingBoardCalls: ToolCall[] = [];
    const toolsRanThisRound: string[] = []; // ordered, successful, for harness-advance
    for (const tc of toolCalls) {
      // Stop must prevent the next tool from firing — especially side-effecting
      // ones (send_email, calendar_create, post_to_facebook).
      if (signal?.aborted) throw new Error("aborted");
      if (tc.function.name === "manage_tasks") {
        pendingBoardCalls.push(tc);
        continue;
      }
      let aobj: any = {};
      try {
        aobj = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        /* tolerate malformed args for labelling */
      }
      const stepId = `tool-${round}-${tc.id || tc.function.name}`;
      const label = toolStepLabel(tc.function.name, aobj);
      onStep?.({ id: stepId, label, done: false });
      onToolStart?.(tc.function.name);
      if (!toolsUsed.includes(tc.function.name)) toolsUsed.push(tc.function.name);
      const result = await executeTool(tc.function.name, tc.function.arguments, opts.onConfirm);
      // Only a SUCCESSFUL tool counts toward the done-evidence gate. executeTool
      // returns "Tool X failed: …" / "Unknown tool: X" as a non-empty string on
      // failure — if that satisfied the gate, the model could mark a card done off
      // a tool that 401'd. Failed tools still appear in the UI badge (toolsUsed).
      const toolFailed =
        result.startsWith(`Tool ${tc.function.name} failed:`) || result.startsWith("Unknown tool:");
      if (!toolFailed) {
        toolsSinceBoardUpdate.add(tc.function.name);
        toolsRanThisRound.push(tc.function.name);
      }
      toolEvents.push({
        round,
        name: tc.function.name,
        arguments: tc.function.arguments ?? "",
        ok: !toolFailed,
      });
      onStep?.({ id: stepId, label, done: true });
      messages.push({
        role: "tool",
        tool_call_id: tc.id || tc.function.name,
        name: tc.function.name,
        content: result,
      });
    }

    // Second pass: apply manage_tasks calls through the evidence gate, persist,
    // and surface the new board to the UI + back into the model context.
    let modelUpdatedBoardThisRound = false;
    for (const tc of pendingBoardCalls) {
      if (signal?.aborted) throw new Error("aborted");
      const stepId = `tool-${round}-${tc.id || "manage_tasks"}`;
      onStep?.({ id: stepId, label: "Updating the task board", done: false });
      onToolStart?.("manage_tasks");
      if (!toolsUsed.includes("manage_tasks")) toolsUsed.push("manage_tasks");
      const result: { text: string; board?: TaskBoard } = boardEnabled
        ? await applyBoardUpdate(tc, conversationId, board, toolsSinceBoardUpdate)
        : { text: "manage_tasks is unavailable here (no conversation context)." };
      if (result.board) {
        board = result.board;
        modelUpdatedBoardThisRound = true;
        opts.onBoardUpdate?.(board);
        // The tools that justified this update are now consumed; the next card's
        // done transition must be backed by fresh tool calls.
        toolsSinceBoardUpdate.clear();
        maxRounds = Math.min(MAX_ROUNDS_CAP, Math.max(maxRounds, 4 + 3 * board.tasks.length));
        reinjectBoard();
      }
      toolEvents.push({
        round,
        name: "manage_tasks",
        arguments: tc.function.arguments ?? "",
        ok: !!result.board,
      });
      onStep?.({ id: stepId, label: "Updating the task board", done: true });
      messages.push({
        role: "tool",
        tool_call_id: tc.id || "manage_tasks",
        name: "manage_tasks",
        content: result.text,
      });
    }

    // Harness-driven advance: small local models batch the real tools and leave the
    // board frozen at todo. If tools ran this round but the model didn't move the
    // board itself, advance it for them so the cards track the actual work.
    if (
      boardEnabled &&
      board &&
      toolsRanThisRound.length > 0 &&
      !modelUpdatedBoardThisRound &&
      openCardCount(board) > 0
    ) {
      try {
        board = await setTaskBoard(conversationId, advanceBoardByTools(board, toolsRanThisRound));
        opts.onBoardUpdate?.(board);
        toolsSinceBoardUpdate.clear();
        reinjectBoard();
      } catch {
        /* keep the board as-is if the store rejects the advance */
      }
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
  const answer = stripToolMarkup((final.content ?? "").trim());
  onToken?.(answer);
  return {
    content: answer,
    tools: toolsUsed,
    route,
    trajectory: { messages, toolEvents, rounds: maxRounds },
  };
}
