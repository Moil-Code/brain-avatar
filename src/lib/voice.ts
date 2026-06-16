import { transcribeAudio, ttsSpeak, ttsStop } from "./tauri";

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

// --- Text to speech (native macOS `say` via Rust — Enhanced/Premium voices) ---

export function speak(
  text: string,
  opts: { onStart?: () => void; onEnd?: () => void } = {}
): void {
  if (!text.trim()) {
    opts.onEnd?.();
    return;
  }
  opts.onStart?.();
  ttsSpeak(text)
    .catch((e) => console.error("tts_speak failed", e))
    .finally(() => opts.onEnd?.());
}

export function stopSpeaking(): void {
  ttsStop().catch(() => {});
}

/** No-op retained for API compatibility (native TTS needs no voice warm-up). */
export function primeVoices(): void {}
