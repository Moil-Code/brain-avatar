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

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Redact structured PII, plus any names from an optional denylist (word-boundary,
 *  case-insensitive → [NAME]). The denylist is the dependency-free half of name
 *  anonymization; full contextual NER needs Presidio (see TRAINING_CAPABILITIES_AUDIT). */
export function redactText(s: string, names: string[] = []): string {
  let out = s ?? "";
  for (const { re, tag } of RULES) out = out.replace(re, tag);
  for (const n of names) {
    const t = n.trim();
    if (t.length < 2) continue; // never redact 1-char tokens
    out = out.replace(new RegExp(`\\b${escapeRe(t)}\\b`, "gi"), "[NAME]");
  }
  return out;
}

function redactMessage(m: ChatMessage, names: string[]): ChatMessage {
  return {
    ...m,
    content: redactText(m.content ?? "", names),
    // Reasoning traces quote the same real people/emails/paths as the answer, so
    // they must be scrubbed before a distilled record can become a training row.
    ...(m.reasoning ? { reasoning: redactText(m.reasoning, names) } : {}),
    tool_calls: m.tool_calls?.map((c) => ({
      ...c,
      function: { ...c.function, arguments: redactText(c.function.arguments, names) },
    })),
  };
}

/** Redact a whole record in place-safe (returns a new object). No-op-ish for
 *  already-clean synthetic records, so it's safe to run over the whole corpus.
 *  `names` is an optional denylist of real names to scrub. */
export function redactRecord(r: TrajectoryRecord, names: string[] = []): TrajectoryRecord {
  return {
    ...r,
    user: redactText(r.user, names),
    final_answer: redactText(r.final_answer, names),
    messages: r.messages.map((m) => redactMessage(m, names)),
    tool_events: r.tool_events.map((e) => ({ ...e, arguments: redactText(e.arguments, names) })),
  };
}
