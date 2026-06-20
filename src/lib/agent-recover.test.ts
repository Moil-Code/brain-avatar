import { describe, expect, it } from "vitest";
import { recoverToolCalls, stripToolMarkup } from "./agent";

describe("recoverToolCalls", () => {
  it("recovers a well-formed <tool_call>{json}</tool_call> leaked into content", () => {
    const content =
      'Sure, let me look that up.\n<tool_call>{"name":"fetch_url","arguments":{"url":"https://x.com"}}</tool_call>';
    const calls = recoverToolCalls(content);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("fetch_url");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ url: "https://x.com" });
  });

  it("returns nothing for plain text or malformed markup", () => {
    expect(recoverToolCalls("just a normal answer")).toHaveLength(0);
    // The screenshot's freeform leak isn't valid JSON — not recovered (only stripped).
    expect(
      recoverToolCalls("open_url, url: https://youtu.be/abc<tool_call|>")
    ).toHaveLength(0);
  });
});

describe("stripToolMarkup", () => {
  it("removes leaked tool-call markup so the user never sees protocol tokens", () => {
    expect(stripToolMarkup("Here you go.<tool_call|>")).toBe("Here you go.");
    expect(
      stripToolMarkup('<tool_call>{"name":"x","arguments":{}}</tool_call>done')
    ).toBe("done");
    expect(stripToolMarkup("clean answer")).toBe("clean answer");
  });
});
