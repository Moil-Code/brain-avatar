# Brain Avatar — MacBook Client Implementation Plan

**Goal:** Run the Brain Avatar on Andres' MacBook as a thin interface to the brain that
lives on the Mac Mini, while still being able to act on the MacBook itself.

**Decisions locked in (2026-06-16):**
- Architecture: **thin client → Mac Mini daemon** (one brain, always in sync)
- Reach: **anywhere**, via Tailscale (already installed; `jarviss-mac-mini` @ `100.x.y.z` is online)
- Form factor: **reuse the floating Tauri avatar** (one codebase, two run modes)
- Scope: **both** — answer/calendar/email via the Mac Mini *and* control the MacBook locally

---

## 1. The core idea

The avatar's tools split cleanly into two groups by *where they must run*:

| Group | Tools | Must run on | In remote mode |
|---|---|---|---|
| **Brain-owner tools** | `brain_search`, `brain_page`, `calendar_*`, `create_teams_meeting`, `send_email`, `read_emails`, `send_teams_message`, `create_reminder`, `web_search`, `fetch_url`, `llm_complete`, `llm_probe`, `transcribe_audio` | Mac Mini (PGLite brain, m365 session, LM Studio, API keys) | **proxied** to the Mac Mini daemon over Tailscale |
| **Machine-local tools** | `find_files`, `read_file`, `open_file`, `open_app`, `list_apps`, `run_applescript`, `tts_speak`/`tts_stop`/`list_voices` | Whatever Mac you're sitting at | **stay local** (run on the MacBook) |

So we build **one new thing** — a `brain-daemon` on the Mac Mini that exposes the
brain-owner tools over authenticated HTTP — and add **one new mode** to the existing
Tauri app: when a "Brain daemon URL + token" is set, the brain-owner tools call the daemon
instead of running locally. The machine-local tools never change.

The agent loop (`src/lib/agent.ts`) and the entire React UI are **untouched**. The only
swap happens behind the Rust `#[tauri::command]` handlers (or, equivalently, behind a small
transport switch). This keeps the diff small and the two builds identical except for config.

```
                    Tailscale tunnel (encrypted)
  MacBook                    │                      Mac Mini (jarviss-mac-mini)
  ┌────────────────────┐     │      ┌──────────────────────────────────────────┐
  │ Brain Avatar (same │     │      │ brain-daemon (Axum, :8787, tailnet-bound) │
  │ Tauri app, REMOTE  │ ─── │ ───► │  /brain/* /calendar/* /mail/* /web/*      │
  │ mode)              │     │      │  /llm/*   /stt/*       (bearer auth)       │
  │                    │     │      │      │       │        │        │           │
  │ local tools run    │     │      │   gbrain   m365   Brave/Groq  LM Studio    │
  │ ON the MacBook:    │     │      │  (PGLite) (Graph)   (HTTP)   (:1234)       │
  │ files, apps,       │     │      └──────────────────────────────────────────┘
  │ AppleScript, TTS   │     │
  └────────────────────┘     │      Both still POST history → Vercel/Supabase
                                    (conversation continuity across devices, already built)
```

---

## 2. Why this shape (review of alternatives)

- **Independent brain on the MacBook** — rejected: two PGLite brains drift, you'd duplicate
  m365 login + LM Studio + every API key, and the laptop can't host the 24GB heavy tier.
- **Cloud relay via Supabase only** — rejected as the primary path: adds round-trip latency
  to every query and a cloud dependency for core reasoning. We *keep* Supabase for history
  sync (it's already wired and gives free cross-device continuity), but answers come straight
  from the daemon over Tailscale.
- **Build the daemon in Node/TS** — rejected: it would reimplement the gbrain/m365 shelling
  that already exists in Rust. Reusing the Rust tool functions is less code and one language.

---

## 3. Work breakdown

### Phase 0 — Network foundation (Tailscale)  · ~30 min · low risk
1. Confirm the brain owner (this Mac Mini, `jarviss-mac-mini`) is up on the tailnet and note
   its MagicDNS name (`tailscale status --json | …`, e.g. `jarviss-mac-mini.<tailnet>.ts.net`).
2. Install Tailscale on the MacBook and `tailscale up` under the same account; verify it can
   reach the Mac Mini (`tailscale ping jarviss-mac-mini`).
3. Decide transport: plain HTTP over the tailnet (already E2E-encrypted) **+ bearer token**
   is acceptable. Optional hardening: `tailscale serve` to put TLS in front of `:8787`.
4. Keep-awake: the Mac Mini must stay reachable. The existing morning-briefing sentinel
   already watches `Mac-mini.local:1234`; extend it to also curl the daemon health route.

### Phase 1 — Refactor tool functions out of Tauri `State`  · ~half day · medium risk
The tool fns in `src-tauri/src/tools.rs` currently take `State<'_, SettingsState>`. To call
them from *both* the Tauri command layer and the daemon, extract the logic to take `&Settings`:

- For each handler, split into `pub async fn brain_search_core(settings: &Settings, query, limit) -> Result<String,String>` (pure, no Tauri) and keep the existing `#[tauri::command]` as a 2-line wrapper that locks state and calls `_core`.
- Move these `_core` fns into a small internal module (e.g. `tools_core.rs`) or a `brain-core`
  library crate in the workspace. A crate is cleaner long-term; a module is the smaller diff —
  **start with a module**, promote to a crate only if needed.
- No behavior change — this is a pure refactor. Verify the existing app still builds and runs
  (`npm run tauri dev`) before moving on.

### Phase 2 — Build `brain-daemon`  · ~1 day · medium risk
A new binary target in `src-tauri/` (or a sibling crate) using **Axum**:

- Routes (all `POST`, JSON in/out, mirroring the tool args already defined in `src/lib/tauri.ts`):
  `/brain/search`, `/brain/page`, `/calendar/events|create|update|delete`,
  `/calendar/teams-meeting`, `/mail/send|read`, `/reminder/create`, `/teams/message`,
  `/web/search`, `/web/fetch`, `/llm/complete`, `/llm/probe`, `/stt/transcribe`,
  plus `/health`.
- Each handler loads the daemon's own `Settings` (the Mac Mini's keys/paths) and calls the
  matching `_core` fn from Phase 1. **Secrets stay on the Mac Mini** — never sent to the laptop.
- **Auth:** require `Authorization: Bearer <DAEMON_TOKEN>` on every route except `/health`;
  reject otherwise. Generate the token with `openssl rand -hex 32`.
- **Bind to the tailnet interface only** (the Tailscale IP / `100.x`), not `0.0.0.0`, so it's
  never exposed on the LAN or the public internet.
- Run it as a launchd job on the Mac Mini (`com.moil.brainavatar.daemon.plist`) — matches the
  existing automation pattern. *(Andres loads/unloads plists manually — no `launchctl` from here.)*
- The daemon is read/act-only over HTTP; it reuses the existing PGLite single-writer retry
  logic, so a concurrent Claude Code `gbrain` session degrades gracefully (as today).

### Phase 3 — Remote mode in the Tauri app  · ~half day · low-medium risk
- Add to `config.rs` `Settings`: `brain_daemon_url: String` and `brain_daemon_token: String`
  (default empty = local mode, i.e. today's behavior — Mac Mini build needs no change).
- In each brain-owner `#[tauri::command]`: if `brain_daemon_url` is set, `POST` to the daemon
  and return its JSON; else call the local `_core` fn. (One tiny `proxy_or_local!` helper.)
- Machine-local tools (`files.rs`, `tts.rs`, AppleScript in `tools.rs`) are **left alone** —
  they always run locally, which is exactly what "control the MacBook too" requires.
- Point `/llm/*` through the daemon so the MacBook needs **one host + one token** total
  (no separate LM Studio endpoint/token config on the laptop).
- Add the two fields to `Settings.tsx` under a new "Remote brain" section + a "Test connection"
  button hitting `/health`.

### Phase 4 — Package & ship the MacBook build  · ~half day · medium risk
- Build the signed `.app` (existing self-signed "Brain Avatar Code Signing" identity +
  updater key flow already documented in the README).
- On the MacBook, grant the native permissions the local tools need: Local Network (to reach
  the tailnet host), Full Disk Access (file reads), Automation (AppleScript per-app prompts),
  Microphone (push-to-talk). Same list the README already documents for the Mac Mini.
- Reuse the existing GitHub Releases updater — the MacBook gets one-click updates too. No
  second pipeline.

### Phase 5 — Verify end to end  · ~2 hours
- From the MacBook (on home WiFi *and* tethered to phone to prove remote): "who is <person>"
  (brain_page via daemon), "what's on my calendar this week" (m365 via daemon), "schedule a
  Teams meeting…" (confirm-before-send path), "web search moilapp.com" (Brave via daemon).
- Local-tool proof on the MacBook: "find the file X on this Mac and read it", "open Notes" —
  confirm these hit the *laptop*, not the Mac Mini.
- History continuity: a turn on the MacBook shows up in the same Supabase conversation as the
  Mac Mini.
- Failure modes: Mac Mini asleep → clear "brain unreachable" message; bad token → 401 surfaced
  in UI, not a silent hang.

---

## 4. Security review (the daemon handles real CRM + email + calendar)

- **Exposure:** bind to the Tailscale interface only; never `0.0.0.0`. No router port-forwarding.
- **Auth:** bearer token on every route; 401 on mismatch; token stored in Rust settings (not JS),
  same as existing secrets.
- **Transport:** Tailscale (WireGuard) encrypts in transit; optional `tailscale serve` TLS on top.
- **Blast radius:** the daemon can send email/Teams and create/delete calendar events. The agent
  already **confirms before any send/delete** — keep that guard; the daemon is dumb and only acts
  on an explicit tool call. Consider an allowlist of which routes the daemon will serve.
- **Secrets never leave the Mac Mini:** the MacBook holds only the daemon URL + daemon token,
  not the Groq/Brave/m365/LM Studio credentials.
- **Audit:** have the daemon log every tool call (route, timestamp, caller) to a local file for
  later review.
- Fold this into the existing `/cso` monthly Brain credential audit.

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Mac Mini asleep/offline → no brain | Extend the existing sentinel to alert in the morning briefing; clear UI error, not a hang |
| PGLite single-writer lock vs Claude Code sessions | Reuse existing retry logic; daemon inherits "brain is busy" backoff |
| Phase 1 refactor regresses the working app | Pure refactor; build + smoke-test the Mac Mini app before Phase 2 |
| Token leak | Tailnet-only binding means a leaked token is useless without tailnet access; rotate via settings |
| Latency on heavy (Gemma 26B) answers | Router already prefers fast `qwen3-8b`; unchanged, and now measured over the tunnel |
| Two app instances writing history | Conversation IDs already namespace turns; verify in Phase 5 |

## 6. Effort estimate

~**2.5–3 focused days**. Critical path: Phase 1 refactor → Phase 2 daemon → Phase 3 remote
mode. Phases 0/4/5 are setup and verification around them. Worktree-isolated per
`~/CLAUDE.md`; conventional commits; no auto-push to main without your go-ahead.

## 7. Recommended first step

Phase 0 + Phase 1: get the MacBook on the tailnet and do the pure Rust refactor (lowest risk,
unblocks everything). Ship nothing user-facing yet, just prove the seam is clean.
