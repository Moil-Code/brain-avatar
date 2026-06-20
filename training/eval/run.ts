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
import { CASES, scoreCase, TOOLS, type CaseResult } from "./cases.ts";

const URL = process.env.LMSTUDIO_URL ?? "";
const MODEL = process.env.MODEL ?? "";
const TOKEN = process.env.LMSTUDIO_TOKEN ?? "";
const THRESHOLD = Number(process.env.EVAL_THRESHOLD ?? "0.8");

function systemPrompt(): string {
  const p = "training/system_prompt.txt";
  return existsSync(p) ? readFileSync(p, "utf8").trim() : "You are Brain, a tool-using assistant.";
}

async function callModel(user: string): Promise<ChatMessage> {
  const messages = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: user },
  ];
  const res = await fetch(`${URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, temperature: 0, max_tokens: 512 }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message ?? { role: "assistant", content: "" };
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
    console.log(`lint: ${CASES.length} cases, ${TOOLS.length} tools — ${ok ? "OK" : "FAILED"}`);
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

  const passed = results.filter((r) => r.pass).length;
  const rate = passed / results.length;
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.id}${r.reasons.length ? "  — " + r.reasons.join("; ") : ""}`);
  }
  console.log(`\n${MODEL}: ${passed}/${results.length} (${(rate * 100).toFixed(0)}%)  threshold ${(THRESHOLD * 100).toFixed(0)}%`);
  process.exit(rate >= THRESHOLD ? 0 : 1);
}

main();
