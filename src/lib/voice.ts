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
    recorder.start();
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
