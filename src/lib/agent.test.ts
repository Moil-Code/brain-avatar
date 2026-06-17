import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TaskBoard } from "./types";

// In-memory board store + scripted LLM responses, driven per test.
let store: TaskBoard | null = null;
let llmScript: any[] = [];
let llmIdx = 0;

// Mock the endpoint resolver + router so runAgent never touches the network.
vi.mock("./llm", () => ({
  resolveBaseEndpoint: vi.fn(async () => ({ baseUrl: "http://x", token: "", models: [] })),
}));
vi.mock("./router", () => ({
  routeTask: vi.fn(async () => ({ modelId: "qwen3-8b", taskType: "deep", enhanced: "", routed: false })),
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
  brainPage: vi.fn(async () => "brain_page OK: Josh Patel canonical page, 12 lines"),
  readFile: vi.fn(async () => "read_file OK: /Users/x/file.md, 42 lines"),
}));

import { runAgent } from "./agent";
import { brainPage } from "./tauri"; // the mocked wrapper, for call-count assertions

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
      { content: "", tool_calls: [tool("b", "brain_page", {})] },
      // R2: model re-sends ONLY card A (drops B). Merge must keep B.
      { content: "", tool_calls: [mt("c", [
        { id: "t_0", title: "A", status: "done", evidence: "brain_page returned data" },
      ])] },
      { content: "", tool_calls: [tool("d", "read_file", {})] },
      { content: "", tool_calls: [mt("e", [
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
    // After the drop round, the board still has BOTH cards (B preserved as todo).
    const afterDrop = boards[1];
    expect(afterDrop.tasks).toHaveLength(2);
    expect(afterDrop.tasks.find((c) => c.title === "B")?.status).toBe("todo");
    // And nothing was lost by the end.
    expect(store!.tasks).toHaveLength(2);
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

  it("defers a non-board tool on round 0 and forces the board first (board-first)", async () => {
    // tool_choice "required" forces *a* tool but can't force manage_tasks, so the
    // real model dives into brain_page first. The harness must DROP that round-0 call
    // and require the board before any domain tool runs.
    llmScript = [
      // R0: model dives into brain_page WITHOUT laying out the board — must be deferred.
      { content: "", tool_calls: [tool("a", "brain_page", { name: "Josh" })] },
      // R1: forced to create the board first.
      { content: "", tool_calls: [mt("b", [
        { id: "", title: "Find Josh", status: "in_progress" },
        { id: "", title: "Read TEDC", status: "todo" },
      ])] },
      // R2: now the real work runs, card 1 done.
      { content: "", tool_calls: [tool("c", "brain_page", { name: "Josh" }), mt("d", [
        { id: "t_0", title: "Find Josh", status: "done", evidence: "brain_page returned Josh page" },
        { id: "t_1", title: "Read TEDC", status: "in_progress" },
      ])] },
      { content: "", tool_calls: [tool("e", "read_file", {}), mt("f", [
        { id: "t_0", title: "Find Josh", status: "done", evidence: "brain_page returned Josh page" },
        { id: "t_1", title: "Read TEDC", status: "done", evidence: "read_file returned 9 lines" },
      ])] },
      { content: "done.", tool_calls: [] },
    ];
    await runAgent({
      userText: "find Josh in the brain and then read the TEDC document",
      history: [],
      settings,
      conversationId: "bf1",
    } as any);
    // brain_page ran ONCE (in R2, after the board existed) — the R0 attempt was
    // deferred. Without the guard it would have run in R0 too (2 calls).
    expect((brainPage as any).mock.calls.length).toBe(1);
    expect(store).not.toBeNull();
    expect(store!.tasks).toHaveLength(2);
    expect(store!.tasks.every((c) => c.status === "done")).toBe(true);
  });
});
