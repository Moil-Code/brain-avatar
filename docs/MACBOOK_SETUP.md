# Brain Avatar — MacBook Client Setup

How to run the Brain Avatar on your MacBook as a thin interface to the brain that
lives on the Mac Mini. One brain, reachable from the laptop anywhere via Tailscale.

Architecture recap: the MacBook app proxies brain/calendar/mail/web/voice calls to a
**brain-daemon** on the Mac Mini (secrets stay there); local file/app/AppleScript/TTS
run on the laptop; the LLM goes straight to LM Studio. See
[MACBOOK_CLIENT_PLAN.md](MACBOOK_CLIENT_PLAN.md) for the full design.

---

## A. Mac Mini (the brain owner) — one-time

1. **Tailscale is up** (it already is — this host is `jarviss-mac-mini`, `100.x.y.z`).
   Confirm: `tailscale status`.

2. **LM Studio must serve on the tailnet, not just localhost.** In LM Studio →
   Developer/Server settings, enable "Serve on Local Network" (binds `0.0.0.0:1234`) so
   the MacBook can reach it over Tailscale. Keep `qwen3-8b-mlx` loaded for a snappy avatar.

3. **Set up + build the daemon, generate the token:**
   ```bash
   cd ~/brain-avatar
   bash daemon/setup-daemon.sh
   ```
   This generates `~/.config/brain-avatar/daemon-token` (chmod 600), builds
   `brain-daemon` (release), and prints the **Daemon URL** + **token** for step B.4.

4. **Install + load the LaunchAgent** (you load plists manually):
   ```bash
   cp daemon/com.moil.brainavatar.daemon.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.moil.brainavatar.daemon.plist
   ```
   The daemon auto-binds to the Tailscale IP (tailnet-only) and restarts on login.

5. **Verify it's serving:**
   ```bash
   curl -s http://100.x.y.z:8787/health      # -> {"ok":true,...}
   ```
   Logs: `~/Library/Logs/brain-daemon.log`.

> Security: the daemon binds to the Tailscale interface only (never `0.0.0.0`/LAN),
> requires the bearer token on every route except `/health`, and the token lives in a
> `0600` file — not in the plist or process args. Secrets (gbrain, m365, Brave, Groq)
> never leave the Mac Mini. Fold the token into the monthly `/cso` credential audit.

> Note: the daemon reads `settings.json` once at startup. If you change the Mac Mini's
> settings in the app (m365 app id, API keys, gbrain path), restart the daemon to pick
> them up: `launchctl kickstart -k gui/$(id -u)/com.moil.brainavatar.daemon`.

---

## B. MacBook (the client) — one-time

1. **Install Tailscale** and sign in to the **same** account; `tailscale up`.
   Confirm it can reach the Mac Mini: `tailscale ping jarviss-mac-mini`.

2. **Install the Brain Avatar app** — build/sign per the main
   [README](../README.md) "Run it" / updater section, or copy the signed `.app`.

3. **Grant macOS permissions** (first launch prompts; or System Settings → Privacy):
   - **Local Network** — to reach the tailnet host (required).
   - **Full Disk Access** — for `read_file` on Documents/Desktop/Downloads.
   - **Automation** — approved per-app the first time AppleScript controls one.
   - **Microphone** — for push-to-talk (`⌘⇧V`).

4. **Settings → Remote brain:**
   - **Daemon URL** = the URL from A.3 (e.g. `http://100.x.y.z:8787`)
   - **Daemon token** = the token from A.3
   - Click **Test connection** → expect "Connected — daemon reachable and token accepted."

5. **Settings → Model** (LLM goes direct, not via the daemon):
   - **Remote URL (primary)** = `http://100.x.y.z:1234/v1` (the tailnet LM Studio)
   - **Remote API token** = the LM Studio token
   - Click **Test connection** → expect the loaded model listed.

That's it. Leave **Remote brain** blank on the Mac Mini's own copy and it runs everything
locally, exactly as before — the same build works in both places.

---

## C. Validation checklist (Phase 5 — run on the MacBook)

Prove the split works, both on home WiFi and tethered to your phone (to confirm remote):

- [ ] "who is <a person in the brain>" → returns the canonical brain page *(brain → daemon)*
- [ ] "what's on my calendar this week" → real events *(m365 → daemon)*
- [ ] "schedule a Teams meeting tomorrow 10am with <someone>" → confirms first, then creates *(daemon, confirm-before-send intact)*
- [ ] "web search moilapp.com" → live results *(Brave → daemon)*  *(needs a Brave key set on the Mac Mini)*
- [ ] Voice: push-to-talk a question → transcribes *(Groq → daemon)* and speaks the answer *(TTS local)*
- [ ] "find <a file> on this Mac and read it" → hits the **laptop's** files, not the Mac Mini *(local tool)*
- [ ] "open Notes" → opens on the **laptop** *(local tool)*
- [ ] Kill the daemon (`launchctl unload …`) → app shows a clear "brain-daemon unreachable" error, not a hang
- [ ] Wrong token in Settings → Test connection reports the 401 clearly

---

## D. Optional follow-up (Mac Mini observability)

Extend the existing freshness sentinel / morning briefing (in `~/My Brain/pi-workspace`)
to also `curl …:8787/health` so a daemon outage surfaces in the morning briefing — same
pattern as the existing `Mac-mini.local:1234` LM Studio check. Not required for the
client to work; it just makes a silent daemon death visible.
