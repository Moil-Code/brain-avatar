import { describe, it, expect } from "vitest";
import {
  detectNarration,
  validateEvidence,
  isMultiTask,
  estimateTaskCount,
  openCardCount,
  renderBoardSnapshot,
} from "./kanban";
import type { TaskBoard } from "./types";

describe("detectNarration — the TEDC failure phrasings", () => {
  it("catches 'I've queued all tasks'", () =>
    expect(
      detectNarration("I've queued all tasks. Here's the breakdown: 1. Retrieve Josh 2. Analyze slides")
    ).toBeTruthy());
  it("catches 'here's the breakdown'", () =>
    expect(detectNarration("Here's the breakdown of what I'll do")).toBeTruthy());
  it("catches a bare numbered plan with no tool call", () =>
    expect(
      detectNarration("OK so the plan is:\n1. Retrieve Josh slides\n2. Analyze them\n3. Rewrite slide 27")
    ).toBe("numbered_plan_no_tool"));
  it("catches 'I'll start with'", () =>
    expect(detectNarration("I'll start with finding Josh in the brain.")).toBeTruthy());
  it("ignores benign closings (no false positive)", () =>
    expect(detectNarration("Let me know if you need anything else.")).toBeNull());
  it("ignores a genuine question", () =>
    expect(detectNarration("Which slide should I focus on first?")).toBeNull());
  it("ignores a plain grounded answer", () =>
    expect(detectNarration("Josh Patel is the co-founder you built the HIVE program with.")).toBeNull());
});

describe("validateEvidence", () => {
  const tools = new Set(["brain_page", "read_file"]);
  it("accepts a tool name that ran this round", () =>
    expect(validateEvidence("brain_page returned Josh canonical page", tools).ok).toBe(true));
  it("accepts a file path", () =>
    expect(validateEvidence("read /Users/jarvisurrego/slides.pdf, 35 slides", tools).ok).toBe(true));
  it("accepts a URL", () =>
    expect(validateEvidence("opened https://moilapp.com/q3 and read it", tools).ok).toBe(true));
  it("accepts a quoted/prefixed id", () =>
    expect(validateEvidence("send_email returned msg_abc1234", tools).ok).toBe(true));
  it("accepts a number-with-unit", () =>
    expect(validateEvidence("found 47 results in the brain", tools).ok).toBe(true));
  it("rejects vague text with no artifact", () =>
    expect(validateEvidence("did it", tools).ok).toBe(false));
  it("rejects empty", () => expect(validateEvidence("", tools).ok).toBe(false));
  it("rejects a tool name that did NOT run this round", () =>
    expect(validateEvidence("web_search found the answer", new Set(["brain_page"])).ok).toBe(false));
});

describe("estimateTaskCount / isMultiTask", () => {
  const tedc = "find Josh, read the TEDC doc, read slides 26-35 of the Q3 deck, and then rewrite slide 27";
  it("isMultiTask true on the TEDC request", () => expect(isMultiTask(tedc)).toBe(true));
  it("estimateTaskCount >= 3 on the TEDC request", () =>
    expect(estimateTaskCount(tedc)).toBeGreaterThanOrEqual(3));
  it("counts an explicit numbered list", () =>
    expect(estimateTaskCount("1. find Josh\n2. read TEDC\n3. rewrite slide 27\n4. email Maria")).toBe(4));
  it("single question is not multi-task", () => expect(isMultiTask("What time is it?")).toBe(false));
  it("single imperative is not multi-task", () =>
    expect(isMultiTask("summarize the Q3 deck for me")).toBe(false));
  it("empty string counts as zero", () => expect(estimateTaskCount("   ")).toBe(0));
});

describe("openCardCount / renderBoardSnapshot", () => {
  const board: TaskBoard = {
    conversation_id: "c1",
    updated_at: "t",
    version: 3,
    tasks: [
      { id: "t_0", title: "Find Josh", status: "done", evidence: "brain_page returned Josh", created_at: "", updated_at: "", attempt_count: 1 },
      { id: "t_1", title: "Read TEDC", status: "in_progress", created_at: "", updated_at: "", attempt_count: 2 },
      { id: "t_2", title: "Rewrite slide 27", status: "todo", created_at: "", updated_at: "", attempt_count: 0 },
      { id: "t_3", title: "Email Maria", status: "blocked", blocker: "need Maria's address", created_at: "", updated_at: "", attempt_count: 1 },
    ],
  };
  it("counts only todo + in_progress as open", () => expect(openCardCount(board)).toBe(2));
  it("returns 0 for a null board", () => expect(openCardCount(null)).toBe(0));
  it("renders all four columns with counts", () => {
    const snap = renderBoardSnapshot(board);
    expect(snap).toContain("IN_PROGRESS (1)");
    expect(snap).toContain("TODO (1)");
    expect(snap).toContain("BLOCKED (1)");
    expect(snap).toContain("DONE (1)");
    expect(snap).toContain("Find Josh");
    expect(snap).toContain("blocker: need Maria's address");
  });
});
