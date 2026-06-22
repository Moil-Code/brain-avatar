import { describe, it, expect, vi } from "vitest";

// Mock the Tauri bridge so importing voice.ts doesn't reach the native IPC layer.
vi.mock("./tauri", () => ({
  transcribeAudio: vi.fn(),
  ttsSpeak: vi.fn(async () => {}),
  ttsStop: vi.fn(async () => {}),
}));

import { splitSpeechChunks } from "./voice";

describe("splitSpeechChunks", () => {
  it("emits complete sentences and keeps the partial tail", () => {
    const r = splitSpeechChunks("Hello there. How are", false);
    expect(r.chunks).toEqual(["Hello there."]);
    expect(r.rest).toBe(" How are");
  });

  it("does not split until a boundary is complete", () => {
    const r = splitSpeechChunks("Thinking", false);
    expect(r.chunks).toEqual([]);
    expect(r.rest).toBe("Thinking");
  });

  it("does not split a decimal mid-number (no space after the dot)", () => {
    const r = splitSpeechChunks("Pi is about 3.5 ish", false);
    expect(r.chunks).toEqual([]);
    expect(r.rest).toBe("Pi is about 3.5 ish");
  });

  it("treats newlines as boundaries", () => {
    const r = splitSpeechChunks("First line\nSecond", false);
    expect(r.chunks).toEqual(["First line"]);
    expect(r.rest).toBe("Second");
  });

  it("absorbs trailing punctuation runs and closing quotes", () => {
    const r = splitSpeechChunks('Really?! "Yes." next', false);
    expect(r.chunks).toEqual(["Really?!", '"Yes."']);
    expect(r.rest).toBe(" next");
  });

  it("a sentence ending exactly at the buffer end waits unless final", () => {
    expect(splitSpeechChunks("Done.", false).chunks).toEqual([]);
    expect(splitSpeechChunks("Done.", true).chunks).toEqual(["Done."]);
  });

  it("flushes the remainder (even without punctuation) when final", () => {
    const r = splitSpeechChunks("No period here", true);
    expect(r.chunks).toEqual(["No period here"]);
    expect(r.rest).toBe("");
  });

  it("reassembles a token-by-token stream into clean sentences", () => {
    let buf = "";
    const spoken: string[] = [];
    for (const delta of ["He", "llo. ", "Wor", "ld! ", "Bye"]) {
      buf += delta;
      const { chunks, rest } = splitSpeechChunks(buf, false);
      spoken.push(...chunks);
      buf = rest;
    }
    spoken.push(...splitSpeechChunks(buf, true).chunks);
    expect(spoken).toEqual(["Hello.", "World!", "Bye"]);
  });
});
