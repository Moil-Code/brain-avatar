import { resolveBaseEndpoint } from "./llm";
import { routeTask, type Route } from "./router";
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
  readFile,
  runAppleScript,
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
import type {
  Attachment,
  AutomationSchedule,
  AvatarState,
  ChatMessage,
  Settings,
  UiStep,
} from "./types";

const MAX_ROUNDS = 5;

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
    case "email_details":
      return a.query ? `Opening the “${a.query}” email` : "Opening the email";
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
    case "send_email":
      return "Preparing the email";
    case "create_reminder":
      return "Adding the reminder";
    case "send_teams_message":
      return "Preparing the Teams message";
    default:
      return name;
  }
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
      name: "web_task",
      description:
        "Drive a REAL logged-in browser to do a web task: log into a site, navigate it, " +
        "read an authenticated page, fill a form, click through a flow. Use this (not fetch_url) " +
        "for anything that needs a real session — especially 'log into moilapp.com', 'open my Moil " +
        "dashboard', 'go to X and tell me what's there'. fetch_url only gets public page text and " +
        "can't log in. Pass a clear, specific natural-language instruction including the site/URL. " +
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
      case "read_emails":
        return await readEmails(args.count);
      case "email_details":
        return await emailDetails(String(args.query ?? ""));
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
  /** Files the user attached to this turn (images → vision, docs → text). */
  attachments?: Attachment[];
  /** Force a specific model and skip routing (from the model-picker menu). */
  modelOverride?: string | null;
  onState?: (s: AvatarState) => void;
  onToken?: (delta: string) => void;
  onToolStart?: (name: string) => void;
  onRoute?: (route: Route) => void;
  /** Live progress steps (routing, each tool, composing) for perceived speed. */
  onStep?: (step: UiStep) => void;
  signal?: AbortSignal;
}

export interface RunAgentResult {
  content: string;
  tools: string[];
  route?: Route;
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

  // Routing layer: find the reachable endpoint + its loaded models, classify the
  // task, pick the best model, and rewrite the request into a sharper instruction.
  // A model picked from the menu (modelOverride) bypasses routing entirely.
  const base = await resolveBaseEndpoint(settings);
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
  const messages: ChatMessage[] = [
    { role: "system", content: settings.system_prompt },
    ...history,
    ...planMsg,
    { role: "user", content: userContent as string },
  ];

  const toolsUsed: string[] = [];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (signal?.aborted) throw new Error("aborted");
    const thinkId = `think-${round}`;
    const thinkLabel = round === 0 ? "Reading your request" : "Reviewing and composing";
    onStep?.({ id: thinkId, label: thinkLabel, done: false });
    const res = await llmComplete(
      endpoint.baseUrl,
      endpoint.token,
      endpoint.model,
      messages,
      TOOL_DEFS,
      settings.max_tokens
    );
    onStep?.({ id: thinkId, label: thinkLabel, done: true });
    const content = res.content ?? "";
    const toolCalls = Array.isArray(res.tool_calls) ? res.tool_calls : [];

    if (toolCalls.length === 0) {
      const answer = content.trim();
      onStep?.({ id: "answer", label: "Writing the answer", done: true });
      onToken?.(answer);
      return { content: answer, tools: toolsUsed, route };
    }

    // Record the assistant's tool-call message, then run each tool.
    // IMPORTANT: re-feed ONLY the tool_calls, never the model's reasoning content.
    // Reasoning models (e.g. gemma-4-26b-a4b) emit harmony tokens like
    // "<|channel|>thought|>…" in content; re-submitting that markup crashes LM
    // Studio's template parser ("Failed to parse input at pos 0"). The tool_calls
    // carry everything the next round needs.
    messages.push({ role: "assistant", content: "", tool_calls: toolCalls });
    for (const tc of toolCalls) {
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
      const result = await executeTool(tc.function.name, tc.function.arguments);
      onStep?.({ id: stepId, label, done: true });
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
