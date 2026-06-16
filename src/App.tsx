import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import Avatar from "./components/Avatar";
import ChatPanel from "./components/ChatPanel";
import SettingsView from "./components/Settings";
import TitleBar from "./components/TitleBar";
import { runAgent } from "./lib/agent";
import {
  appendTurn,
  deleteConversation,
  featureFlags,
  getConversation,
  getSettings,
  listConversations,
  saveMessage,
  type ConvSummary,
} from "./lib/tauri";
import ChatsView from "./components/Chats";
import { probeModels } from "./lib/llm";
import { primeVoices, speak, startRecording, stopSpeaking, type Recorder } from "./lib/voice";
import { checkForUpdate, installUpdate, type Update } from "./lib/updater";
import { collapsePeek, enterPeek, exitPeek, expandPeek } from "./lib/peek";
import type {
  Attachment,
  AvatarState,
  ChatMessage,
  FeatureFlags,
  Settings,
  UiMessage,
  UiStep,
} from "./lib/types";

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Insert or update a step (by id) in a message's step feed. */
function upsertStep(steps: UiStep[] = [], s: UiStep): UiStep[] {
  const i = steps.findIndex((x) => x.id === s.id);
  if (i < 0) return [...steps, s];
  const copy = steps.slice();
  copy[i] = { ...copy[i], ...s };
  return copy;
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
  const [peeked, setPeeked] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  const [showChats, setShowChats] = useState(false);
  const [conversations, setConversations] = useState<ConvSummary[]>([]);
  const [activeConv, setActiveConv] = useState<string>(() => getConversationId());
  const collapseTimer = useRef<number | null>(null);

  const modelHistory = useRef<ChatMessage[]>([]);
  const recorderRef = useRef<Recorder | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const toggleMicRef = useRef<() => void>(() => {});

  const setActiveConvId = (id: string) => {
    localStorage.setItem("conversationId", id);
    setActiveConv(id);
  };

  const loadConversation = useCallback(async (id: string) => {
    const msgs = await getConversation(id).catch(() => []);
    const turns = msgs.filter((m) => m.role === "user" || m.role === "assistant");
    setMessages(
      turns.map((m) => ({ id: uid(), role: m.role as "user" | "assistant", content: m.content }))
    );
    modelHistory.current = turns.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));
  }, []);

  // --- bootstrap ---
  useEffect(() => {
    primeVoices();
    (async () => {
      try {
        const s = await getSettings();
        setSettings(s);
        setFeatures(await featureFlags());
        probeModels(s).then(setModels).catch(() => {});
        if (!s.lm_studio_local_url) setShowSettings(true);
        await loadConversation(localStorage.getItem("conversationId") || activeConv);
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
    async (text: string, attachments: Attachment[] = []) => {
      if (!settings || busy) return;
      const attachNote = attachments.length
        ? `\n\n📎 ${attachments.map((a) => a.name).join(", ")}`
        : "";
      const userMsg: UiMessage = { id: uid(), role: "user", content: text + attachNote };
      const botId = uid();
      const botMsg: UiMessage = {
        id: botId,
        role: "assistant",
        content: "",
        pending: true,
        tools: [],
        steps: [],
      };
      setMessages((ms) => [...ms, userMsg, botMsg]);
      appendTurn(activeConv, "user", text).catch(() => {});
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
          attachments,
          modelOverride,
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
          onRoute: (route) => {
            if (route.routed) {
              const short = route.modelId.split("/").pop() ?? route.modelId;
              patchMessage(botId, { routeLabel: `${route.taskType} → ${short}` });
            }
          },
          onStep: (step) =>
            setMessages((ms) =>
              ms.map((m) => (m.id === botId ? { ...m, steps: upsertStep(m.steps, step) } : m))
            ),
        });

        const answer = result.content || streamed || "(no response)";
        patchMessage(botId, { content: answer, pending: false, tools: result.tools });

        modelHistory.current = [
          ...priorHistory,
          { role: "user", content: text },
          { role: "assistant", content: answer },
        ];

        appendTurn(activeConv, "assistant", answer).catch(() => {});
        saveMessage(activeConv, "user", text).catch(() => {});
        saveMessage(activeConv, "assistant", answer).catch(() => {});

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
    [settings, busy, modelOverride, activeConv]
  );

  // --- recent chats ---
  const openChats = useCallback(async () => {
    setConversations(await listConversations().catch(() => []));
    setShowChats(true);
  }, []);
  const newChat = useCallback(() => {
    abortRef.current?.abort();
    setActiveConvId(uid());
    setMessages([]);
    modelHistory.current = [];
    setShowChats(false);
  }, []);
  const switchChat = useCallback(
    async (id: string) => {
      abortRef.current?.abort();
      setActiveConvId(id);
      await loadConversation(id);
      setShowChats(false);
    },
    [loadConversation]
  );
  const removeChat = useCallback(
    async (id: string) => {
      await deleteConversation(id).catch(() => {});
      setConversations(await listConversations().catch(() => []));
      if (id === activeConv) newChat();
    },
    [activeConv, newChat]
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

  // --- peekaboo: shrink to a top bar, expand on hover, collapse on leave ---
  const startPeek = useCallback(() => {
    enterPeek().then(() => {
      setPeeked(true);
      setExpanded(false);
    });
  }, []);
  const stopPeek = useCallback(() => {
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
    exitPeek().then(() => {
      setPeeked(false);
      setExpanded(false);
    });
  }, []);
  const onPeekEnter = useCallback(() => {
    if (collapseTimer.current) {
      clearTimeout(collapseTimer.current);
      collapseTimer.current = null;
    }
    if (peeked && !expanded) expandPeek().then(() => setExpanded(true));
  }, [peeked, expanded]);
  const onPeekLeave = useCallback(() => {
    if (peeked && expanded) {
      collapseTimer.current = window.setTimeout(() => {
        collapsePeek().then(() => setExpanded(false));
      }, 300);
    }
  }, [peeked, expanded]);

  if (!settings) {
    return (
      <div className="app glass">
        <div className="boot">Starting Brain…</div>
      </div>
    );
  }

  // Peekaboo: collapsed to a small top bar; hover to expand.
  if (peeked && !expanded) {
    return (
      <div
        className="app glass peek-bar"
        data-tauri-drag-region
        onMouseEnter={onPeekEnter}
        onClick={onPeekEnter}
        title="Click or hover to open"
      >
        <span className="peek-bar-dot" />
        <span className="peek-bar-label">Brain</span>
      </div>
    );
  }

  return (
    <div className="app glass" onMouseLeave={onPeekLeave}>
      <TitleBar
        onOpenSettings={() => setShowSettings(true)}
        onOpenChats={openChats}
        onNewChat={newChat}
        onMinimize={startPeek}
        peeked={peeked}
        onExitPeek={stopPeek}
        models={models}
        modelOverride={modelOverride}
        onSelectModel={setModelOverride}
      />
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
      {showChats && (
        <ChatsView
          conversations={conversations}
          activeId={activeConv}
          onSelect={switchChat}
          onNew={newChat}
          onDelete={removeChat}
          onClose={() => setShowChats(false)}
        />
      )}
      {showSettings && (
        <SettingsView
          initial={settings}
          onSaved={(s) => {
            setSettings(s);
            featureFlags().then(setFeatures);
            probeModels(s).then(setModels).catch(() => {});
            setShowSettings(false);
          }}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
