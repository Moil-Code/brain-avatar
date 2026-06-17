import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import Avatar from "./components/Avatar";
import ChatPanel from "./components/ChatPanel";
import SettingsView from "./components/Settings";
import TitleBar from "./components/TitleBar";
import { runAgent } from "./lib/agent";
import {
  appendTurn,
  cancelGeneration,
  deleteConversation,
  featureFlags,
  getConversation,
  getSettings,
  listConversations,
  pushChat,
  saveMessage,
  type ConvSummary,
} from "./lib/tauri";
import ChatsView from "./components/Chats";
import AutomationsView from "./components/Automations";
import {
  deliverAutomation,
  isDue,
  loadAutomations,
  saveAutomations,
} from "./lib/automations";
import { probeModels } from "./lib/llm";
import {
  isMuted,
  listenOnce,
  primeVoices,
  setMuted as setMutedFlag,
  speak,
  startRecording,
  stopSpeaking,
  transcriptIsJunk,
  type Recorder,
} from "./lib/voice";
import { checkForUpdate, installUpdate, type Update } from "./lib/updater";
import { collapsePeek, enterPeek, exitPeek, expandPeek } from "./lib/peek";
import { isMobile } from "./lib/platform";
import type {
  Attachment,
  AvatarState,
  ChatMessage,
  FeatureFlags,
  Automation,
  Settings,
  UiMessage,
  UiStep,
} from "./lib/types";

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

interface QueueItem {
  id: string;
  text: string;
  attachments: Attachment[];
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
  const [showAutomations, setShowAutomations] = useState(false);
  const [conversations, setConversations] = useState<ConvSummary[]>([]);
  const [activeConv, setActiveConv] = useState<string>(() => getConversationId());
  const [convoMode, setConvoMode] = useState<boolean>(
    () => localStorage.getItem("convoMode") === "1"
  );
  const [muted, setMuted] = useState<boolean>(() => isMuted());
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const collapseTimer = useRef<number | null>(null);
  const queueRef = useRef<QueueItem[]>([]);
  const runningRef = useRef(false);
  const runTurnRef = useRef<(t: string, a?: Attachment[]) => Promise<void>>(async () => {});

  const modelHistory = useRef<ChatMessage[]>([]);
  const recorderRef = useRef<Recorder | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listenAbortRef = useRef<AbortController | null>(null);
  const toggleMicRef = useRef<() => void>(() => {});
  const autoListenRef = useRef<() => void>(() => {});
  const activeBotIdRef = useRef<string | null>(null);

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
    const unlistenImage = listen<{ dataUrl: string }>("image-generated", (e) => {
      const id = activeBotIdRef.current;
      const url = e.payload?.dataUrl;
      if (!id || !url) return;
      setMessages((ms) =>
        ms.map((m) => (m.id === id ? { ...m, images: [...(m.images ?? []), url] } : m))
      );
    });
    return () => {
      unlistenSettings.then((f) => f());
      unlistenVoice.then((f) => f());
      unlistenImage.then((f) => f());
    };
  }, []);

  const patchMessage = (id: string, patch: Partial<UiMessage>) =>
    setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, ...patch } : m)));

  const runTurn = useCallback(
    async (text: string, attachments: Attachment[] = []) => {
      if (!settings) return;
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
      activeBotIdRef.current = botId;
      appendTurn(activeConv, "user", text).catch(() => {});
      pushChat(activeConv, text, "user", text).catch(() => {});
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
        pushChat(activeConv, "", "assistant", answer).catch(() => {});
        saveMessage(activeConv, "user", text).catch(() => {});
        saveMessage(activeConv, "assistant", answer).catch(() => {});

        speak(answer, {
          onStart: () => setAvatarState("speaking"),
          onEnd: () => {
            setAvatarState("idle");
            autoListenRef.current(); // hands-free back-and-forth (if convo mode on)
          },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.toLowerCase().includes("abort") || msg.toLowerCase().includes("cancel")) {
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
    [settings, modelOverride, activeConv]
  );
  runTurnRef.current = runTurn;

  // --- proactive automations: run scheduled tasks on their own and deliver ---
  // Refs let the interval read live state without re-subscribing every render.
  const autoBusyRef = useRef(false);
  const settingsRef = useRef<Settings | null>(null);
  const busyRef = useRef(false);
  settingsRef.current = settings;
  busyRef.current = busy;

  const runAutomation = useCallback(async (a: Automation) => {
    const s = settingsRef.current;
    if (!s) return;
    try {
      // Each automation starts a fresh context — it's a standalone task, not a
      // continuation of the current chat.
      const result = await runAgent({ userText: a.prompt, history: [], settings: s });
      const content = (result.content || "").trim();
      if (!content) return;

      // Leave a record in the active chat so it's there when the avatar is opened.
      setMessages((ms) => [
        ...ms,
        {
          id: uid(),
          role: "assistant",
          content: `⏰ ${a.name}\n\n${content}`,
          tools: result.tools,
        },
      ]);

      // Stamp lastRun/lastResult so it isn't re-fired and the UI shows freshness.
      const list = await loadAutomations().catch(() => [] as Automation[]);
      const idx = list.findIndex((x) => x.id === a.id);
      if (idx >= 0) {
        list[idx] = {
          ...list[idx],
          lastRun: new Date().toISOString(),
          lastResult: content.slice(0, 140),
        };
        await saveAutomations(list).catch(() => {});
      }

      await deliverAutomation(a, content);
      if (a.delivery.speak) {
        speak(content, {
          onStart: () => setAvatarState("speaking"),
          onEnd: () => setAvatarState("idle"),
        });
      }
    } catch (e) {
      console.error("automation failed", a.name, e);
    }
  }, []);
  const runAutomationRef = useRef(runAutomation);
  runAutomationRef.current = runAutomation;

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      // User input always takes priority over background runs.
      if (busyRef.current || runningRef.current || autoBusyRef.current) return;
      if (!settingsRef.current) return;
      const list = await loadAutomations().catch(() => [] as Automation[]);
      const now = new Date();
      const due = list.filter((a) => isDue(a, now));
      if (due.length === 0) return;
      autoBusyRef.current = true;
      try {
        for (const a of due) {
          if (stopped || busyRef.current || runningRef.current) break;
          await runAutomationRef.current(a);
        }
      } finally {
        autoBusyRef.current = false;
      }
    };
    const initial = window.setTimeout(tick, 12000); // first sweep shortly after launch
    const iv = window.setInterval(tick, 60000); // then once a minute
    return () => {
      stopped = true;
      clearTimeout(initial);
      clearInterval(iv);
    };
  }, []);

  // --- request queue: stack multiple asks; run them one at a time ---
  const syncQueue = () => setQueue([...queueRef.current]);
  const pump = useCallback(() => {
    if (runningRef.current) return;
    const item = queueRef.current.shift();
    syncQueue();
    if (!item) return;
    runningRef.current = true;
    runTurnRef.current(item.text, item.attachments).finally(() => {
      runningRef.current = false;
      pump();
    });
  }, []);
  const handleSend = useCallback(
    (text: string, attachments: Attachment[] = []) => {
      queueRef.current.push({ id: uid(), text, attachments });
      syncQueue();
      pump();
    },
    [pump]
  );
  const dequeue = useCallback((id: string) => {
    queueRef.current = queueRef.current.filter((q) => q.id !== id);
    syncQueue();
  }, []);

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
        if (text && !transcriptIsJunk(text)) handleSend(text);
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

  // Hands-free conversation: after a spoken reply, listen again (VAD auto-stops
  // on silence; the junk guard drops empty/ambient captures so nothing fires).
  const maybeAutoListen = useCallback(async () => {
    if (!convoMode || busy || recording) return;
    const ac = new AbortController();
    listenAbortRef.current = ac;
    setRecording(true);
    setAvatarState("listening");
    try {
      const text = (await listenOnce({ signal: ac.signal })).trim();
      setRecording(false);
      listenAbortRef.current = null;
      if (text && !transcriptIsJunk(text)) handleSend(text);
      else setAvatarState("idle");
    } catch {
      setRecording(false);
      listenAbortRef.current = null;
      setAvatarState("idle");
    }
  }, [convoMode, busy, recording, handleSend]);
  autoListenRef.current = maybeAutoListen;

  const toggleConvoMode = useCallback(() => {
    setConvoMode((on) => {
      const next = !on;
      localStorage.setItem("convoMode", next ? "1" : "0");
      if (!next) {
        listenAbortRef.current?.abort();
        listenAbortRef.current = null;
        setRecording(false);
        setAvatarState((s) => (s === "listening" ? "idle" : s));
      }
      return next;
    });
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((on) => {
      const next = !on;
      setMutedFlag(next); // persists + silences any in-progress speech
      if (next) {
        stopSpeaking();
        setAvatarState((s) => (s === "speaking" ? "idle" : s));
      }
      return next;
    });
  }, []);

  const handleStop = useCallback(() => {
    queueRef.current = [];
    syncQueue();
    cancelGeneration(); // kill any in-flight model generation on the server immediately
    abortRef.current?.abort();
    listenAbortRef.current?.abort();
    listenAbortRef.current = null;
    stopSpeaking();
    setBusy(false);
    setRecording(false);
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

  const rootClass = isMobile ? "app glass mobile" : "app glass";

  if (!settings) {
    return (
      <div className={rootClass}>
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
    <div className={rootClass} onMouseLeave={onPeekLeave}>
      <TitleBar
        onOpenSettings={() => setShowSettings(true)}
        onOpenChats={openChats}
        onOpenAutomations={() => setShowAutomations(true)}
        onNewChat={newChat}
        onMinimize={startPeek}
        peeked={peeked}
        onExitPeek={stopPeek}
        models={models}
        modelOverride={modelOverride}
        onSelectModel={setModelOverride}
        mobile={isMobile}
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
        convoMode={convoMode}
        onToggleConvo={toggleConvoMode}
        muted={muted}
        onToggleMute={toggleMute}
        queue={queue}
        onDequeue={dequeue}
        onSend={handleSend}
        onToggleMic={handleToggleMic}
        onStop={handleStop}
      />
      {showAutomations && (
        <AutomationsView
          onClose={() => setShowAutomations(false)}
          onRunNow={(a) => runAutomation(a)}
        />
      )}
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
