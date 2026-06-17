# lm-queue-proxy — single-flight gateway for LM Studio

LM Studio runs every concurrent request **in parallel** — it never queues. Two
heavy generations at once (the avatar + the MacBook, or the 26B + 12B together)
overwhelm the 24GB Mac's memory and stall the whole box. This is a small,
transparent reverse-proxy that sits in front of LM Studio and **serializes
generation to one request at a time** — the second caller waits instead of piling
on.

It's transparent: it adds no auth of its own and forwards the incoming
`Authorization` header straight to LM Studio, so every client keeps using the
**same LM Studio token** it already uses. Only generation paths
(`…/completions`, `/responses`) are gated; `/models`, `/embeddings`, and health
pass through ungated so the model picker stays instant.

## Two layers of defense

The **brain-daemon already serializes** the interactive clients (the local avatar
and the MacBook both route through it). This proxy closes the remaining gap: the
scheduled **batch jobs** (briefings, KB compile, Chroma index, …) that hit LM
Studio directly. Deploy this and point *everything* — including the daemon — at
the proxy, and you get one global queue in front of the box.

## Deploy (on the 24GB Mac — Mac-mini.local)

Andres runs LM Studio on the 24GB Mac and loads plists there manually:

```bash
# 1. Copy the proxy onto the 24GB Mac (from this repo)
mkdir -p ~/lm-queue-proxy
scp gateway/lm-queue-proxy.py  mac-mini:~/lm-queue-proxy/      # or AirDrop / git pull

# 2. Install the launch agent (edit USERNAME + script path in the plist first)
cp gateway/com.moil.lm-queue-proxy.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.moil.lm-queue-proxy.plist

# 3. Verify it's serializing
tail -f ~/Library/Logs/lm-queue-proxy.log     # expect the "listening …" line
curl -s localhost:1235/v1/models | head        # should list the loaded models
```

Requires `python3` (stdlib only — no pip). Listens on **:1235** by default.

## Point clients at the proxy (after it's up)

Once the proxy is confirmed running on the 24GB Mac, switch upstreams from
`:1234` → `:1235`. **Do these only after the proxy is verified up**, or generation
breaks.

| Client | Where | Change |
|---|---|---|
| **brain-daemon** | `daemon/run-brain-daemon.sh` | `BRAIN_DAEMON_LLM_URL=http://100.x.y.z:1235/v1` (was `:1234`), then `kill <daemon-pid>` to respawn |
| **Batch jobs / Pi** | `~/.openclaw/secrets/lmstudio-remote.env` | `LMSTUDIO_REMOTE_BASE=http://100.x.y.z:1235/v1` (token unchanged) |
| **Avatar / MacBook** | — | No change — they go through the daemon, which now points at the proxy |

The token stays the **LM Studio token** everywhere — the proxy forwards it
untouched. (The daemon keeps its own single-flight lock as belt-and-suspenders;
serializing in series is harmless.)

## Verify end-to-end

Fire two concurrent generations at the proxy; they should complete one after the
other (not together), and the log shows `queued — another generation in flight`.
