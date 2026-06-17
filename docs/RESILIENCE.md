# Resilience — auto-reconnect after restart / shutdown

Goal: **no long silences.** After the Mac Mini sleeps, reboots, loses power, or LM
Studio restarts, the whole stack should come back **by itself** — without anyone
logging in, reopening the app, or clicking "retry".

This is achieved in two halves:

- **Server side (24GB Mac):** every link in the chain is supervised by `launchd`
  and a keeper loop, so it restarts itself.
- **Client side (avatar app):** it actively watches the endpoint, shows a
  "reconnecting…" banner while the Mac is away, and self-heals the moment it's
  back — including refreshing the model list.

```
power on → macOS auto-login → Tailscale → LM Studio (+model) → lm-queue-proxy :1235 → brain-daemon :8787 → Avatar
            └─ System Settings ─┘  └──────────── lmstudio-keeper + launchd KeepAlive ────────────┘   └─ in-app watcher ─┘
```

Anything earlier in the chain being down means silence downstream, so we harden
every link.

---

## 1. macOS settings (the part code can't do for you)

The daemon, proxy, and keeper are **LaunchAgents** — they only start once a user
is logged into the GUI. So an unattended reboot needs these toggles on the
**Mac Mini**:

1. **Auto-login** — System Settings → Users & Groups → *Automatically log in as* →
   the brain-owner account. Without this, a reboot leaves everything down until a
   human logs in. (Note: auto-login disables FileVault's at-boot unlock — acceptable
   for a always-on box on a trusted network; decide per your security posture.)
2. **Restart after power failure** — System Settings → Energy →
   *Start up automatically after a power failure* → **on**.
3. **Never sleep** — System Settings → Energy → set *Prevent automatic sleeping
   when the display is off* → **on** (or `sudo pmset -c sleep 0`). A sleeping Mac
   drops off the tailnet and the avatar goes quiet.
4. **Wake for network access** — Energy → *Wake for network access* → **on**, as a
   belt-and-suspenders so a tailnet probe can wake it.

---

## 2. Server side — supervise every link (on the 24GB Mac)

All four run as user LaunchAgents. Copy each plist into `~/Library/LaunchAgents/`,
**edit the `USERNAME` / paths inside first**, then `launchctl load` it.

| Link | Plist | Auto-start | Auto-restart on crash |
|---|---|---|---|
| brain-daemon | `daemon/com.moil.brainavatar.daemon.plist` | RunAtLoad | `KeepAlive` |
| lm-queue-proxy | `gateway/com.moil.lm-queue-proxy.plist` | RunAtLoad | `KeepAlive` |
| **LM Studio + model + watchdog** | `gateway/com.moil.lmstudio-keeper.plist` | RunAtLoad | `KeepAlive` + loop |
| Avatar GUI (optional) | `daemon/com.moil.brainavatar.app.plist` | RunAtLoad | — (see file) |

### The keeper is the new piece

`launchd KeepAlive` already restarts the daemon and proxy if they crash — but
nothing supervised **LM Studio**, which is the real single point of failure. The
keeper (`gateway/run-lmstudio-keeper.sh`) loops every 20s and guarantees:

1. Tailscale is up.
2. LM Studio is serving (`lms server start` if `/v1/models` doesn't answer).
3. A chat model is loaded (`lms load $LMS_DEFAULT_MODEL` if none is) — so the first
   message after a reboot isn't a cold start or an empty-server error.
4. The proxy is reachable, else `launchctl kickstart`s it.
5. The daemon is reachable, else `launchctl kickstart`s it.

It trusts the **HTTP endpoints** as ground truth, so it also recovers a
"process running but wedged" state that `KeepAlive` can't detect.

Install it:

```bash
# Edit USERNAME + the script path inside the plist, and set LMS_DEFAULT_MODEL
# (run `lms ls` to find the model key, e.g. qwen3-8b).
cp gateway/com.moil.lmstudio-keeper.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.moil.lmstudio-keeper.plist
tail -f ~/Library/Logs/lmstudio-keeper.log      # watch it work
```

> Order of dependence: load the proxy and daemon plists first, then the keeper —
> the keeper kicks them by `launchctl` label, so they must already be registered.

---

## 3. Make the avatar app relaunch at login

On each **main device** (Mac Mini and MacBook), either:

- **Login Item (simplest):** System Settings → General → Login Items → **+** →
  *Brain Avatar*. Or scripted:

  ```bash
  osascript -e 'tell application "System Events" to make login item at end \
    with properties {path:"/Applications/Brain Avatar.app", hidden:false}'
  ```

- **or the LaunchAgent** `daemon/com.moil.brainavatar.app.plist` (edit nothing if
  the app is in `/Applications`):

  ```bash
  cp daemon/com.moil.brainavatar.app.plist ~/Library/LaunchAgents/
  launchctl load ~/Library/LaunchAgents/com.moil.brainavatar.app.plist
  ```

Use **one** of the two, not both, or the app may launch twice.

---

## 4. Client side — what the app now does automatically

No setup needed; this ships in the app:

- **Active connection watcher.** The avatar polls the 24GB Mac (the cheap, ungated
  `/models` path, so it never queues behind a generation): every 15s while healthy,
  and every 2→4→…→20s while down so it notices a recovery within seconds.
- **"Reconnecting…" banner.** While the Mac is unreachable the app shows an amber
  banner instead of silently failing, and **clears it the instant the Mac is back**.
- **Auto model refresh on recovery.** When the endpoint returns, the model picker is
  re-probed automatically — no need to reopen Settings.
- **Self-healing sends.** If you hit send during a brief blip (wake / model reload),
  endpoint resolution retries across a short backoff before surfacing an error,
  rather than failing on the first miss.

---

## 5. Verify end-to-end

After a deliberate reboot of the 24GB Mac, with nobody touching it:

```bash
# On the 24GB Mac
launchctl list | grep -E 'moil|lm-queue'             # all agents present
curl -s http://127.0.0.1:1234/v1/models | head        # LM Studio up + a model
curl -s http://127.0.0.1:1235/v1/models | head        # proxy up
curl -s "http://$(tailscale ip -4 | head -1):8787/health"   # daemon up
tail -n 30 ~/Library/Logs/lmstudio-keeper.log         # keeper's actions
```

On the MacBook, the avatar's banner should clear on its own within ~15s of the Mac
finishing boot, and a fresh question should answer without a manual retry.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Everything down after reboot until login | auto-login off | §1.1 |
| Keeper log: "no `lms` CLI found" | `lms` not on PATH for the agent | set `LMS_BIN` in the keeper plist |
| Keeper never loads a model | `LMS_DEFAULT_MODEL` empty/wrong | set it to a key from `lms ls` |
| `kickstart failed for <label>` | that plist isn't loaded | load the proxy/daemon plist first |
| Banner stuck on "reconnecting" but Mac is up | wrong Remote URL/token, or Local Network privacy not granted | Settings → Remote brain → Test; grant Local Network access |
