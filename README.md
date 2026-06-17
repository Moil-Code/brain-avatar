# Brain Avatar 🧠

A floating, always-on-top desktop avatar for macOS that answers questions about your
**brain** (gbrain knowledge base), your **calendar** (Microsoft 365), and the **web** —
powered by your **local LM Studio models**. Talk to it by voice or text. Summon it from
anywhere with `⌘⇧Space`.

```
┌──────────────────────────────────────────────────────────────┐
│  Brain Avatar  (Tauri: Rust shell + React UI)                 │
│  • frameless, transparent, always-on-top floating window      │
│  • global hotkey ⌘⇧Space · system tray · push-to-talk         │
└───────────┬──────────────────────────────────────────────────┘
            │ Rust commands (subprocess / HTTP)
   ┌────────┼───────────────┬───────────────┬──────────────┐
   ▼        ▼               ▼               ▼              ▼
LM Studio   gbrain          m365 request    Brave API     Groq Whisper
:1234       call query      /calendarView   (web search)  (speech→text)
(generate)  (brain RAG)     (calendar)                    + speechSynthesis (TTS)
  + remote                                                
  fallback         (chat history / sync only) ──► Vercel API ──► Supabase
```

The model runs a **tool-calling loop**: your question → the local model decides which
tool to call (`brain_search`, `calendar_events`, `web_search`) → Rust executes it →
results feed back → the model writes a grounded answer, which is shown and spoken.

---

## What you need to do (one-time setup)

Everything is built. These are the only manual steps:

### 1. Enter your API keys (in the app)
Launch the app, open **Settings** (gear icon or tray → Settings…), and fill in:

| Field | Where to get it | Required? |
|---|---|---|
| **Remote URL (primary)** | `http://Mac-mini.local:1234/v1` (pre-filled) — the 24GB Mac | yes |
| **Remote API token** | the LM Studio API token from the 24GB Mac | yes (auth required) |
| **Local URL (fallback)** | `http://localhost:1234/v1` — this host | optional |
| **Groq API key** | <https://console.groq.com/keys> | only for voice |
| **Brave API key** | <https://brave.com/search/api/> | only for web search |
| **gbrain / m365 path** | pre-filled (`~/.bun/bin/gbrain`, `/opt/homebrew/bin/m365`) | yes |
| **Vercel API URL / Sync token** | from steps 2–3 below | only for history sync |

The app works **fully locally** without Groq/Brave/Vercel — those just add voice, web,
and cloud history.

### 2. Create the Supabase database
1. Create a project at <https://supabase.com>.
2. Open the **SQL Editor** and run [`backend/supabase/schema.sql`](backend/supabase/schema.sql).
   The script is idempotent — **re-run it after updating the app** to apply migrations
   (e.g. the `message_id` dedup key that stops retried turns from being written twice).
3. Copy your **Project URL** and **service-role key** (Settings → API).

### 3. Deploy the backend to Vercel
```bash
cd backend
vercel deploy --prod
```
Then in the Vercel dashboard → **Settings → Environment Variables**, set the three
values from [`backend/.env.example`](backend/.env.example):
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SYNC_TOKEN` (invent a long random string —
`openssl rand -hex 32`). Redeploy. Put the deployment URL + the same `SYNC_TOKEN` into the
app's Settings (**Vercel API URL** / **Sync token**).

### 4. Push to GitHub
```bash
gh repo create brain-avatar --private --source . --remote origin --push
```
If your repo isn't `Moil-Code/brain-avatar`, update the updater endpoint owner/repo in
`src-tauri/tauri.conf.json` (`plugins.updater.endpoints`).

## Smooth updates (the in-app "Update" button)

The app is signed with a **stable self-signed identity** ("Brain Avatar Code Signing"), so
updates no longer reset your macOS permissions. On launch it checks GitHub Releases; when a
newer version is published, an **Update** banner appears — one click downloads, installs, and
relaunches. To publish an update, run the one-command publisher on the Mac Mini:

```bash
scripts/publish-release.sh 0.1.7     # the new version number
```
It bumps the version (`tauri.conf.json` + `Cargo.toml` + `package.json`), builds the signed
app + updater artifacts, creates the GitHub Release, and uploads a `latest.json` manifest with
the signature embedded inline — so the `releases/latest/download/latest.json` endpoint the app
polls serves the new version and every Brain Avatar (Mac Mini + MacBook) auto-installs it on
next launch. The public key is already baked into the app; keep
`~/.tauri/brain-avatar-updater.key` secret — it signs every update.

> The script commits the version bump and tries to `git push origin main`, but **still
> publishes the release even if the push fails** (so you can ship offline and push later). If
> you ship without pushing, push the `chore: release vX` commit before the next release so the
> repo and the published artifact don't drift.

---

### Enable calendar scheduling (Teams meetings + invites)

The avatar can *read* your calendar out of the box, but **creating/editing/deleting events
and sending Teams invites needs the `Calendars.ReadWrite` scope**, which the m365 CLI's
built-in app doesn't request. One-time setup (you're the Moil admin):

1. **entra.microsoft.com → App registrations → New registration** — name "Brain Avatar
   Scheduler", single-tenant. Under **Authentication**, add a **Mobile/desktop** platform
   with redirect `http://localhost`, and set **Allow public client flows = Yes**.
2. **API permissions → Add → Microsoft Graph → Delegated** → add `Calendars.ReadWrite`,
   `OnlineMeetings.ReadWrite`, `Mail.Send`, `User.Read` → **Grant admin consent**.
3. Copy the **Application (client) ID** → paste it into the app's **Settings → Local tools →
   M365 app id**.
4. In a terminal, log m365 in with that app once:
   ```bash
   CLIMICROSOFT365_ENTRAAPPID=<that-app-id> m365 login
   ```
   (The app passes the same id to m365 on every call, so it uses these scopes.)

After that, "schedule a Teams meeting with X tomorrow at 10am and invite them" works
end to end — real event on your calendar, Teams link, invite emailed.

## Automations (the proactive layer) ⏰

Brain can now run tasks **on its own schedule** and deliver the results — the first step
toward a real Jarvis instead of a purely reactive assistant. Open the **⏰ Automations** tab
(title bar) or just ask by voice: *"every Monday at 9, email me my Facebook metrics."*

- **Schedules**: daily, weekly, hourly, or every-N-minutes. If the app was closed at the
  scheduled minute, the run still fires when you reopen it (within a 6-hour catch-up window).
- **Delivery** (any combination): **speak** it aloud, a macOS **notification**, **email** it
  to you, and/or write it to your **brain**.
- **One-click presets**: a daily **Morning briefing** (calendar + overnight email + top
  commitments), **Weekly Facebook metrics**, and an **End-of-day capture** into the brain.
- The model can create them itself with `create_automation` and tell you what's running with
  `list_automations`. Each run executes the full tool-calling loop, so an automation can do
  anything you can ask for live.

Automations run **while the avatar app is open** (its normal always-on state). They're stored
in `automations.json` next to `settings.json`.

### Facebook metrics (read-only)

`facebook_insights` reads a Page's follower count, 28-day reach, impressions, post engagement,
and recent-post performance — *"how's the moil page doing this week?"* It reuses the same Page
tokens as posting (`~/.openclaw/secrets/facebook.env`). Reach/engagement numbers require the
Page token to carry the **`read_insights`** permission; if it doesn't, Brain still reports the
follower count and tells you what to re-grant.

## Run it

```bash
# Development (hot reload)
npm install
npm run tauri dev

# Build a distributable .app / .dmg
npm run tauri build
# → src-tauri/target/release/bundle/{macos,dmg}/
```

Prerequisites (already present on this machine): Node, Rust toolchain, LM Studio,
`gbrain` CLI, `m365` CLI authenticated as you.

---

## How it works

- **Brain** — shells out to `gbrain call query '{...}'` (hybrid vector+keyword search over
  your PGLite brain). Retries automatically if a Claude Code session is holding the
  single-writer PGLite lock.
- **Calendar** — read via `m365` → Graph `/me/calendarView`. **Scheduling** (create/edit/
  delete events, real **Teams** meetings, invite attendees) also goes through Graph but needs
  the `Calendars.ReadWrite` scope (see "Enable calendar scheduling" below). `create_teams_meeting`
  (a standalone Teams join link) works today with the existing `OnlineMeetings.ReadWrite` scope.
- **Web** — Brave Search API.
- **Voice in** — records the mic, sends to Groq Whisper for transcription.
- **Voice out** — native macOS `say` (Rust), which can use the high-quality
  **Enhanced/Premium voices** (download one free in System Settings → Accessibility →
  Spoken Content → System Voice → Manage Voices, then pick it in **Settings → Voice**).
- **Computer access** — the model can `find_files` (Spotlight + a native, permission-safe
  directory walk), `read_file` (text, Markdown, Word/RTF/HTML; PDF if `pdftotext`/poppler
  is installed), `open_file`, `open_app`/`list_apps`, and `run_applescript` to control Mac
  apps (create a note, add a reminder/calendar event, etc.). "Find my X and read it to me"
  works end to end. macOS asks you to allow controlling each new app the first time
  (Automation prompt). The avatar confirms before any send/post/delete. File reads need
  **Full Disk Access** (System Settings → Privacy) for Documents/Desktop/Downloads.
- **Hotkeys** — `⌘⇧Space` summon/hide · `⌘⇧V` summon + talk (press to speak, press again
  to send). No always-on mic.
- **LLM** — OpenAI-compatible LM Studio. The **remote 24GB Mac (`Mac-mini.local:1234`)**
  is the **primary** endpoint (with bearer token); the app auto-uses whichever model is
  loaded. For a **snappy** avatar, keep **`qwen3-8b`** loaded (fast + reliable tool calls);
  Gemma 26B works but each answer can take 30–110s.
  - **On a MacBook that isn't on the Mac Mini's LAN** (i.e. remote/travelling), `Mac-mini.local`
    mDNS won't resolve. Use **remote mode**: point the app at the **brain-daemon** over Tailscale
    (`http://<mac-mini-tailscale-ip>:8787`, printed by `daemon/setup-daemon.sh`) — the daemon
    holds the secrets and proxies the tools/LLM. The `.local` hostname only works for an
    interactive app sharing the Mac Mini's local network (with Local Network permission granted).
- **History** — each turn is POSTed to the Vercel API → Supabase (deduped by a stable
  message id, so retries/re-syncs never double-write). **Cross-device:** the chat list and
  each conversation's turns are pulled back from the cloud and merged with the local copy,
  so a chat started on one Mac shows up — and continues — on another; deleting a chat
  removes it everywhere. All of this is skipped silently when sync isn't configured, so the
  app stays fully usable offline. _After updating, re-run [`backend/supabase/schema.sql`](backend/supabase/schema.sql)
  to add the `conversation_summaries` view that powers the cross-device list._

## Troubleshooting

- **"No LM Studio endpoint is reachable"** — make sure the 24GB Mac is awake and serving;
  confirm `curl -H "Authorization: Bearer <token>" http://Mac-mini.local:1234/v1/models`
  returns JSON. Set the same token in the app's Settings.
- **"The brain is busy"** — a Claude Code `gbrain` MCP session holds the PGLite lock.
  It retries; if it persists, close that session momentarily.
- **Calendar empty/erroring** — run `m365 status`; re-`m365 login` if your session expired.
- **No voice / robotic voice** — set the Groq API key for voice input; for natural output,
  download an Enhanced/Premium voice in System Settings and pick it in Settings → Voice.
- **"No LM Studio endpoint reachable" after a rebuild** — the app needs **Local Network**
  permission to reach `Mac-mini.local`. Click **Allow** on the prompt, or enable Brain Avatar
  under System Settings → Privacy & Security → Local Network. (Re-prompts only because dev
  rebuilds re-sign the app; a signed release asks once.)
- **Can't find files in Documents/Desktop/Downloads** — grant **Brain Avatar → Full Disk
  Access** in System Settings → Privacy & Security, then relaunch.
- **Can't control an app** — approve the macOS "Brain Avatar wants to control X" prompt, or
  enable it under System Settings → Privacy & Security → Automation.
- **Answers are slow** — Gemma 26B is a big reasoning model; load `qwen3-8b` on the 24GB
  Mac for near-instant responses (the app auto-detects the loaded model).
- **Long silence after a reboot/shutdown** — set up auto-restart so the whole chain comes
  back by itself. See **[docs/RESILIENCE.md](docs/RESILIENCE.md)** (macOS auto-login + the
  `lmstudio-keeper` agent + the app's built-in reconnect watcher).

---

Built for Andres Urrego / Moil.
