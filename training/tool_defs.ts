// Canonical tool schemas for the training pipeline (OpenAI/MLX-LM `tools` format).
//
// One source of truth shared by the exporter (attach to SFT examples so the model
// trains WITH the tool signatures — MLX-LM/HF best practice), the eval runner, and
// teacher distillation. Names + argument names mirror how the production agent loop
// calls these tools (see src/lib/agent.ts and the synthesize/mockenv usage); keep in
// sync with the Rust tool registrations in src-tauri/src/tools.rs.
//
// Arguments are the OpenAI/Mistral convention (a JSON *string* in `tool_calls`),
// which matches our captured trajectories and the Qwen3 fast-tier target. If a future
// base model expects dict-encoded arguments, adapt at export time.

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

const fn = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = []
): ToolDef => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });

const str = (description: string) => ({ type: "string", description });

export const TOOL_DEFS: ToolDef[] = [
  fn("brain_page", "Get the canonical brain page for a named person, company, project, or concept.",
    { name: str("Exact entity name, e.g. 'Jordan Avery' or 'Northwind Logistics'.") }, ["name"]),
  fn("brain_search", "Hybrid search over the brain for broader or contextual questions.",
    { query: str("What to look up.") }, ["query"]),
  fn("calendar_events", "Read calendar events for a time range.",
    { range: str("Natural-language range, e.g. 'today', 'tomorrow', 'this week'.") }, ["range"]),
  fn("web_search", "Search the web for current or public information not in the brain.",
    { query: str("Search query.") }, ["query"]),
  fn("fetch_url", "Fetch and read the visible text of a specific URL (use after web_search).",
    { url: str("Absolute URL to fetch.") }, ["url"]),
  fn("read_emails", "List recent emails matching a natural-language query (sender/subject/keyword).",
    { query: str("Who/what to filter by.") }, ["query"]),
  fn("email_details", "Read the body of a specific email resolved by a natural-language query.",
    { query: str("Sender/subject/keyword identifying the email.") }, ["query"]),
  fn("find_files", "Find files on the Mac by name or keyword.",
    { query: str("Filename or keyword.") }, ["query"]),
  fn("read_file", "Read the text of a file by path.",
    { path: str("Absolute or ~-relative path.") }, ["path"]),
  fn("manage_tasks", "Create/update the task board (decompose multi-step work). First card in_progress.",
    {
      cards: {
        type: "array",
        description: "One card per task.",
        items: {
          type: "object",
          properties: {
            title: str("Short task title."),
            status: { type: "string", enum: ["todo", "in_progress", "done", "blocked"] },
          },
          required: ["title", "status"],
        },
      },
    }, ["cards"]),
  fn("send_email", "Send an email. Confirm with the user FIRST; only call with confirm=true after approval.",
    {
      to: str("Recipient."),
      subject: str("Subject line."),
      body: str("Email body."),
      confirm: { type: "boolean", description: "Must be true; set only after the user approves." },
    }, ["to", "body", "confirm"]),
  fn("create_reminder", "Create a reminder. Confirm with the user first.",
    {
      title: str("What to be reminded about."),
      when: str("When the reminder should fire."),
      confirm: { type: "boolean", description: "Must be true; set only after the user approves." },
    }, ["title", "confirm"]),
  fn("create_automation", "Create a recurring automation. Confirm the schedule + action first.",
    {
      prompt: str("The instruction to run on schedule."),
      schedule: str("Cadence, e.g. 'every Monday at 9am'."),
      confirm: { type: "boolean", description: "Must be true; set only after the user approves." },
    }, ["prompt", "confirm"]),
  fn("system_control", "Direct device control (no confirm needed for volume/media/brightness).",
    {
      action: {
        type: "string",
        enum: ["volume_up", "volume_down", "mute", "media_playpause", "brightness_up", "brightness_down"],
        description: "The device action.",
      },
    }, ["action"]),
];

/** Just the tool names, in canonical order. */
export const TOOL_NAMES: string[] = TOOL_DEFS.map((t) => t.function.name);
