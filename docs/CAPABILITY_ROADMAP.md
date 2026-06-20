# Capability Roadmap — learning from OpenClaw

_Date: 2026-06-20. Trigger: comparing Brain Avatar's email handling to OpenClaw
(the self-hosted Telegram "Jarvis" already running at `~/OpenClawAgent/`)._

## Why this exists

OpenClaw (formerly Moltbot / Clawdbot, MIT-licensed, by Peter Steinberger) is a
self-hosted agent gateway: messaging channels (Telegram, WhatsApp, …) → an LLM
runtime (its **Codex harness**) → 50+ connector **Apps**. In the reference
screenshot it processed an Outlook email with fine-grained steps —
`Search Messages → Fetch Message → List Attachments → **Fetch Attachment**` — and
read the **Word attachment** because that's where the real content was.

Brain Avatar is a local-first desktop avatar driving **local LM Studio models**
(qwen3-8b tool tier / gemma-4-12b / gemma-4-26b-a4b). It can't lean on a frontier
model like OpenClaw's Codex/GPT-5.5, so the lesson isn't "copy the model" — it's
"borrow the **tool decomposition**," which actually helps a small model: each step
is a simple, single-purpose decision.

## Email: before vs after

| Capability | Before | After (this work) |
|---|---|---|
| Inbox list | `read_emails` | `read_emails` + 📎 attachment markers |
| Find one email | `email_details` (body + links) | same, now flags attachments |
| **Read attachments** | ❌ none | ✅ `list_attachments`, `read_attachment` |
| Reply in-thread | ❌ only new mail | ✅ `reply_email` (reply / reply-all) |
| Triage | ❌ none | ✅ `email_action` (read/flag/archive/delete) |

All new mail tools resolve their target by **natural-language query** (sender /
subject / keyword) via the shared `find_messages_by_query`, so the local model
says _"the email from Monica"_ instead of echoing an opaque Graph id — far more
robust for an 8B model.

## Phases

### ✅ Phase 1 — Email parity (DONE)
- `list_attachments(query)`, `read_attachment(query, name?)`, `reply_email(query,
  body, reply_all?)`, `email_action(query, action)` — `src-tauri/src/tools.rs`,
  registered in `lib.rs`, proxied via `brain-daemon` for remote mode, wired into
  the agent loop (`src/lib/agent.ts`) and system prompt.
- `read_emails` / `email_details` now surface attachment presence.
- **Scope note:** reply uses `Mail.Send` (already granted). Triage mutations
  (mark-read/flag/archive/delete) need **`Mail.ReadWrite`** on the Entra app; if it
  isn't granted the tool returns a clear permission hint. To enable: add
  `Mail.ReadWrite` (Delegated) to the "Brain Avatar Scheduler" app registration and
  grant admin consent (same flow as `Calendars.ReadWrite` in the README).

### ✅ Phase 2 — Unified document pipeline (DONE)
- `files::extract_bytes_text(name, base64, cap)` is now the single "bytes → text"
  path (txt/md/csv/json/html/rtf/doc/docx/odt/pdf), reused by **both** the chat
  doc-upload affordance and email attachments. Any future connector that ingests a
  document gets the same extraction for free.

### ⏳ Phase 3 — Reach Jarvis from your phone (Telegram → daemon)
OpenClaw's core UX is "text Jarvis from anywhere." Brain Avatar already runs an
always-on `brain-daemon`; add a Telegram bot bridge there that runs the **same**
agent loop server-side (on the local models) and replies in chat. No new infra,
big experiential leap. _(Design: long-poll/webhook → daemon → agent loop → reply;
auth the chat id; reuse the existing tool surface.)_

### ⏳ Phase 4 — Connector structure + tool routing
As the tool count grows, group tools into **packs** (mail, calendar, CRM, social,
files, system) and add a lightweight pre-router so the local 8B model only sees the
relevant pack per turn — keeps tool-calling accurate at scale, and creates a clean
slot for the deferred **Apollo / CRM** connector.

## Local-model guardrails (apply to everything)

- Granular, single-purpose, well-described tools (small models route these better
  than mega-tools).
- Natural-language identifiers over opaque ids wherever possible.
- Confirm-before-send / -delete in the system prompt.
- Cap attachment size and extracted-text length.
- Keep the **active** tool count per turn bounded (Phase 4 routing) as capabilities
  grow.
