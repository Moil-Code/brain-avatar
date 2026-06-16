import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import Avatar from "./components/Avatar";
import ChatPanel from "./components/ChatPanel";
import SettingsView from "./components/Settings";
import TitleBar from "./components/TitleBar";
import { runAgent } from "./lib/agent";
import { featureFlags, fetchMessages, getSettings, saveMessage } from "./lib/tauri";
import { primeVoices, speak, startRecording, stopSpeaking, type Recorder } from "./lib/voice";
import { checkForUpdate, installUpdate, type Update } from "./lib/updater";
import type { AvatarState, ChatMessage, FeatureFlags, Settings, UiMessage } from "./lib/types";

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function getConversationId(): string {
  let id = localStorage.getItem("conversationId");
  if (!id) {
    id = uid();
    localStorage.setItem("conversationId", id);
  }
  return id;
}

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [features, setFeatures] = useState<FeatureFlags>({
    voice: false,
    web: false,
    sync: false,
    remoteLlm: false,
  });
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [avatarState, setAvatarState] = useState<AvatarState>("idle");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [update, setUpdate] = useState<Update | null>(null);
  const [updating, setUpdating] = useState(false);

  const modelHistory = useRef<ChatMessage[]>([]);
  const recorderRef = useRef<Recorder | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const conversationId = useRef<string>(getConversationId());
  const toggleMicRef = useRef<() => void>(() => {});

  // --- bootstrap ---
  useEffect(() => {
    primeVoices();
    (async () => {
      try {
        const s = await getSettings();
        setSettings(s);
        setFeatures(await featureFlags());
        if (!s.lm_studio_local_url) setShowSettings(true);
        const prior = await fetchMessages(conversationId.current, 50).catch(() => []);
        if (prior.length) {
          const turns = prior.filter((m) => m.role === "user" || m.role === "assistant");
          setMessages(
            turns.map((m) => ({ id: uid(), role: m.role as "user" | "assistant", content: m.content }))
          );
          modelHistory.current = turns.map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          }));
        }
      } catch (e) {
        console.error("bootstrap failed", e);
      }
    })();
    checkForUpdate().then(setUpdate);
    const unlistenSettings = listen("open-settings", () => setShowSettings(true));
    const unlistenVoice = listen("toggle-voice", () => toggleMicRef.current());
    return () => {
      unlistenSettings.then((f) => f());
      unlistenVoice.then((f) => f());
    };
  }, []);

  const patchMessage = (id: string, patch: Partial<UiMessage>) =>
    setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, ...patch } : m)));

  const handleSend = useCallback(
    async (text: string) => {
      if (!settings || busy) return;
      const userMsg: UiMessage = { id: uid(), role: "user", content: text };
      const botId = uid();
      const botMsg: UiMessage = { id: botId, role: "assistant", content: "", pending: true, tools: [] };
      setMessages((ms) => [...ms, userMsg, botMsg]);
      setBusy(true);
      setAvatarState("thinking");
      stopSpeaking();

      const ac = new AbortController();
      abortRef.current = ac;
      const priorHistory = [...modelHistory.current];

      let streamed = "";
      try {
        const result = await runAgent({
          userText: text,
          history: priorHistory,
          settings,
          signal: ac.signal,
          onState: (s) => setAvatarState(s),
          onToken: (delta) => {
            streamed += delta;
            patchMessage(botId, { content: streamed });
          },
          onToolStart: (name) =>
            setMessages((ms) =>
              ms.map((m) =>
                m.id === botId
                  ? { ...m, tools: m.tools?.includes(name) ? m.tools : [...(m.tools ?? []), name] }
                  : m
              )
            ),
        });

        const answer = result.content || streamed || "(no response)";
        patchMessage(botId, { content: answer, pending: false, tools: result.tools });

        modelHistory.current = [
          ...priorHistory,
          { role: "user", content: text },
          { role: "assistant", content: answer },
        ];

        saveMessage(conversationId.current, "user", text).catch(() => {});
        saveMessage(conversationId.current, "assistant", answer).catch(() => {});

        speak(answer, {
          onStart: () => setAvatarState("speaking"),
          onEnd: () => setAvatarState("idle"),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.toLowerCase().includes("abort")) {
          patchMessage(botId, { content: streamed || "(stopped)", pending: false });
        } else {
          patchMessage(botId, { content: `⚠️ ${msg}`, pending: false });
        }
        setAvatarState("idle");
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [settings, busy]
  );

  const handleToggleMic = useCallback(async () => {
    if (recording) {
      setRecording(false);
      setAvatarState("thinking");
      try {
        const rec = recorderRef.current;
        recorderRef.current = null;
        const text = (await rec?.stopAndTranscribe())?.trim();
        if (text) handleSend(text);
        else setAvatarState("idle");
      } catch (e) {
        console.error(e);
        setAvatarState("idle");
      }
      return;
    }
    try {
      stopSpeaking();
      recorderRef.current = await startRecording();
      setRecording(true);
      setAvatarState("listening");
    } catch (e) {
      console.error("mic failed", e);
      setAvatarState("idle");
    }
  }, [recording, handleSend]);
  toggleMicRef.current = handleToggleMic;

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    stopSpeaking();
    setBusy(false);
    setAvatarState("idle");
  }, []);

  if (!settings) {
    return (
      <div className="app glass">
        <div className="boot">Starting Brain…</div>
      </div>
    );
  }

  return (
    <div className="app glass">
      <TitleBar onOpenSettings={() => setShowSettings(true)} />
      {update && (
        <div className="update-banner">
          <span>✨ Update {update.version} available</span>
          <button
            disabled={updating}
            onClick={async () => {
              setUpdating(true);
              try {
                await installUpdate(update);
              } catch (e) {
                console.error("update failed", e);
                setUpdating(false);
              }
            }}
          >
            {updating ? "Updating…" : "Update"}
          </button>
        </div>
      )}
      <Avatar state={avatarState} onClick={() => !busy && !recording && handleToggleMic()} />
      <ChatPanel
        messages={messages}
        busy={busy}
        recording={recording}
        voiceEnabled={features.voice}
        onSend={handleSend}
        onToggleMic={handleToggleMic}
        onStop={handleStop}
      />
      {showSettings && (
        <SettingsView
          initial={settings}
          onSaved={(s) => {
            setSettings(s);
            featureFlags().then(setFeatures);
            setShowSettings(false);
          }}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
