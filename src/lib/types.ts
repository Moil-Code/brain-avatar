export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: Role;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

/** A turn shown in the UI (system/tool messages are hidden). */
export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  pending?: boolean;
  /** Names of tools invoked while producing this answer (for the UI badge). */
  tools?: string[];
}

export type AvatarState = "idle" | "listening" | "thinking" | "speaking";

export interface Settings {
  lm_studio_local_url: string;
  lm_studio_remote_url: string;
  lm_studio_remote_token: string;
  model: string;
  max_tokens: number;
  groq_api_key: string;
  groq_model: string;
  brave_api_key: string;
  gbrain_path: string;
  m365_path: string;
  m365_app_id: string;
  sync_api_url: string;
  sync_token: string;
  tts_voice: string;
  system_prompt: string;
}

export interface FeatureFlags {
  voice: boolean;
  web: boolean;
  sync: boolean;
  remoteLlm: boolean;
}

export interface LlmEndpoint {
  baseUrl: string;
  token?: string;
  model: string;
}
