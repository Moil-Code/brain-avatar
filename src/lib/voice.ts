import { transcribeAudio } from "./tauri";

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
  recorder.start();

  const cleanup = () => stream.getTracks().forEach((t) => t.stop());

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
            if (chunks.length === 0) return resolve("");
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

// --- Text to speech (webview SpeechSynthesis) ---

let preferredVoice: SpeechSynthesisVoice | null = null;

function ensureVoice(): SpeechSynthesisVoice | null {
  if (preferredVoice) return preferredVoice;
  const voices = window.speechSynthesis?.getVoices() ?? [];
  if (!voices.length) return null;
  const byName = (n: string) => voices.find((v) => v.name === n);
  preferredVoice =
    byName("Samantha") ||
    voices.find((v) => v.lang === "en-US" && v.localService) ||
    voices.find((v) => v.lang.startsWith("en")) ||
    voices[0];
  return preferredVoice;
}

export function speak(
  text: string,
  opts: { onStart?: () => void; onEnd?: () => void } = {}
): void {
  const synth = window.speechSynthesis;
  if (!synth || !text.trim()) {
    opts.onEnd?.();
    return;
  }
  synth.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  const v = ensureVoice();
  if (v) utter.voice = v;
  utter.rate = 1.03;
  utter.pitch = 1.0;
  utter.onstart = () => opts.onStart?.();
  utter.onend = () => opts.onEnd?.();
  utter.onerror = () => opts.onEnd?.();
  synth.speak(utter);
}

export function stopSpeaking(): void {
  window.speechSynthesis?.cancel();
}

/** Warm up the voice list (Chromium populates it asynchronously). */
export function primeVoices(): void {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.getVoices();
  window.speechSynthesis.onvoiceschanged = () => {
    preferredVoice = null;
    ensureVoice();
  };
}
