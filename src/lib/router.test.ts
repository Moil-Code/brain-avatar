import { describe, expect, it } from "vitest";
import { routeTask, usableModels } from "./router";

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
});
