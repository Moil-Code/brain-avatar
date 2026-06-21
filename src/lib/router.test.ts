import { describe, expect, it } from "vitest";
import { isTrivialChat, missingInput, routeTask, usableModels } from "./router";

// The validated stack plus the junk that LM Studio sometimes also advertises:
// an experimental 27B qwen fine-tune that fails to load on the 24GB box, and an
// embedding model. Neither should ever be auto-routed.
const LOADED = [
  "qwen3-8b-mlx",
  "google/gemma-4-12b-qat",
  "gemma-4-26b-a4b-it-qat",
  "qwen3.6-27b-mtp-pi-tune@q3km",
  "text-embedding-nomic-embed-text-v1.5",
];

const ep = (models: string[]) => ({ baseUrl: "http://x", models });

describe("usableModels", () => {
  it("drops experimental fine-tunes and embeddings", () => {
    const out = usableModels(LOADED);
    expect(out).toContain("qwen3-8b-mlx");
    expect(out).toContain("gemma-4-26b-a4b-it-qat");
    expect(out).not.toContain("qwen3.6-27b-mtp-pi-tune@q3km");
    expect(out.some((m) => /embed|nomic/.test(m))).toBe(false);
  });

  it("never strands the avatar — falls back to the raw (non-embed) list if all are denied", () => {
    const out = usableModels(["some-mtp-pi-tune-thing", "another-draft-model"]);
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("routeTask model selection", () => {
  it("routes a fast/action task to the small qwen tool tier, NOT the 27B qwen fine-tune", async () => {
    const r = await routeTask({ userText: "what's on my calendar today?", endpoint: ep(LOADED) });
    expect(r.modelId).toBe("qwen3-8b-mlx");
    expect(r.taskType).toBe("action");
  });

  it("routes a deep task to the 26B MoE, NOT the experimental 27B", async () => {
    const r = await routeTask({
      userText: "analyze this strategy and write a thorough report",
      endpoint: ep(LOADED),
    });
    expect(r.modelId).toBe("gemma-4-26b-a4b-it-qat");
    expect(r.taskType).toBe("deep");
  });

  it("routes an image task to the 12B vision tier", async () => {
    const r = await routeTask({ userText: "what's in this picture?", endpoint: ep(LOADED), hasImage: true });
    expect(r.modelId).toBe("google/gemma-4-12b-qat");
    expect(r.taskType).toBe("vision");
  });

  it("never auto-selects the broken 27B for any task type", async () => {
    for (const text of ["quick question", "summarize and analyze the whole codebase"]) {
      const r = await routeTask({ userText: text, endpoint: ep(LOADED) });
      expect(r.modelId).not.toContain("mtp");
    }
  });

  it("keeps tool-driven requests on the fast tier even when they say 'analyze'", async () => {
    // The screenshot case: 'watch the video and provide that analysis' must NOT go
    // to the fragile 26B (which leaks tool-call markup in the loop).
    for (const text of [
      "watch the video and provide that analysis",
      "check my email and summarize it",
      "find the file and analyze its contents",
    ]) {
      const r = await routeTask({ userText: text, endpoint: ep(LOADED) });
      expect(r.taskType).toBe("action");
      expect(r.modelId).toBe("qwen3-8b-mlx");
    }
  });

  it("still routes pure synthesis/writing to the deep model", async () => {
    const r = await routeTask({
      userText: "write a thorough strategic analysis essay on our market position",
      endpoint: ep(LOADED),
    });
    expect(r.taskType).toBe("deep");
  });
});

describe("missingInput preflight", () => {
  it("asks for the link when told to watch a video with no URL (the reported case)", () => {
    const q = missingInput(
      "watch this video and then tell me what works, what doesn't, what it's about, and how it " +
        "could be better designed for higher visibility and conversion"
    );
    expect(q).toBeTruthy();
    expect(q).toMatch(/link|url/i);
  });

  it("proceeds (no ask) once a URL is present in the request", () => {
    expect(
      missingInput("watch this video https://youtu.be/abc123 and tell me what works")
    ).toBeNull();
    expect(
      missingInput("summarize the video at https://www.youtube.com/watch?v=xyz")
    ).toBeNull();
  });

  it("proceeds when the link was given earlier in the thread", () => {
    expect(
      missingInput("ok now watch that video and tell me what works", {
        priorText: "here it is https://youtu.be/abc123",
      })
    ).toBeNull();
  });

  it("proceeds for a local video file path", () => {
    expect(missingInput("transcribe this video /Users/me/demo.mp4")).toBeNull();
  });

  it("does not fire without a consume-verb (a reference is not a request to open it)", () => {
    expect(missingInput("I want to make this video go viral, any tips?")).toBeNull();
    expect(missingInput("this link converts well, what do you think of the copy?")).toBeNull();
  });

  it("stays out of the way for ordinary requests", () => {
    expect(missingInput("what's on my calendar today?")).toBeNull();
    expect(missingInput("summarize my last email from Tonya")).toBeNull();
    expect(missingInput("analyze this strategy and write a report")).toBeNull();
  });

  it("does not fire when the user attached a file (handled by the vision/doc path)", () => {
    expect(
      missingInput("watch this video and tell me what works", { hasAttachment: true })
    ).toBeNull();
  });

  it("asks for a plain link reference with no URL", () => {
    const q = missingInput("summarize this link for me");
    expect(q).toBeTruthy();
    expect(q).toMatch(/link|url/i);
  });
});

describe("isTrivialChat fast-lane detector", () => {
  it("fires on pure greetings, thanks, acknowledgements, and sign-offs", () => {
    for (const t of [
      "hey",
      "hi there",
      "hello brain",
      "hey how are you",
      "how are you doing today",
      "good morning!",
      "good morning brain, how are you?",
      "thanks",
      "thank you so much",
      "thanks buddy",
      "ok cool",
      "got it, thanks",
      "perfect",
      "sounds good",
      "lol",
      "haha nice",
      "see you later",
      "good night",
    ]) {
      expect(isTrivialChat(t), t).toBe(true);
    }
  });

  it("does NOT fire on anything actionable (tools must stay available)", () => {
    for (const t of [
      "hey can you check my email",
      "hi, what's on my calendar today",
      "how do I reset my password",
      "thanks, also send it to Maria",
      "good morning, summarize my inbox",
      "ok do the thing we discussed",
      "what's up with the Johnson deal",
      "tell me about Buda HIVE",
      "summarize this video",
    ]) {
      expect(isTrivialChat(t), t).toBe(false);
    }
  });

  it("does NOT fire on affirmative continuations (those advance work, not chit-chat)", () => {
    for (const t of ["yes", "yeah", "sure", "go ahead", "continue", "keep going", "proceed", "next"]) {
      expect(isTrivialChat(t), t).toBe(false);
    }
  });

  it("ignores empty / whitespace input", () => {
    expect(isTrivialChat("")).toBe(false);
    expect(isTrivialChat("   ")).toBe(false);
  });
});
