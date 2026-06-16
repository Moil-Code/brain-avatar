import { resolveEndpoint, streamChat } from "./llm";
import { brainSearch, calendarEvents, webSearch } from "./tauri";
import type { AvatarState, ChatMessage, Settings } from "./types";

const MAX_ROUNDS = 5;

export const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "brain_search",
      description:
        "Search Andres' personal knowledge brain (meetings, people, deals, projects, " +
        "concepts, companies, past conversations). Use this FIRST for anything about Moil, " +
        "specific people, deals, projects, or personal/company history.",
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
        "Read Andres' Microsoft 365 calendar. Returns upcoming events. Use for schedule, " +
        "meetings, availability, or 'what's on today/this week' questions.",
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
      case "brain_search":
        return await brainSearch(String(args.query ?? ""), args.limit);
      case "calendar_events":
        return await calendarEvents(args.days);
      case "web_search":
        return await webSearch(String(args.query ?? ""));
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

  const endpoint = await resolveEndpoint(settings);

  const messages: ChatMessage[] = [
    { role: "system", content: settings.system_prompt },
    ...history,
    { role: "user", content: userText },
  ];

  const toolsUsed: string[] = [];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { content, toolCalls } = await streamChat({
      endpoint,
      messages,
      tools: TOOL_DEFS,
      onToken,
      signal,
    });

    if (toolCalls.length === 0) {
      return { content: content.trim(), tools: toolsUsed };
    }

    // Record the assistant's tool-call message, then run each tool.
    messages.push({ role: "assistant", content: content ?? "", tool_calls: toolCalls });
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
  const final = await streamChat({ endpoint, messages, onToken, signal });
  return { content: final.content.trim(), tools: toolsUsed };
}
