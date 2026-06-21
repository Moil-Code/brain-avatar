import { transcribeAudio, ttsSpeak, ttsStop } from "./tauri";
import { isMobile } from "./platform";

function pickMime(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "audio/webm";
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export interface Recorder {
  /** Stop recording and return the transcribed text. */
  stopAndTranscribe: () => Promise<string>;
  /** Abandon the recording without transcribing. */
  cancel: () => void;
}

/** Begin capturing microphone audio. Resolves once recording has started. */
export async function startRecording(): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = pickMime();
  const recorder = new MediaRecorder(stream, { mimeType: mime });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  // Pass a timeslice so audio is flushed into `dataavailable` periodically.
  // WebKit/WKWebView (this app's macOS webview) frequently does NOT emit the
  // buffered audio on stop() when started with no timeslice, leaving `chunks`
  // empty so nothing ever gets transcribed. Recording in 250ms fragments
  // guarantees we have data when the user stops.
  recorder.start(250);

  const cleanup = () => stream.getTracks().forEach((t) => t.stop());
  const startedAt = Date.now();

  return {
    cancel: () => {
      try {
        recorder.stop();
      } catch {
        /* noop */
      }
      cleanup();
    },
    stopAndTranscribe: () =>
      new Promise<string>((resolve, reject) => {
        recorder.onstop = async () => {
          cleanup();
          try {
            if (chunks.length === 0) {
              // No audio captured at all. A sub-second tap is just an accidental
              // press — stay silent. But if we "recorded" for a real beat and
              // still got nothing, the mic/WebView failed to deliver audio; make
              // that visible instead of silently doing nothing (the original bug).
              if (Date.now() - startedAt > 700) {
                throw new Error("no audio captured — check the mic input/permission");
              }
              return resolve("");
            }
            const blob = new Blob(chunks, { type: mime });
            const base64 = await blobToBase64(blob);
            resolve(await transcribeAudio(base64, mime));
          } catch (e) {
            reject(e);
          }
        };
        try {
          recorder.stop();
        } catch (e) {
          reject(e);
        }
      }),
  };
}

/** Whisper hallucinates these on silence/near-silence. Drop transcripts that are
 *  empty, too short, or exactly one of these so ambient noise never fires a turn. */
const SILENCE_HALLUCINATIONS = new Set([
  "you",
  "thank you",
  "thanks",
  "thanks for watching",
  "thank you for watching",
  "please subscribe",
  "bye",
  "bye.",
  "okay",
  "ok",
  "[blank_audio]",
  "(silence)",
  "[silence]",
  "...",
]);

/** True when a transcript looks like silence/noise rather than a real utterance. */
export function transcriptIsJunk(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!?,…]+$/g, "").trim();
  if (t.length < 2) return true; // empty or single char
  if (!/[a-z0-9]/.test(t)) return true; // no real content
  if (SILENCE_HALLUCINATIONS.has(t)) return true;
  return false;
}

/**
 * Listen for one spoken utterance hands-free: records with voice-activity
 * detection, auto-stops after the user goes quiet, and returns the transcript.
 * Resolves "" if no speech was detected (so the back-and-forth ends gracefully
 * instead of capturing an empty room).
 */
export async function listenOnce(
  opts: {
    signal?: AbortSignal;
    silenceMs?: number; // quiet gap that ends the utterance
    maxMs?: number; // hard cap on one turn
    noSpeechMs?: number; // give up if no speech starts
    onSpeechStart?: () => void;
  } = {}
): Promise<string> {
  const silenceMs = opts.silenceMs ?? 1400;
  const maxMs = opts.maxMs ?? 15000;
  const noSpeechMs = opts.noSpeechMs ?? 6000;
  const VOICE_RMS = 0.018;

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = pickMime();
  const recorder = new MediaRecorder(stream, { mimeType: mime });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const ac = new AudioContext();
  await ac.resume().catch(() => {});
  const source = ac.createMediaStreamSource(stream);
  const analyser = ac.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const buf = new Uint8Array(analyser.fftSize);

  let speechStarted = false;
  let timer: number | undefined;
  const startedAt = Date.now();
  let lastVoiceAt = startedAt;

  const teardown = () => {
    if (timer) clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    try {
      source.disconnect();
      analyser.disconnect();
      ac.close();
    } catch {
      /* noop */
    }
  };

  return new Promise<string>((resolve, reject) => {
    recorder.onstop = async () => {
      teardown();
      try {
        if (!speechStarted || chunks.length === 0) return resolve("");
        const blob = new Blob(chunks, { type: mime });
        resolve(await transcribeAudio(await blobToBase64(blob), mime));
      } catch (e) {
        reject(e);
      }
    };
    const stop = () => {
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {
        /* noop */
      }
    };
    // 250ms timeslice — same WKWebView reliability fix as startRecording: without
    // it the captured audio can be lost on stop() and we'd transcribe silence.
    recorder.start(250);
    timer = window.setInterval(() => {
      if (opts.signal?.aborted) return stop();
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      const now = Date.now();
      if (rms > VOICE_RMS) {
        lastVoiceAt = now;
        if (!speechStarted) {
          speechStarted = true;
          opts.onSpeechStart?.();
        }
      }
      const elapsed = now - startedAt;
      if (speechStarted && now - lastVoiceAt > silenceMs) return stop();
      if (!speechStarted && elapsed > noSpeechMs) return stop();
      if (elapsed > maxMs) return stop();
    }, 60);
  });
}

// --- Text to speech (native macOS `say` via Rust — Enhanced/Premium voices) ---

// When muted, the avatar keeps operating normally (answers still appear, the
// conversation flow continues) but its spoken output is silenced. Persisted so
// the preference survives restarts.
let muted: boolean = (() => {
  try {
    return localStorage.getItem("muted") === "1";
  } catch {
    return false;
  }
})();

export function isMuted(): boolean {
  return muted;
}

export function setMuted(value: boolean): void {
  muted = value;
  try {
    localStorage.setItem("muted", value ? "1" : "0");
  } catch {
    /* noop */
  }
  // Silence anything mid-sentence the instant mute is turned on.
  if (value) stopSpeaking();
}

/** iOS has no macOS `say` / neural sidecar, so the iPhone build speaks through the
 *  webview's built-in SpeechSynthesis. Resolves onEnd even on error so hands-free
 *  convo mode keeps flowing. */
function speakWeb(
  text: string,
  opts: { onStart?: () => void; onEnd?: () => void }
): void {
  try {
    const synth = window.speechSynthesis;
    if (!synth) {
      opts.onEnd?.();
      return;
    }
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      opts.onEnd?.();
    };
    u.onend = finish;
    u.onerror = finish;
    opts.onStart?.();
    synth.speak(u);
  } catch (e) {
    console.error("web tts failed", e);
    opts.onEnd?.();
  }
}

export function speak(
  text: string,
  opts: { onStart?: () => void; onEnd?: () => void } = {}
): void {
  // Muted: skip the audio but still resolve the flow (so hands-free convo mode
  // keeps going) — exactly like the empty-text case.
  if (muted || !text.trim()) {
    opts.onEnd?.();
    return;
  }
  if (isMobile) {
    speakWeb(text, opts);
    return;
  }
  opts.onStart?.();
  ttsSpeak(text)
    .catch((e) => console.error("tts_speak failed", e))
    .finally(() => opts.onEnd?.());
}

export function stopSpeaking(): void {
  if (isMobile) {
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* noop */
    }
    return;
  }
  ttsStop().catch(() => {});
}

/** Native TTS needs no warm-up; iOS SpeechSynthesis loads its voice list lazily,
 *  so we nudge it once at boot so the first spoken reply isn't silent. */
export function primeVoices(): void {
  if (!isMobile) return;
  try {
    window.speechSynthesis?.getVoices();
  } catch {
    /* noop */
  }
}
