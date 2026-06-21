// Shared types for the on-device training pipeline. Mirrors the captured
// trajectory schema (src-tauri/src/trajectory.rs, schema_version 1) so synthetic
// records and live captures share one shape and can be mixed freely.

/** An OpenAI-style chat message as the model actually saw it. Assistant turns that
 *  call tools carry `tool_calls`; tool results use role "tool". */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolEvent {
  round: number;
  name: string;
  arguments: string;
  ok: boolean;
}

/** One captured (or synthesized) turn. Field-for-field the on-disk JSONL record. */
export interface TrajectoryRecord {
  schema_version: number;
  conversation_id: string;
  turn_id: string;
  created_at: string;
  model_id: string;
  task_type: string;
  routed: boolean;
  user: string;
  messages: ChatMessage[];
  tool_events: ToolEvent[];
  tools_used: string[];
  rounds: number;
  final_answer: string;
  rating: number | null;
  source: "live" | "synthetic" | "distilled";
}

/** What the exporter emits per training example: MLX-LM `tools`/chat format. */
export interface MlxExample {
  messages: ChatMessage[];
  tools?: unknown[];
}
