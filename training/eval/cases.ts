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
import { TOOL_DEFS } from "../tool_defs.ts";

/** Tool schemas for eval requests — the shared canonical set, so eval, teacher
 *  distillation, and the exported training data all use identical signatures. */
export const TOOLS = TOOL_DEFS;

export interface EvalCase {
  id: string;
  user: string;
  /** Tool the model SHOULD call first (by name). */
  expectFirstTool?: string;
  /** Any ONE of these is an acceptable first tool (use when >1 choice is correct,
   *  e.g. brain_page vs brain_search for a contextual lookup). */
  expectOneOfFirstTool?: string[];
  /** Tools that MUST NOT appear (e.g. send_email before a confirm). */
  forbidTools?: string[];
  /** True ⇒ the gold turn makes NO tool call (it asks/answers directly). */
  expectNoToolCall?: boolean;
  /** Substring the final content should contain (e.g. a confirm question "?"). */
  expectContentIncludes?: string;
  /** Substring the FIRST tool call's JSON arguments must contain (the right value,
   *  not just the right tool) — e.g. the entity name for a brain_page lookup. */
  expectArgsInclude?: string;
}

export const CASES: EvalCase[] = [
  // brain_page-first on a named entity — and with the RIGHT entity in the args
  { id: "who-is", user: "who is Jordan Avery?", expectFirstTool: "brain_page", expectArgsInclude: "Jordan" },
  {
    id: "tell-about",
    user: "tell me about Northwind Logistics",
    expectFirstTool: "brain_page",
    expectArgsInclude: "Northwind",
  },
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
  // irrelevance / refusal — must NOT reach for a tool on smalltalk or meta-questions
  // (BFCL's "irrelevance" category: knowing when not to call a tool).
  { id: "smalltalk-thanks", user: "thanks, that's all for now", expectNoToolCall: true },
  { id: "smalltalk-greet", user: "good morning!", expectNoToolCall: true },
  { id: "meta-capabilities", user: "what can you help me with?", expectNoToolCall: true },
  // contextual lookup where more than one grounding tool is acceptable
  {
    id: "context-lookup",
    user: "what do we know about the pricing change?",
    expectOneOfFirstTool: ["brain_search", "brain_page"],
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
  if (c.expectOneOfFirstTool) {
    const ft = firstTool(msg)?.function.name;
    if (!ft || !c.expectOneOfFirstTool.includes(ft)) {
      reasons.push(`first tool ${ft ?? "(none)"} ∉ {${c.expectOneOfFirstTool.join(", ")}}`);
    }
  }
  if (c.expectNoToolCall && calls.length > 0) {
    reasons.push(`expected no tool call, got ${names.join(",")}`);
  }
  for (const f of c.forbidTools ?? []) {
    if (names.includes(f)) reasons.push(`forbidden tool called: ${f}`);
  }
  // Any tool call must carry parseable JSON arguments — a malformed args blob is a
  // failed call no matter which tool it names.
  for (const t of calls) {
    const a = t.function.arguments ?? "";
    if (a.trim()) {
      try {
        JSON.parse(a);
      } catch {
        reasons.push(`invalid JSON args for ${t.function.name}`);
      }
    }
  }
  if (c.expectArgsInclude) {
    const a = firstTool(msg)?.function.arguments ?? "";
    if (!a.toLowerCase().includes(c.expectArgsInclude.toLowerCase())) {
      reasons.push(`args missing "${c.expectArgsInclude}"`);
    }
  }
  if (c.expectContentIncludes && !(msg.content ?? "").includes(c.expectContentIncludes)) {
    reasons.push(`content missing "${c.expectContentIncludes}"`);
  }
  return { id: c.id, pass: reasons.length === 0, reasons };
}
