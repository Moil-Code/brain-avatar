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

---

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
- **Calendar** — `m365 request` against Graph `/me/calendarView` using your existing
  browser auth. No extra credentials.
- **Web** — Brave Search API.
- **Voice in** — records the mic, sends to Groq Whisper for transcription.
- **Voice out** — the macOS system voice via the webview's `speechSynthesis`.
- **LLM** — OpenAI-compatible LM Studio. The **remote 24GB Mac (`Mac-mini.local:1234`)**
  runs the heavy human-facing model (Gemma) and is the **primary** endpoint (with bearer
  token); the local host is only a fallback.
- **History** — each turn is POSTed to the Vercel API → Supabase. Skipped silently if not
  configured, so the app is fully usable offline.

## Troubleshooting

- **"No LM Studio endpoint is reachable"** — make sure the 24GB Mac is awake and serving;
  confirm `curl -H "Authorization: Bearer <token>" http://Mac-mini.local:1234/v1/models`
  returns JSON. Set the same token in the app's Settings.
- **"The brain is busy"** — a Claude Code `gbrain` MCP session holds the PGLite lock.
  It retries; if it persists, close that session momentarily.
- **Calendar empty/erroring** — run `m365 status`; re-`m365 login` if your session expired.
- **No voice** — set the Groq API key in Settings; grant the app microphone permission.

---

Built for Andres Urrego / Moil.
