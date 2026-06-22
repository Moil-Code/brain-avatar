// Eval runner — scores a model against the frozen CASES via an OpenAI-compatible
// endpoint (LM Studio). Use it to baseline the current model and to GATE every
// fine-tuned adapter: no adapter ships that scores below the baseline.
//
// Run on the Mac (with LM Studio serving):
//   LMSTUDIO_URL=http://localhost:1234/v1 MODEL=qwen3-8b \
//     node --experimental-strip-types training/eval/run.ts
//
// With no endpoint configured it LINTS the suite (validates case structure) and
// exits 0 — so CI/offline runs stay green without a model.

import { existsSync, readFileSync } from "node:fs";
import type { ChatMessage } from "../types.ts";
import { CASES, MULTI_TURN, scoreCase, scoreMultiTurn, TOOLS, type CaseResult } from "./cases.ts";
import { mockToolResult } from "../mockenv.ts";

const URL = process.env.LMSTUDIO_URL ?? "";
const MODEL = process.env.MODEL ?? "";
const TOKEN = process.env.LMSTUDIO_TOKEN ?? "";
const THRESHOLD = Number(process.env.EVAL_THRESHOLD ?? "0.8");

function systemPrompt(): string {
  const p = "training/system_prompt.txt";
  return existsSync(p) ? readFileSync(p, "utf8").trim() : "You are Brain, a tool-using assistant.";
}

async function callMessages(messages: ChatMessage[]): Promise<ChatMessage> {
  const res = await fetch(`${URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, temperature: 0, max_tokens: 512 }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message ?? { role: "assistant", content: "" };
}

const callModel = (user: string): Promise<ChatMessage> =>
  callMessages([{ role: "system", content: systemPrompt() }, { role: "user", content: user }]);

/** Drive a multi-turn case; the mock env supplies tool results between turns so the
 *  conversation can advance (e.g. confirm → send). Returns the per-turn assistant msgs. */
async function runMultiTurn(c: (typeof MULTI_TURN)[number]): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt() }];
  const replies: ChatMessage[] = [];
  for (const t of c.turns) {
    messages.push({ role: "user", content: t.user });
    const msg = await callMessages(messages);
    replies.push(msg);
    messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
    for (const tc of msg.tool_calls ?? []) {
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        name: tc.function.name,
        content: mockToolResult(tc.function.name, tc.function.arguments),
      });
    }
  }
  return replies;
}

async function main() {
  if (!URL || !MODEL) {
    // Offline lint: ensure every case is well-formed and scorable.
    let ok = true;
    for (const c of CASES) {
      if (!c.id || !c.user) {
        console.error(`malformed case: ${JSON.stringify(c)}`);
        ok = false;
      }
    }
    for (const c of MULTI_TURN) {
      if (!c.id || !c.turns?.length || c.turns.some((t) => !t.user)) {
        console.error(`malformed multi-turn case: ${JSON.stringify(c)}`);
        ok = false;
      }
    }
    console.log(`lint: ${CASES.length} cases, ${MULTI_TURN.length} multi-turn, ${TOOLS.length} tools — ${ok ? "OK" : "FAILED"}`);
    console.log("(set LMSTUDIO_URL and MODEL to run against a live model)");
    process.exit(ok ? 0 : 1);
  }

  const results: CaseResult[] = [];
  for (const c of CASES) {
    try {
      const msg = await callModel(c.user);
      results.push(scoreCase(c, msg));
    } catch (e) {
      results.push({ id: c.id, pass: false, reasons: [`error: ${e instanceof Error ? e.message : String(e)}`] });
    }
  }
  for (const c of MULTI_TURN) {
    try {
      results.push(scoreMultiTurn(c, await runMultiTurn(c)));
    } catch (e) {
      results.push({ id: c.id, pass: false, reasons: [`error: ${e instanceof Error ? e.message : String(e)}`] });
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const rate = passed / results.length;
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.id}${r.reasons.length ? "  — " + r.reasons.join("; ") : ""}`);
  }
  console.log(`\n${MODEL}: ${passed}/${results.length} (${(rate * 100).toFixed(0)}%)  threshold ${(THRESHOLD * 100).toFixed(0)}%`);
  process.exit(rate >= THRESHOLD ? 0 : 1);
}

main();
