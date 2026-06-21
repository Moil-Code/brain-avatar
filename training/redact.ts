// Deterministic PII scrubber applied to LIVE trajectories at export time (synthetic
// records are constructed clean). Catches STRUCTURED identifiers — emails, phone
// numbers, API tokens/long hex, macOS user paths, URLs with credentials. It does
// NOT attempt free-text name anonymization: reliable person-name redaction needs an
// NER pass, which is a deliberate follow-up (documented in training/README.md). The
// point here is that secrets/contact handles never reach a dataset, and that the
// scrub is deterministic so the same input always yields the same output.

import type { ChatMessage, TrajectoryRecord } from "./types.ts";

const RULES: { re: RegExp; tag: string }[] = [
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, tag: "[EMAIL]" },
  { re: /\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, tag: "[PHONE]" },
  // Bearer/API tokens & long hex/base64-ish secrets (>=24 chars).
  { re: /\b[A-Za-z0-9_-]{24,}\b/g, tag: "[TOKEN]" },
  { re: /\/Users\/[^/\s]+/g, tag: "/Users/[USER]" },
  { re: /\/home\/[^/\s]+/g, tag: "/home/[USER]" },
  // credentials embedded in URLs
  { re: /(https?:\/\/)[^/\s:@]+:[^/\s:@]+@/g, tag: "$1[CRED]@" },
];

export function redactText(s: string): string {
  let out = s;
  for (const { re, tag } of RULES) out = out.replace(re, tag);
  return out;
}

function redactMessage(m: ChatMessage): ChatMessage {
  return {
    ...m,
    content: redactText(m.content ?? ""),
    tool_calls: m.tool_calls?.map((c) => ({
      ...c,
      function: { ...c.function, arguments: redactText(c.function.arguments) },
    })),
  };
}

/** Redact a whole record in place-safe (returns a new object). No-op-ish for
 *  already-clean synthetic records, so it's safe to run over the whole corpus. */
export function redactRecord(r: TrajectoryRecord): TrajectoryRecord {
  return {
    ...r,
    user: redactText(r.user),
    final_answer: redactText(r.final_answer),
    messages: r.messages.map(redactMessage),
    tool_events: r.tool_events.map((e) => ({ ...e, arguments: redactText(e.arguments) })),
  };
}
