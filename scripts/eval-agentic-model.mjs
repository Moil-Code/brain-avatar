#!/usr/bin/env node
// Agentic-readiness eval for a local model served by LM Studio (OpenAI-compatible).
//
// Run this ON the Mac Mini (or any host that can reach the LM Studio endpoint)
// AFTER loading the model you want to vet — e.g. Qwen3.6-27B-MTP-pi-tune. It
// mirrors the exact request shape Brain Avatar uses in src-tauri/src/llm.rs
// (native OpenAI tool_calls, temperature 0.1 with tools, stream:false,
// chat_template_kwargs.enable_thinking:false for qwen/gemma fast tiers) so a
// PASS here means the avatar's agent loop will actually work on this model.
//
//   node scripts/eval-agentic-model.mjs
//   node scripts/eval-agentic-model.mjs --model qwen3.6-27b-mtp-pi-tune
//   node scripts/eval-agentic-model.mjs --max-tokens 1536 --think      (force thinking on)
//
// Flags:
//   --url <base>        OpenAI base URL (default http://localhost:1234/v1)
//   --model <id>        Model id to target (default: whatever is loaded)
//   --token <bearer>    Authorization bearer token (for remote/proxied endpoints)
//   --max-tokens <n>    Cap per-call output (default 1024 — keeps the suite quick)
//   --think             Send enable_thinking:true (default: off, matching fast tiers)
//   --timeout <sec>     Per-request timeout (default 300)

const args = process.argv.slice(2);
function flag(name, def) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  const next = args[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

const BASE = String(flag("url", "http://localhost:1234/v1")).replace(/\/$/, "");
const MODEL_ARG = flag("model", "");
const TOKEN = flag("token", "");
const MAX_TOKENS = Number(flag("max-tokens", 1024));
const THINK = flag("think", false) === true;
const TIMEOUT_MS = Number(flag("timeout", 300)) * 1000;

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};
const ok = (s) => `${C.green}${s}${C.reset}`;
const bad = (s) => `${C.red}${s}${C.reset}`;
const warn = (s) => `${C.yellow}${s}${C.reset}`;

let MODEL = MODEL_ARG;

// --- one chat/completions call, shaped exactly like src-tauri/src/llm.rs ---
async function chat({ messages, tools = null, tool_choice = null, maxTokens = MAX_TOKENS }) {
  const hasTools = Array.isArray(tools) && tools.length > 0;
  const body = {
    model: MODEL,
    messages,
    temperature: hasTools ? 0.1 : 0.4,
    max_tokens: maxTokens,
    stream: false,
  };
  if (hasTools) {
    body.tools = tools;
    body.tool_choice = tool_choice ?? "auto";
  }
  // The app sends this for qwen/gemma non-deep tiers; pi-tune is a no-thinking
  // model, so we default it off here too (override with --think).
  body.chat_template_kwargs = { enable_thinking: THINK };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = Date.now();
  let resp;
  try {
    resp = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
  const ms = Date.now() - started;
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 300)}`);
  }
  const v = await resp.json();
  const msg = v?.choices?.[0]?.message ?? {};
  const completionTokens = v?.usage?.completion_tokens ?? null;
  const tps = completionTokens && ms > 0 ? (completionTokens / (ms / 1000)) : null;
  return {
    content: typeof msg.content === "string" ? msg.content : "",
    toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
    ms,
    completionTokens,
    tps,
    raw: v,
  };
}

// Tools the model is offered in the tool tests (shape matches agent.ts).
const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather for a city.",
      parameters: {
        type: "object",
        properties: { location: { type: "string", description: "City name, e.g. 'Tokyo'" } },
        required: ["location"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for current information.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Search query" } },
        required: ["query"],
      },
    },
  },
];

const results = [];
const record = (name, pass, detail, stats) =>
  results.push({ name, pass, detail, stats: stats || "" });

function statline(r) {
  if (r.tps) return `${C.dim}${r.ms}ms · ${r.completionTokens} tok · ${r.tps.toFixed(1)} tok/s${C.reset}`;
  return `${C.dim}${r.ms}ms${C.reset}`;
}

function parseArgs(tc) {
  try {
    const a = tc?.function?.arguments;
    return typeof a === "string" ? JSON.parse(a) : a ?? {};
  } catch {
    return null;
  }
}

async function main() {
  console.log(`${C.bold}Agentic model eval${C.reset}  →  ${C.cyan}${BASE}${C.reset}`);

  // 0) Reachability + which model is loaded.
  try {
    const r = await fetch(`${BASE}/models`, {
      headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const list = (await r.json())?.data ?? [];
    const ids = list.map((m) => m.id);
    if (!MODEL) {
      MODEL = ids[0] || "";
      console.log(`Model (auto): ${C.bold}${MODEL || "(none loaded!)"}${C.reset}`);
    } else {
      const loaded = ids.some((id) => id.toLowerCase() === MODEL.toLowerCase());
      console.log(
        `Model: ${C.bold}${MODEL}${C.reset} ${loaded ? ok("(loaded)") : warn("(NOT in /models — load it in LM Studio)")}`
      );
    }
    console.log(`${C.dim}Loaded: ${ids.join(", ") || "none"}${C.reset}\n`);
  } catch (e) {
    console.log(bad(`Cannot reach ${BASE}/models — is LM Studio running and serving? (${e.message})`));
    process.exit(2);
  }
  if (!MODEL) {
    console.log(bad("No model loaded and none specified. Load the model in LM Studio, or pass --model."));
    process.exit(2);
  }

  // 1) Plain completion + throughput.
  try {
    const r = await chat({
      messages: [{ role: "user", content: "Reply with exactly: READY" }],
      maxTokens: 16,
    });
    const pass = /ready/i.test(r.content);
    record("Basic completion + throughput", pass, pass ? `said "${r.content.trim()}"` : `got "${r.content.trim()}"`, statline(r));
  } catch (e) {
    record("Basic completion + throughput", false, e.message);
  }

  // 2) Single native tool call (the core requirement).
  let firstCall = null;
  try {
    const r = await chat({
      messages: [
        { role: "system", content: "You are a tool-using assistant. Call a tool when it helps." },
        { role: "user", content: "What's the weather in Tokyo right now?" },
      ],
      tools: TOOLS,
    });
    firstCall = r.toolCalls[0] || null;
    const a = firstCall ? parseArgs(firstCall) : null;
    const right = firstCall?.function?.name === "get_weather";
    const argOk = a && typeof a.location === "string" && /tokyo/i.test(a.location);
    const pass = right && argOk;
    record(
      "Native tool_call (auto)",
      pass,
      firstCall
        ? `called ${firstCall.function?.name}(${JSON.stringify(a)})${right ? "" : " — wrong tool"}${argOk ? "" : " — bad/missing args"}`
        : `no tool_calls emitted (content: "${r.content.slice(0, 80)}")`,
      statline(r)
    );
  } catch (e) {
    record("Native tool_call (auto)", false, e.message);
  }

  // 3) Multi-round loop: feed the tool result back, expect a final NL answer
  //    (no further tool_calls). This is what the 5-round agent loop relies on.
  try {
    const call = firstCall || {
      id: "call_1",
      type: "function",
      function: { name: "get_weather", arguments: JSON.stringify({ location: "Tokyo" }) },
    };
    const r = await chat({
      messages: [
        { role: "system", content: "You are a tool-using assistant." },
        { role: "user", content: "What's the weather in Tokyo right now?" },
        { role: "assistant", content: "", tool_calls: [call] },
        { role: "tool", tool_call_id: call.id || "call_1", content: "18°C, light rain." },
      ],
      tools: TOOLS,
    });
    const pass = r.toolCalls.length === 0 && /18|rain/i.test(r.content);
    record(
      "Multi-round tool loop closes",
      pass,
      r.toolCalls.length
        ? `looped again instead of answering (${r.toolCalls.length} more call(s))`
        : `answered: "${r.content.slice(0, 90).replace(/\s+/g, " ")}"`,
      statline(r)
    );
  } catch (e) {
    record("Multi-round tool loop closes", false, e.message);
  }

  // 4) Forced tool_choice (the app forces manage_tasks on round 0 of multi-task asks).
  try {
    const r = await chat({
      messages: [{ role: "user", content: "Hello there." }],
      tools: TOOLS,
      tool_choice: { type: "function", function: { name: "web_search" } },
    });
    const forced = r.toolCalls[0]?.function?.name === "web_search";
    record(
      "Forced tool_choice honored",
      forced,
      forced ? "called web_search as forced" : `did not honor forced choice (calls: ${r.toolCalls.map((t) => t.function?.name).join(",") || "none"})`,
      statline(r)
    );
  } catch (e) {
    record("Forced tool_choice honored", false, e.message);
  }

  // 5) Restraint: with tools offered but a plain question, it should NOT call a
  //    tool. Over-calling/narrating is the exact failure that spirals the loop.
  try {
    const r = await chat({
      messages: [
        { role: "system", content: "Answer directly. Only call a tool when truly needed." },
        { role: "user", content: "In one word, what is 2 + 2?" },
      ],
      tools: TOOLS,
    });
    const pass = r.toolCalls.length === 0 && /4|four/i.test(r.content);
    record(
      "Restraint (no needless tool call)",
      pass,
      r.toolCalls.length ? `needlessly called ${r.toolCalls[0].function?.name}` : `answered: "${r.content.trim().slice(0, 40)}"`,
      statline(r)
    );
  } catch (e) {
    record("Restraint (no needless tool call)", false, e.message);
  }

  // 6) Strict JSON (router/structured paths depend on parseable output).
  try {
    const r = await chat({
      messages: [
        { role: "user", content: 'Return ONLY a JSON object: {"city":"Paris","country":"France"}. No prose, no code fence.' },
      ],
      maxTokens: 64,
    });
    let parsed = null;
    try { parsed = JSON.parse(r.content.trim().replace(/^```(json)?|```$/g, "").trim()); } catch {}
    const pass = parsed && parsed.city && parsed.country;
    record("Strict JSON output", pass, pass ? `parsed {${parsed.city}, ${parsed.country}}` : `unparseable: "${r.content.slice(0, 60)}"`, statline(r));
  } catch (e) {
    record("Strict JSON output", false, e.message);
  }

  // --- scorecard ---
  console.log(`${C.bold}Results${C.reset}`);
  let passed = 0;
  for (const r of results) {
    const tag = r.pass ? ok("PASS") : bad("FAIL");
    if (r.pass) passed++;
    console.log(`  ${tag}  ${r.name}  ${r.stats}`);
    console.log(`        ${C.dim}${r.detail}${C.reset}`);
  }
  const total = results.length;
  // Tests 2,3,4 are the load-bearing agentic ones; gate the verdict on those.
  const critical = ["Native tool_call (auto)", "Multi-round tool loop closes", "Forced tool_choice honored"];
  const criticalPass = results.filter((r) => critical.includes(r.name) && r.pass).length;

  console.log(`\n${C.bold}Score: ${passed}/${total}${C.reset}  (critical agentic: ${criticalPass}/${critical.length})`);
  if (criticalPass === critical.length) {
    console.log(ok("✅ VERDICT: agentic-ready — native tool calls work end-to-end in this app's format."));
  } else if (criticalPass >= 1) {
    console.log(warn("⚠️  VERDICT: partial — tool calling is flaky. Check LM Studio's tool-call parser / chat template for this model before relying on it for the agent loop."));
  } else {
    console.log(bad("❌ VERDICT: not usable for the agent loop — it never emitted valid native tool_calls. Likely the GGUF's chat template / tool parser isn't wired up in LM Studio for this build."));
  }
  process.exit(criticalPass === critical.length ? 0 : 1);
}

main().catch((e) => {
  console.error(bad(`eval crashed: ${e.stack || e.message}`));
  process.exit(2);
});
