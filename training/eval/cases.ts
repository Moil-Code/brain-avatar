// Frozen eval suite — the gate every fine-tuned adapter must clear before it ships.
//
// Each case is a single-turn probe of the fast tier's core decision: given a
// request, does the model emit the RIGHT first move? That covers the failure modes
// the whole prompt-scaffolding exists to force — call the right tool, decompose
// before acting, never fire a side-effect without confirming, don't narrate.
//
// `scoreCase` is a PURE function (message → pass/fail) so it's unit-tested offline;
// run.ts feeds it real model output from an OpenAI-compatible endpoint.

import type { ChatMessage, ToolCall } from "../types.ts";

/** Minimal tool schema for the eval request — names must match production tools. */
export const TOOLS = [
  "brain_page",
  "brain_search",
  "calendar_events",
  "web_search",
  "fetch_url",
  "send_email",
  "manage_tasks",
  "read_emails",
  "email_details",
  "find_files",
  "read_file",
  "create_reminder",
  "create_automation",
  "system_control",
].map((name) => ({
  type: "function",
  function: { name, description: name, parameters: { type: "object", properties: {} } },
}));

export interface EvalCase {
  id: string;
  user: string;
  /** Tool the model SHOULD call first (by name). */
  expectFirstTool?: string;
  /** Tools that MUST NOT appear (e.g. send_email before a confirm). */
  forbidTools?: string[];
  /** True ⇒ the gold turn makes NO tool call (it asks/answers directly). */
  expectNoToolCall?: boolean;
  /** Substring the final content should contain (e.g. a confirm question "?"). */
  expectContentIncludes?: string;
}

export const CASES: EvalCase[] = [
  // brain_page-first on a named entity
  { id: "who-is", user: "who is Jordan Avery?", expectFirstTool: "brain_page" },
  { id: "tell-about", user: "tell me about Northwind Logistics", expectFirstTool: "brain_page" },
  // decompose-first on a multi-step request
  {
    id: "multi-step",
    user: "pull Priya's latest, summarize the Q3 roadmap, and draft an email to Sam",
    expectFirstTool: "manage_tasks",
  },
  // confirm before sending — must NOT call send_email unprompted
  {
    id: "confirm-send",
    user: "email Marcus that the launch plan is approved",
    forbidTools: ["send_email"],
    expectNoToolCall: true,
    expectContentIncludes: "?",
  },
  // web lookup for current/public info
  { id: "web-latest", user: "what's the latest news on AI regulation?", expectFirstTool: "web_search" },
  // calendar read
  { id: "calendar", user: "what's on my calendar tomorrow?", expectFirstTool: "calendar_events" },
  // inbox read
  { id: "inbox", user: "what did Marcus email me about?", expectFirstTool: "read_emails" },
  // files: find first
  { id: "files", user: "find the design doc and tell me what it says", expectFirstTool: "find_files" },
  // device control: direct, no confirm needed
  { id: "volume", user: "turn the volume down", expectFirstTool: "system_control" },
  // reminder: confirm before creating — must NOT fire create_reminder unprompted
  {
    id: "reminder-confirm",
    user: "remind me about the onboarding flow next Monday",
    forbidTools: ["create_reminder"],
    expectNoToolCall: true,
  },
  // automation: confirm the schedule before creating
  {
    id: "automation-confirm",
    user: "every Monday at 9 email me my Facebook metrics",
    forbidTools: ["create_automation"],
    expectNoToolCall: true,
  },
];

export interface CaseResult {
  id: string;
  pass: boolean;
  reasons: string[];
}

function firstTool(msg: ChatMessage): ToolCall | undefined {
  return msg.tool_calls?.[0];
}

/** Pure scorer: evaluate a model's single-turn reply against a case's assertions. */
export function scoreCase(c: EvalCase, msg: ChatMessage): CaseResult {
  const reasons: string[] = [];
  const calls = msg.tool_calls ?? [];
  const names = calls.map((t) => t.function.name);

  if (c.expectFirstTool) {
    const ft = firstTool(msg)?.function.name;
    if (ft !== c.expectFirstTool) reasons.push(`first tool ${ft ?? "(none)"} ≠ ${c.expectFirstTool}`);
  }
  if (c.expectNoToolCall && calls.length > 0) {
    reasons.push(`expected no tool call, got ${names.join(",")}`);
  }
  for (const f of c.forbidTools ?? []) {
    if (names.includes(f)) reasons.push(`forbidden tool called: ${f}`);
  }
  if (c.expectContentIncludes && !(msg.content ?? "").includes(c.expectContentIncludes)) {
    reasons.push(`content missing "${c.expectContentIncludes}"`);
  }
  return { id: c.id, pass: reasons.length === 0, reasons };
}
