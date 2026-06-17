# Brain Avatar on iPhone 📱

Run Brain from your phone, anywhere, exactly like the MacBook does in **remote
mode** — the iPhone is a thin client that talks to the Mac Mini's **brain‑daemon**
over **Tailscale**. All the heavy lifting (the LLM on the 24GB Mac, the brain,
calendar, mail, web) stays on your machines; the phone just sends requests over
the tailnet and shows/speaks the answer.

```
 iPhone (Brain Avatar, Tauri iOS)                Your Macs
 ┌────────────────────────────┐   Tailscale    ┌───────────────────────────┐
 │ React UI + agent loop      │  (100.x.y.z)   │ brain-daemon :8787        │
 │ • types/voice → agent      │ ─────────────▶ │  • /brain /calendar /mail │
 │ • tools  → daemon proxy    │                │  • /web  /stt  /v1 (LLM)  │
 │ • LLM    → daemon /v1      │ ◀───────────── │ relays → LM Studio (24GB) │
 └────────────────────────────┘                └───────────────────────────┘
```

> **Everything in the app and the build config is already done.** This page is the
> one‑time setup that only you can do (Apple account, your Mac, your iPhone). Once
> it's running, opening the app from your phone "just works" as long as the Mac
> Mini is awake with the daemon + LM Studio running.

---

## 0. Prerequisites

On the **Mac you build from** (your MacBook or the Mac Mini — must be macOS):

- **Xcode** (full app from the App Store, not just the CLI tools) + once:
  ```bash
  sudo xcodebuild -runFirstLaunch
  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
  xcodebuild -license accept
  ```
- **Rust** + the iOS targets:
  ```bash
  rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
  ```
- **Node** (already used for the desktop app) and **CocoaPods** (Tauri iOS needs it):
  ```bash
  brew install cocoapods
  ```
- An **Apple ID**. A free one works (the app then expires after **7 days** and you
  re‑run it from Xcode to refresh). Your Moil **Apple Developer** account ($99/yr)
  gives a **1‑year** signing and is the better choice for daily use.
- Your **iPhone**, and a **USB cable** for the first install.

On **both the Mac Mini and the iPhone**:

- **Tailscale**, signed into the **same tailnet**. Install the Tailscale app on the
  iPhone from the App Store and sign in. Confirm the Mac Mini shows up:
  ```bash
  tailscale status        # note the Mac Mini's 100.x.y.z address
  ```
- The **brain‑daemon already running** on the Mac Mini (you set this up via
  `daemon/setup-daemon.sh`; it binds to the tailnet on `:8787` and needs a token).
  Have the daemon **URL** (`http://100.x.y.z:8787`) and **token** ready.

---

## 1. Generate the iOS project (one time)

From the repo root on your Mac:

```bash
npm install
npm run ios:init
```

This creates the Xcode project under `src-tauri/gen/apple/`. (It uses
`src-tauri/tauri.ios.conf.json`, which strips the macOS‑only speak sidecar and
makes the window full‑screen — already wired up for you.)

### (Optional) enable the microphone for voice input

Push‑to‑talk on the phone needs a microphone usage string. After `ios:init`, run:

```bash
./scripts/ios-add-permissions.sh
```

(or add the `NSMicrophoneUsageDescription` key by hand in
`src-tauri/gen/apple/brain-avatar_iOS/Info.plist`). Text chat works without this;
the avatar still **speaks** its replies using the iPhone's built‑in voice.

---

## 2. Set up signing (one time)

Open the generated project in Xcode:

```bash
open src-tauri/gen/apple/brain-avatar.xcodeproj
```

- Select the **brain-avatar_iOS** target → **Signing & Capabilities**.
- Tick **Automatically manage signing**.
- Pick your **Team** (your Apple ID / Moil developer team). Xcode creates the
  provisioning profile.

If the bundle id `com.moil.brainavatar` is taken under a free account, change it to
something unique like `com.moil.brainavatar.<yourinitials>` in Xcode (Signing) and
in `src-tauri/tauri.conf.json` (`identifier`).

Prefer the CLI? Instead of opening Xcode you can export your 10‑char team id:
```bash
export APPLE_DEVELOPMENT_TEAM=XXXXXXXXXX   # Apple Developer → Membership → Team ID
```

---

## 3. Run it on your iPhone

Plug the iPhone in (trust the Mac if asked), then:

```bash
npm run ios:dev        # pick your iPhone from the device list
```

First launch only: on the iPhone, **Settings → General → VPN & Device Management →**
trust your developer certificate. Then the app opens.

For an install that stays on the phone (no Mac tethered), use Xcode's **Run** ▶ or
**Product → Archive** to your device, or:
```bash
npm run ios:build
```
and install the resulting `.ipa` from Xcode's Organizer / Devices window.

---

## 4. Point the app at your daemon (in‑app Settings)

Open the app → **⚙ Settings** and fill in (use your Mac Mini's tailnet IP):

| Field | Value |
|---|---|
| **Remote URL (primary)** | `http://100.x.y.z:8787/v1` |
| **Remote API token** | *your daemon token* |
| **Daemon URL** (Remote brain section) | `http://100.x.y.z:8787` |
| **Daemon token** | *the same daemon token* |
| **Local URL (fallback)** | *leave blank* |

Tap **Test connection** in both the Model section and the Remote brain section —
you should get ✅ on each. Save.

That's it. The same daemon serves both the **tools** (brain/calendar/mail/web) and
the **LLM** (its `/v1` relays to LM Studio on the 24GB Mac), so everything flows
over the tailnet — no secrets ever live on the phone except the daemon token.

---

## 5. Daily use

- Open Brain Avatar on the phone (on Wi‑Fi or cellular). Tailscale connects you to
  the tailnet automatically.
- Type or hold to talk. The agent loop runs on the phone; tool calls and the model
  run on your Macs.
- **Requirement:** the Mac Mini must be **awake** with the **daemon** and **LM
  Studio** running (its normal always‑on state). If the phone says it can't reach
  the daemon, the Mac is asleep or Tailscale is down.

---

## What works from the phone — and what doesn't

**Available on iPhone** (everything the daemon serves):
brain search / pages, calendar (read + create/edit/delete + Teams meetings),
email (read/open/send), reminders, Teams messages, web search + browse, Facebook
metrics, and creating/listing automations.

**Mac‑only (intentionally hidden on the phone):** local file search, reading Mac
files, opening apps, AppleScript control, local image generation, and X bookmarks —
these need the Mac itself, so the phone build doesn't offer them (the model won't
try to use them). Use the desktop app for those.

**Voice:** push‑to‑talk uses the daemon's Groq transcription (same as the MacBook).
Spoken replies use the iPhone's built‑in speech voice (the macOS Premium "say"
voices are desktop‑only).

---

## Troubleshooting

- **"brain‑daemon unreachable" / can't reach the model** — the Mac Mini is asleep,
  the daemon isn't running, or Tailscale is off on the phone. Check the Tailscale app
  shows "Connected", and on the Mac: `tailscale status` and that the daemon process
  is up (`launchctl list | grep brainavatar`).
- **App won't launch / "Untrusted Developer"** — Settings → General → VPN & Device
  Management → trust your cert.
- **App vanished after a week** — that's the free‑Apple‑ID 7‑day limit; re‑run
  `npm run ios:dev` (or Xcode Run) to refresh, or use the paid developer account.
- **No microphone prompt / voice input does nothing** — you skipped step 1's
  permission step; add `NSMicrophoneUsageDescription` and rebuild. Text + spoken
  replies still work without it.
- **Signing errors in `ios:dev`** — open the `.xcodeproj` once, set Team under
  Signing & Capabilities, then re‑run.
- **New version of the app** — there's no in‑app auto‑updater on iOS; rebuild with
  `npm run ios:dev` / Xcode to push a new build to the phone.
