import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TaskBoard } from "./types";

// In-memory board store + scripted LLM responses, driven per test.
let store: TaskBoard | null = null;
let llmScript: any[] = [];
let llmIdx = 0;

// Mock the endpoint resolver + router so runAgent never touches the network.
vi.mock("./llm", () => ({
  resolveBaseEndpoint: vi.fn(async () => ({ baseUrl: "http://x", token: "", models: [] })),
  // Direct (non-daemon) mode streams via streamChat — drive it from the same scripted
  // responses, emitting content through onToken so the streaming path is exercised.
  streamChat: vi.fn(async (opts: any) => {
    const next = llmScript[llmIdx++] ?? { content: "", tool_calls: [] };
    if (next.content && opts?.onToken) opts.onToken(next.content);
    return {
      content: next.content ?? "",
      toolCalls: Array.isArray(next.tool_calls) ? next.tool_calls : [],
      finishReason: null,
    };
  }),
}));
vi.mock("./router", () => ({
  routeTask: vi.fn(async () => ({ modelId: "qwen3-8b", taskType: "deep", enhanced: "", routed: false })),
  // Defaults: never short-circuit, so the existing board tests run unchanged. The
  // missing-input and fast-lane tests below override these per-case.
  missingInput: vi.fn(() => null),
  isTrivialChat: vi.fn(() => false),
}));

// Mock the Tauri bridge: scripted llmComplete, an in-memory board that mimics the
// Rust store (id assignment, version bump, done-without-evidence rejection), and
// deterministic domain-tool wrappers so executeTool resolves to non-empty strings.
vi.mock("./tauri", () => ({
  llmComplete: vi.fn(async () => llmScript[llmIdx++]),
  getTaskBoard: vi.fn(async () => store),
  setTaskBoard: vi.fn(async (cid: string, tasks: any[]) => {
    for (const t of tasks) {
      if (t.status === "done" && !(t.evidence && t.evidence.trim())) {
        throw new Error(`Task '${t.title}' marked done without evidence.`);
      }
    }
    store = {
      conversation_id: cid,
      updated_at: "now",
      version: (store?.version ?? 0) + 1,
      tasks: tasks.map((t, i) => ({
        id: t.id || `t_${i}`,
        title: t.title,
        status: t.status,
        evidence: t.evidence,
        blocker: t.blocker,
        created_at: "c",
        updated_at: "u",
        attempt_count: 1,
      })),
    };
    return store;
  }),
  clearTaskBoard: vi.fn(async () => {
    store = null;
  }),
  brainPage: vi.fn(async () => "brain_page OK: Josh Patel canonical page, 12 lines"),
  brainSearch: vi.fn(async () => "brain_search OK: 4 hits for Buda HIVE"),
  calendarEvents: vi.fn(async () => "calendar_events OK: 3 events this week"),
  readFile: vi.fn(async () => "read_file OK: /Users/x/file.md, 42 lines"),
}));

import { runAgent } from "./agent";
import { brainPage, llmComplete } from "./tauri"; // mocked wrappers, for call-count assertions
import { isTrivialChat, missingInput } from "./router"; // mocked, for the short-circuit tests
import { resolveBaseEndpoint, streamChat } from "./llm"; // mocked: models for the fast lane + streaming path

const settings = { system_prompt: "you are brain", max_tokens: 4096 } as any;

beforeEach(() => {
  store = null;
  llmIdx = 0;
  llmScript = [];
  vi.clearAllMocks(); // reset call history (keeps the inline implementations)
});

const mt = (id: string, cards: any[]) => ({
  id,
  function: { name: "manage_tasks", arguments: JSON.stringify({ cards }) },
});
const tool = (id: string, name: string, args: any = {}) => ({
  id,
  function: { name, arguments: JSON.stringify(args) },
});

describe("TEDC multi-task scenario", () => {
  it("decomposes, executes one card at a time, and finishes with evidence on every done card", async () => {
    llmScript = [
      // R0 — forced decompose: 4 cards, first in_progress.
      { content: "", tool_calls: [mt("a", [
        { id: "", title: "Find Josh", status: "in_progress" },
        { id: "", title: "Read TEDC doc", status: "todo" },
        { id: "", title: "Read slides 26-35", status: "todo" },
        { id: "", title: "Rewrite slide 27", status: "todo" },
      ])] },
      // R1 — brain_page, then mark card 1 done + card 2 in_progress.
      { content: "", tool_calls: [tool("b", "brain_page", { name: "Josh" }), mt("c", [
        { id: "t_0", title: "Find Josh", status: "done", evidence: "brain_page returned Josh page" },
        { id: "t_1", title: "Read TEDC doc", status: "in_progress" },
        { id: "t_2", title: "Read slides 26-35", status: "todo" },
        { id: "t_3", title: "Rewrite slide 27", status: "todo" },
      ])] },
      // R2 — read_file TEDC, mark card 2 done + card 3 in_progress.
      { content: "", tool_calls: [tool("d", "read_file", { path: "/Users/x/tedc.md" }), mt("e", [
        { id: "t_0", title: "Find Josh", status: "done", evidence: "brain_page returned Josh page" },
        { id: "t_1", title: "Read TEDC doc", status: "done", evidence: "read_file returned /Users/x/tedc.md, 42 lines" },
        { id: "t_2", title: "Read slides 26-35", status: "in_progress" },
        { id: "t_3", title: "Rewrite slide 27", status: "todo" },
      ])] },
      // R3 — read_file slides, mark card 3 done + card 4 in_progress.
      { content: "", tool_calls: [tool("f", "read_file", { path: "/Users/x/deck.pptx" }), mt("g", [
        { id: "t_0", title: "Find Josh", status: "done", evidence: "brain_page returned Josh page" },
        { id: "t_1", title: "Read TEDC doc", status: "done", evidence: "read_file returned /Users/x/tedc.md, 42 lines" },
        { id: "t_2", title: "Read slides 26-35", status: "done", evidence: "read_file returned slides 26-35, 10 slides" },
        { id: "t_3", title: "Rewrite slide 27", status: "in_progress" },
      ])] },
      // R4 — do the rewrite (a tool runs), mark card 4 done.
      { content: "", tool_calls: [tool("h", "read_file", { path: "/Users/x/slide27.txt" }), mt("i", [
        { id: "t_0", title: "Find Josh", status: "done", evidence: "brain_page returned Josh page" },
        { id: "t_1", title: "Read TEDC doc", status: "done", evidence: "read_file returned /Users/x/tedc.md, 42 lines" },
        { id: "t_2", title: "Read slides 26-35", status: "done", evidence: "read_file returned slides 26-35, 10 slides" },
        { id: "t_3", title: "Rewrite slide 27", status: "done", evidence: "read_file returned /Users/x/slide27.txt, 8 lines" },
      ])] },
      // R5 — final answer.
      { content: "All four tasks are complete.", tool_calls: [] },
    ];

    const updates: TaskBoard[] = [];
    const res = await runAgent({
      userText: "find Josh, read the TEDC doc, read slides 26-35 of the Q3 deck, and then rewrite slide 27",
      history: [],
      settings,
      conversationId: "conv_test_1",
      onBoardUpdate: (b: TaskBoard) => updates.push(b),
    } as any);

    expect(res.content).toMatch(/complete/i);
    expect(store).not.toBeNull();
    expect(store!.tasks).toHaveLength(4);
    expect(store!.tasks.every((c) => c.status === "done")).toBe(true);
    expect(store!.tasks.every((c) => (c.evidence?.trim().length ?? 0) > 0)).toBe(true);
    // One board write per round R0..R4 => at least 5 UI updates. Proves the loop
    // ran well past the old MAX_ROUNDS=5 (6 rounds total for this 4-task request).
    expect(updates.length).toBeGreaterThanOrEqual(5);
  });

  it("rejects a done-without-work card mid-flow, then recovers", async () => {
    llmScript = [
      // R0 — decompose one card, in_progress.
      { content: "", tool_calls: [mt("a", [{ id: "", title: "Pull X", status: "in_progress" }])] },
      // R1 — try to mark done with NO tool call this round and fake evidence => REJECTED.
      { content: "", tool_calls: [mt("b", [{ id: "t_0", title: "Pull X", status: "done", evidence: "did it" }])] },
      // R2 — recover: actually call a tool, supply real evidence.
      { content: "", tool_calls: [tool("c", "brain_page", { name: "X" }), mt("d", [
        { id: "t_0", title: "Pull X", status: "done", evidence: "brain_page returned X page" },
      ])] },
      // R3 — final answer.
      { content: "done.", tool_calls: [] },
    ];

    const res = await runAgent({
      userText: "pull thing X and then summarize thing Y so it counts as multi-task",
      history: [],
      settings,
      conversationId: "conv_test_2",
    } as any);

    expect(store).not.toBeNull();
    expect(store!.tasks[0].status).toBe("done");
    expect(store!.tasks[0].evidence).toMatch(/brain_page/);
    expect(res.content).toMatch(/done/i);
  });

  it("nudges once when the model narrates a plan with no tool call", async () => {
    // First reply is pure narration (the exact failure). The loop must NOT return it;
    // it nudges, and the model then decomposes properly.
    llmScript = [
      { content: "I've queued all tasks. Here's the breakdown: 1. Find Josh 2. Read TEDC", tool_calls: [] },
      { content: "", tool_calls: [mt("a", [
        { id: "", title: "Find Josh", status: "in_progress" },
        { id: "", title: "Read TEDC", status: "todo" },
      ])] },
      { content: "", tool_calls: [tool("b", "brain_page", { name: "Josh" }), mt("c", [
        { id: "t_0", title: "Find Josh", status: "done", evidence: "brain_page returned Josh page" },
        { id: "t_1", title: "Read TEDC", status: "in_progress" },
      ])] },
      { content: "", tool_calls: [tool("d", "read_file", {}), mt("e", [
        { id: "t_0", title: "Find Josh", status: "done", evidence: "brain_page returned Josh page" },
        { id: "t_1", title: "Read TEDC", status: "done", evidence: "read_file returned 42 lines" },
      ])] },
      { content: "Both done.", tool_calls: [] },
    ];

    const res = await runAgent({
      userText: "find Josh and then read the TEDC doc",
      history: [],
      settings,
      conversationId: "conv_test_3",
    } as any);

    // The narration was NOT returned as the answer; the board was actually built out.
    expect(res.content).not.toMatch(/breakdown/i);
    expect(store!.tasks).toHaveLength(2);
    expect(store!.tasks.every((c) => c.status === "done")).toBe(true);
  });
});

// These three patterns were NOT caught by the scripted happy-path test above — they
// only surfaced when running the loop against the real qwen3-8b model, which splits
// work across rounds, drops cards on re-send, and ignores forced tool_choice ~1/3
// of the time. Each is locked in here so the fix can't silently regress.
describe("real-model failure patterns (found via live testing)", () => {
  it("accepts a card marked done a LATER round than its tool call (work and board update split)", async () => {
    llmScript = [
      { content: "", tool_calls: [mt("a", [
        { id: "", title: "Find Josh", status: "in_progress" },
        { id: "", title: "Read TEDC", status: "todo" },
      ])] },
      // R1: tool ALONE, no board update this round.
      { content: "", tool_calls: [tool("b", "brain_page", { name: "Josh" })] },
      // R2: mark card 1 done — the tool ran a round earlier. A per-round gate would reject this.
      { content: "", tool_calls: [mt("c", [
        { id: "t_0", title: "Find Josh", status: "done", evidence: "brain_page returned Josh page" },
        { id: "t_1", title: "Read TEDC", status: "in_progress" },
      ])] },
      { content: "", tool_calls: [tool("d", "read_file", { path: "/x" })] },
      { content: "", tool_calls: [mt("e", [
        { id: "t_0", title: "Find Josh", status: "done", evidence: "brain_page returned Josh page" },
        { id: "t_1", title: "Read TEDC", status: "done", evidence: "read_file returned 42 lines" },
      ])] },
      { content: "both done.", tool_calls: [] },
    ];
    await runAgent({ userText: "find Josh and then read the TEDC doc", history: [], settings, conversationId: "rt1" } as any);
    expect(store!.tasks).toHaveLength(2);
    expect(store!.tasks.every((c) => c.status === "done")).toBe(true);
  });

  it("preserves a card the model omits on re-send (no silent drop)", async () => {
    const boards: TaskBoard[] = [];
    llmScript = [
      { content: "", tool_calls: [mt("a", [
        { id: "", title: "A", status: "in_progress" },
        { id: "", title: "B", status: "todo" },
      ])] },
      // R1: tool + board update in the SAME round (so the model's update wins, no
      // harness-advance), but the model re-sends ONLY card A — dropping B. Merge must keep B.
      { content: "", tool_calls: [tool("b", "brain_page", {}), mt("c", [
        { id: "t_0", title: "A", status: "done", evidence: "brain_page returned data" },
      ])] },
      // R2: complete B.
      { content: "", tool_calls: [tool("d", "read_file", {}), mt("e", [
        { id: "t_0", title: "A", status: "done", evidence: "brain_page returned data" },
        { id: "t_1", title: "B", status: "done", evidence: "read_file returned 9 lines" },
      ])] },
      { content: "done.", tool_calls: [] },
    ];
    await runAgent({
      userText: "do A and then do B",
      history: [],
      settings,
      conversationId: "rt2",
      onBoardUpdate: (b: TaskBoard) => boards.push(b),
    } as any);
    // After the drop round (R1 board update = boards[1]), B is still on the board.
    const afterDrop = boards[1];
    expect(afterDrop.tasks).toHaveLength(2);
    expect(afterDrop.tasks.find((c) => c.title === "B")).toBeTruthy();
    // And nothing was lost by the end.
    expect(store!.tasks).toHaveLength(2);
    expect(store!.tasks.every((c) => c.status === "done")).toBe(true);
  });

  it("harness advances the board when the model runs tools but never updates it", async () => {
    // The exact production failure: the model creates the board, then BATCHES the
    // real tools and never calls manage_tasks again. The harness must advance the
    // cards itself so they don't stay frozen in todo.
    llmScript = [
      { content: "", tool_calls: [mt("a", [
        { id: "", title: "Find Josh", status: "in_progress" },
        { id: "", title: "Buda HIVE", status: "todo" },
        { id: "", title: "Commitments", status: "todo" },
      ])] },
      // R1: three real tools, NO manage_tasks update.
      { content: "", tool_calls: [
        tool("b", "brain_page", { name: "Josh" }),
        tool("c", "brain_search", { query: "Buda HIVE" }),
        tool("d", "calendar_events", {}),
      ] },
      { content: "All three done.", tool_calls: [] },
    ];
    await runAgent({
      userText: "find Josh, look up Buda HIVE, and tell me my open commitments",
      history: [],
      settings,
      conversationId: "ha1",
    } as any);
    // Despite the model never moving the cards, all three reached done.
    expect(store!.tasks).toHaveLength(3);
    expect(store!.tasks.every((c) => c.status === "done")).toBe(true);
  });

  it("retries the decomposition when round 0 returns prose (flaky forced tool_choice)", async () => {
    llmScript = [
      // Forced tool_choice ignored — model returns prose the narration regex won't catch.
      { content: "Sure, I can help with that.", tool_calls: [] },
      { content: "", tool_calls: [mt("a", [
        { id: "", title: "A", status: "in_progress" },
        { id: "", title: "B", status: "todo" },
      ])] },
      { content: "", tool_calls: [tool("b", "brain_page", {}), mt("c", [
        { id: "t_0", title: "A", status: "done", evidence: "brain_page returned data" },
        { id: "t_1", title: "B", status: "in_progress" },
      ])] },
      { content: "", tool_calls: [tool("d", "read_file", {}), mt("e", [
        { id: "t_0", title: "A", status: "done", evidence: "brain_page returned data" },
        { id: "t_1", title: "B", status: "done", evidence: "read_file returned 9 lines" },
      ])] },
      { content: "all set.", tool_calls: [] },
    ];
    const res = await runAgent({
      userText: "find Josh in the brain and then read the TEDC document",
      history: [],
      settings,
      conversationId: "rt3",
    } as any);
    // The round-0 prose was NOT returned; the board was built and finished.
    expect(res.content).not.toMatch(/i can help/i);
    expect(store!.tasks).toHaveLength(2);
    expect(store!.tasks.every((c) => c.status === "done")).toBe(true);
  });

  it("builds the board from the tool calls when the model batches instead of decomposing", async () => {
    // The production reality: tool_choice "required" can't force manage_tasks, and
    // the small model relentlessly batches the domain tools and never lays out a
    // board. The harness must BUILD the board from those tool calls (one card each)
    // and advance them — guaranteeing a visible, completing board regardless.
    llmScript = [
      // R0: three domain tools, NO manage_tasks anywhere.
      { content: "", tool_calls: [
        tool("a", "brain_page", { name: "Josh" }),
        tool("b", "brain_search", { query: "Buda HIVE" }),
        tool("c", "calendar_events", {}),
      ] },
      { content: "all three done.", tool_calls: [] },
    ];
    await runAgent({
      userText: "find Josh, look up Buda HIVE, and tell me my open commitments",
      history: [],
      settings,
      conversationId: "bf1",
    } as any);
    // The harness synthesized a 3-card board from the tool calls and drove it to done.
    expect(store).not.toBeNull();
    expect(store!.tasks).toHaveLength(3);
    expect(store!.tasks.every((c) => c.status === "done")).toBe(true);
  });

  it("clears a stale board from a previous request and starts fresh on a new ask", async () => {
    // Leftover half-finished board from a PRIOR request in this conversation.
    store = {
      conversation_id: "sb1",
      updated_at: "old",
      version: 1,
      tasks: [
        { id: "old1", title: "Find Josh", status: "done", evidence: "x", created_at: "", updated_at: "", attempt_count: 1 },
        { id: "old2", title: "Buda HIVE", status: "in_progress", created_at: "", updated_at: "", attempt_count: 1 },
        { id: "old3", title: "Commitments", status: "todo", created_at: "", updated_at: "", attempt_count: 1 },
      ],
    } as any;
    llmScript = [
      // A NEW, unrelated multi-task request: model batches two tools, no manage_tasks.
      { content: "", tool_calls: [
        tool("a", "calendar_events", {}),
        tool("b", "brain_search", { query: "briefing" }),
      ] },
      { content: "done.", tool_calls: [] },
    ];
    await runAgent({
      userText: "find my daily briefing, mark Shelly as done, and check the Jennifer meeting",
      history: [],
      settings,
      conversationId: "sb1",
    } as any);
    // The stale cards (Find Josh / Buda HIVE / Commitments) are gone; the board now
    // reflects ONLY the new request, built from its tool calls and completed.
    expect(store!.tasks.some((c) => c.title === "Find Josh")).toBe(false);
    expect(store!.tasks).toHaveLength(2);
    expect(store!.tasks.every((c) => c.status === "done")).toBe(true);
  });

  it("resumes an existing board on an explicit continuation", async () => {
    store = {
      conversation_id: "co1",
      updated_at: "old",
      version: 1,
      tasks: [
        { id: "c1", title: "Pull Josh", status: "done", evidence: "x", created_at: "", updated_at: "", attempt_count: 1 },
        { id: "c2", title: "Summarize deck", status: "in_progress", created_at: "", updated_at: "", attempt_count: 1 },
      ],
    } as any;
    llmScript = [
      { content: "", tool_calls: [tool("a", "read_file", {}), mt("b", [
        { id: "c1", title: "Pull Josh", status: "done", evidence: "x" },
        { id: "c2", title: "Summarize deck", status: "done", evidence: "read_file returned 42 lines" },
      ])] },
      { content: "finished.", tool_calls: [] },
    ];
    await runAgent({ userText: "continue", history: [], settings, conversationId: "co1" } as any);
    // The existing board was NOT cleared — its cards carried through to done.
    expect(store!.tasks.some((c) => c.title === "Pull Josh")).toBe(true);
    expect(store!.tasks.every((c) => c.status === "done")).toBe(true);
  });
});

describe("missing-input handling — ask first, don't grind", () => {
  it("returns the clarifying question instantly when the preflight fires — no LLM call", async () => {
    (missingInput as any).mockReturnValueOnce("Paste the video link and I'll watch it.");
    const res = await runAgent({
      userText: "watch this video and tell me what works",
      history: [],
      settings,
      conversationId: "mi1",
    } as any);
    expect(res.content).toMatch(/paste the video link/i);
    // The whole point: it did NOT spin up the slow model loop or a board.
    expect(streamChat).not.toHaveBeenCalled();
    expect(llmComplete).not.toHaveBeenCalled();
    expect(res.tools).toHaveLength(0);
    expect(store).toBeNull();
  });

  it("stops and asks when the model calls ask_user — runs no other tool, builds no board", async () => {
    llmScript = [
      // The model recognizes the gap and asks instead of guessing.
      { content: "", tool_calls: [tool("a", "ask_user", { question: "Which deck do you mean — Q3 or Q4?" })] },
    ];
    const res = await runAgent({
      userText: "summarize the deck and email it to the team",
      history: [],
      settings,
      conversationId: "mi2",
    } as any);
    expect(res.content).toMatch(/which deck/i);
    expect(res.tools).toContain("ask_user");
    // No domain tool ran and no board was persisted around the unanswerable ask.
    expect(brainPage).not.toHaveBeenCalled();
    expect(store).toBeNull();
  });
});

describe("trivial-turn fast lane — no tools, one round", () => {
  it("answers a greeting with a single NO-TOOLS completion and no board", async () => {
    (isTrivialChat as any).mockReturnValueOnce(true);
    (resolveBaseEndpoint as any).mockResolvedValueOnce({
      baseUrl: "http://x",
      token: "",
      models: ["qwen3-8b"],
    });
    llmScript = [{ content: "Hey! Doing great — what can I help with?", tool_calls: [] }];

    const res = await runAgent({
      userText: "hey how are you",
      history: [],
      settings,
      conversationId: "fl1",
    } as any);

    expect(res.content).toMatch(/doing great/i);
    expect(res.tools).toHaveLength(0);
    expect(store).toBeNull(); // no task board spun up
    // Exactly one model round (streamed in direct mode), and CRUCIALLY with NO tool
    // schema — that's the whole prefill saving for non-thinking turns.
    expect(streamChat).toHaveBeenCalledTimes(1);
    expect((streamChat as any).mock.calls[0][0].tools).toBeUndefined();
  });
});

describe("self-repair on a tool call leaked as text", () => {
  it("re-prompts once and runs the real tool instead of returning the dangling text", async () => {
    // R0 is the exact failure from the 2026-06-21 log: a tool call written as
    // prose (hallucinated name + stray markup), no structured tool_calls. The
    // loop must NOT surface it — it self-repairs, and the model then emits a
    // real call that executes.
    llmScript = [
      { content: "open_url,url:https://youtu.be/abc}<tool_call|>", tool_calls: [] },
      { content: "", tool_calls: [tool("a", "brain_search", { query: "Buda HIVE" })] },
      { content: "Here's what I found.", tool_calls: [] },
    ];

    const res = await runAgent({
      userText: "look up Buda HIVE",
      history: [],
      settings,
      conversationId: "sr1",
    } as any);

    expect(res.content).not.toMatch(/open_url|tool_call/i); // the leak was never shown
    expect(res.content).toMatch(/found/i); // reached the answer after repair
    expect(res.tools).toContain("brain_search"); // a real tool actually ran
    expect(streamChat).toHaveBeenCalledTimes(3); // leak -> repair re-prompt -> answer
  });
});
