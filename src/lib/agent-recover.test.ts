import { describe, expect, it } from "vitest";
import { looksLikeLeakedToolCall, recoverToolCalls, stripToolMarkup } from "./agent";

describe("recoverToolCalls", () => {
  it("recovers a well-formed <tool_call>{json}</tool_call> leaked into content", () => {
    const content =
      'Sure, let me look that up.\n<tool_call>{"name":"fetch_url","arguments":{"url":"https://x.com"}}</tool_call>';
    const calls = recoverToolCalls(content);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("fetch_url");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ url: "https://x.com" });
  });

  it("salvages a knownTool{json} leak with a garbled/missing wrapper", () => {
    const calls = recoverToolCalls('I will fetch it. fetch_url{"url":"https://x.com"}');
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("fetch_url");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ url: "https://x.com" });
  });

  it("never fabricates a call for a hallucinated tool name", () => {
    // `open_url` is not a real tool — must NOT be recovered even with valid JSON.
    expect(recoverToolCalls('open_url{"url":"https://x.com"}')).toHaveLength(0);
  });

  it("returns nothing for plain text or malformed markup", () => {
    expect(recoverToolCalls("just a normal answer")).toHaveLength(0);
    // The actual freeform leak from the log: unknown name, comma syntax, no JSON.
    expect(
      recoverToolCalls("open_url, url: https://youtu.be/abc<tool_call|>")
    ).toHaveLength(0);
    // A bare shell command is never auto-executed — left for self-repair.
    expect(
      recoverToolCalls("sed -i 's|a|b|g' /Users/x/weekly-operating-brief.sh}")
    ).toHaveLength(0);
  });
});

describe("looksLikeLeakedToolCall", () => {
  it("flags the real leaked strings from the conversation log", () => {
    // msg 13: hallucinated tool name + stray markup
    expect(looksLikeLeakedToolCall("open_url,url:https://youtu.be/POxv}<tool_call|>")).toBe(true);
    // msg 32/35: a shell command the model meant to run via run_shell
    expect(
      looksLikeLeakedToolCall("sed -i 's|a|b|g' /Users/x/weekly-operating-brief.sh}")
    ).toBe(true);
    // a real tool used as a bare pseudo-call
    expect(looksLikeLeakedToolCall("fetch_url, url: https://x.com")).toBe(true);
  });

  it("does not flag genuine prose answers", () => {
    expect(looksLikeLeakedToolCall("Here are your last 5 messages: ...")).toBe(false);
    expect(looksLikeLeakedToolCall("I converted all the times to Central Time for you.")).toBe(false);
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
