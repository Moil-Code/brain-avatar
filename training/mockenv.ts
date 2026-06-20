// Mock tool environment — deterministic, side-effect-free tool results.
//
// Used by teacher distillation (distill.ts): the teacher model CHOOSES tools and we
// feed it canned-but-plausible results, so we capture its tool-selection + phrasing
// policy without touching the real brain/calendar/email or sending anything. Same
// idea as synthesize.ts's inline results, factored out so the distiller can call it.
//
// Every result is a short string (the shape real tools return to the model).

function argOf(argsJson: string, key: string): string {
  try {
    const v = JSON.parse(argsJson || "{}")[key];
    return v == null ? "" : String(v);
  } catch {
    return "";
  }
}

export function mockToolResult(name: string, argsJson: string): string {
  switch (name) {
    case "brain_page": {
      const n = argOf(argsJson, "name") || "the entity";
      return `${n} — active in Moil's network; owns a current workstream; last sync this week.`;
    }
    case "brain_search": {
      const q = argOf(argsJson, "query") || "that";
      return `Results for "${q}": two relevant notes; on track, one open risk.`;
    }
    case "calendar_events":
      return "10:00 Standup; 14:00 Review; 16:30 1:1";
    case "calendar_create":
    case "calendar_update":
    case "calendar_delete":
      return "ok (calendar updated)";
    case "web_search": {
      const q = argOf(argsJson, "query") || "topic";
      return `1. Overview — https://example.com/a (${q})\n2. Update — https://example.com/b`;
    }
    case "fetch_url":
      return "The page summarizes a recent milestone and a review scheduled for Friday.";
    case "read_emails":
      return '1. Priya: "roadmap update"\n2. Marcus: "launch plan sign-off"';
    case "email_details":
      return "Sender confirms the item is on track and needs sign-off by Friday.";
    case "find_files":
      return "~/Documents/doc.pdf";
    case "read_file":
      return "Document looks final; one open question on timing.";
    case "manage_tasks":
      return "board updated";
    case "system_control":
      return "ok";
    case "send_email":
    case "send_teams_message":
    case "post_to_facebook":
    case "create_reminder":
    case "create_automation":
      // Side-effecting tools: in distillation we never actually fire these. If the
      // teacher calls one, return a neutral ack — but the eval gate still penalizes
      // sending without a confirm, so good teachers ask first.
      return "ok (mock — not actually sent)";
    default:
      return `ok (${name})`;
  }
}
