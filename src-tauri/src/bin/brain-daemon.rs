//! brain-daemon — exposes the Mac Mini's brain-owner tools over authenticated HTTP
//! so the MacBook client can reach the brain, calendar, mail, web, and LLM remotely
//! (over Tailscale). Secrets stay HERE — read from the app's settings.json; the
//! client holds only the daemon URL + a bearer token. Bind to the tailnet interface.
//!
//!   BRAIN_DAEMON_TOKEN   (required)  long random secret; clients send `Bearer <it>`
//!   BRAIN_DAEMON_BIND    (optional)  host:port to bind, default 127.0.0.1:8787
//!                                    (set to the Tailscale IP, e.g. 100.91.28.27:8787)

use std::sync::Arc;

use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use brain_avatar_lib::config::{self, Settings};
use brain_avatar_lib::{llm, tools, voice};

struct AppState {
    settings: Settings,
    token: String,
}

/// Tool handlers return the tool's text output, or a 500 with the error message.
type ToolResult = Result<String, (StatusCode, String)>;

fn err(e: String) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, e)
}

#[tokio::main]
async fn main() {
    let settings = config::load_standalone();
    let token = std::env::var("BRAIN_DAEMON_TOKEN").unwrap_or_default();
    if token.trim().is_empty() {
        eprintln!(
            "FATAL: set BRAIN_DAEMON_TOKEN (a long random secret, e.g. `openssl rand -hex 32`) \
             before starting brain-daemon."
        );
        std::process::exit(1);
    }
    let bind = std::env::var("BRAIN_DAEMON_BIND").unwrap_or_else(|_| "127.0.0.1:8787".to_string());
    let state = Arc::new(AppState { settings, token });

    let protected = Router::new()
        .route("/brain/search", post(brain_search))
        .route("/brain/page", post(brain_page))
        .route("/calendar/events", post(calendar_events))
        .route("/calendar/create", post(calendar_create))
        .route("/calendar/update", post(calendar_update))
        .route("/calendar/delete", post(calendar_delete))
        .route("/calendar/teams-meeting", post(teams_meeting))
        .route("/mail/send", post(mail_send))
        .route("/mail/read", post(mail_read))
        .route("/mail/details", post(mail_details))
        .route("/reminder/create", post(reminder_create))
        .route("/teams/message", post(teams_message))
        .route("/web/search", post(web_search))
        .route("/web/fetch", post(web_fetch))
        .route("/llm/complete", post(llm_complete))
        .route("/llm/probe", post(llm_probe))
        .route("/stt/transcribe", post(stt_transcribe))
        .route("/auth/check", get(auth_check))
        .layer(middleware::from_fn_with_state(state.clone(), auth));

    let app = Router::new()
        .route("/health", get(health))
        .merge(protected)
        .with_state(state.clone());

    let listener = match tokio::net::TcpListener::bind(&bind).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("FATAL: cannot bind {bind}: {e}");
            std::process::exit(1);
        }
    };
    eprintln!("brain-daemon listening on http://{bind} (bearer auth required)");
    axum::serve(listener, app).await.unwrap();
}

/// Bearer-token gate + access log for every protected route.
async fn auth(
    State(st): State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let ok = req
        .headers()
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .map(|t| t == st.token)
        .unwrap_or(false);
    eprintln!(
        "[brain-daemon] {} {} -> {}",
        req.method(),
        req.uri().path(),
        if ok { "200" } else { "401" }
    );
    if ok {
        Ok(next.run(req).await)
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

/// Behind the bearer gate — reaching it at all means the token was accepted.
async fn auth_check() -> &'static str {
    "ok"
}

async fn health() -> Json<Value> {
    Json(json!({
        "ok": true,
        "service": "brain-daemon",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

// --------------------------------------------------------------------------- brain
#[derive(Deserialize)]
struct BrainSearch {
    query: String,
    limit: Option<u32>,
}
async fn brain_search(State(st): State<Arc<AppState>>, Json(p): Json<BrainSearch>) -> ToolResult {
    tools::brain_search_core(&st.settings, p.query, p.limit)
        .await
        .map_err(err)
}

#[derive(Deserialize)]
struct BrainPage {
    name: String,
}
async fn brain_page(State(st): State<Arc<AppState>>, Json(p): Json<BrainPage>) -> ToolResult {
    tools::brain_page_core(&st.settings, p.name).await.map_err(err)
}

// ------------------------------------------------------------------------ calendar
#[derive(Deserialize)]
struct CalEvents {
    days: Option<i64>,
}
async fn calendar_events(State(st): State<Arc<AppState>>, Json(p): Json<CalEvents>) -> ToolResult {
    tools::calendar_events_core(&st.settings, p.days)
        .await
        .map_err(err)
}

#[derive(Deserialize)]
struct CalCreate {
    subject: String,
    start: String,
    end: String,
    time_zone: Option<String>,
    attendees: Option<Vec<String>>,
    is_teams: Option<bool>,
    location: Option<String>,
    body: Option<String>,
}
async fn calendar_create(State(st): State<Arc<AppState>>, Json(p): Json<CalCreate>) -> ToolResult {
    tools::calendar_create_core(
        &st.settings,
        p.subject,
        p.start,
        p.end,
        p.time_zone,
        p.attendees,
        p.is_teams,
        p.location,
        p.body,
    )
    .await
    .map_err(err)
}

#[derive(Deserialize)]
struct CalUpdate {
    event_id: String,
    subject: Option<String>,
    start: Option<String>,
    end: Option<String>,
    time_zone: Option<String>,
    is_teams: Option<bool>,
    location: Option<String>,
}
async fn calendar_update(State(st): State<Arc<AppState>>, Json(p): Json<CalUpdate>) -> ToolResult {
    tools::calendar_update_core(
        &st.settings,
        p.event_id,
        p.subject,
        p.start,
        p.end,
        p.time_zone,
        p.is_teams,
        p.location,
    )
    .await
    .map_err(err)
}

#[derive(Deserialize)]
struct CalDelete {
    event_id: String,
}
async fn calendar_delete(State(st): State<Arc<AppState>>, Json(p): Json<CalDelete>) -> ToolResult {
    tools::calendar_delete_core(&st.settings, p.event_id)
        .await
        .map_err(err)
}

#[derive(Deserialize)]
struct TeamsMeeting {
    subject: String,
    start: String,
    end: String,
}
async fn teams_meeting(State(st): State<Arc<AppState>>, Json(p): Json<TeamsMeeting>) -> ToolResult {
    tools::create_teams_meeting_core(&st.settings, p.subject, p.start, p.end)
        .await
        .map_err(err)
}

// ------------------------------------------------------- mail / reminder / teams DM
#[derive(Deserialize)]
struct MailSend {
    to: Vec<String>,
    subject: String,
    body: String,
    cc: Option<Vec<String>>,
}
async fn mail_send(State(st): State<Arc<AppState>>, Json(p): Json<MailSend>) -> ToolResult {
    tools::send_email_core(&st.settings, p.to, p.subject, p.body, p.cc)
        .await
        .map_err(err)
}

#[derive(Deserialize)]
struct MailRead {
    count: Option<u32>,
}
async fn mail_read(State(st): State<Arc<AppState>>, Json(p): Json<MailRead>) -> ToolResult {
    tools::read_emails_core(&st.settings, p.count)
        .await
        .map_err(err)
}

#[derive(Deserialize)]
struct MailDetails {
    query: String,
}
async fn mail_details(State(st): State<Arc<AppState>>, Json(p): Json<MailDetails>) -> ToolResult {
    tools::email_details_core(&st.settings, p.query)
        .await
        .map_err(err)
}

#[derive(Deserialize)]
struct ReminderCreate {
    title: String,
    due: Option<String>,
    remind_at: Option<String>,
}
async fn reminder_create(
    State(st): State<Arc<AppState>>,
    Json(p): Json<ReminderCreate>,
) -> ToolResult {
    tools::create_reminder_core(&st.settings, p.title, p.due, p.remind_at)
        .await
        .map_err(err)
}

#[derive(Deserialize)]
struct TeamsMessage {
    recipient_email: String,
    message: String,
}
async fn teams_message(State(st): State<Arc<AppState>>, Json(p): Json<TeamsMessage>) -> ToolResult {
    tools::send_teams_message_core(&st.settings, p.recipient_email, p.message)
        .await
        .map_err(err)
}

// ----------------------------------------------------------------------------- web
#[derive(Deserialize)]
struct WebSearch {
    query: String,
}
async fn web_search(State(st): State<Arc<AppState>>, Json(p): Json<WebSearch>) -> ToolResult {
    tools::web_search_core(&st.settings, p.query)
        .await
        .map_err(err)
}

#[derive(Deserialize)]
struct WebFetch {
    url: String,
}
async fn web_fetch(State(_st): State<Arc<AppState>>, Json(p): Json<WebFetch>) -> ToolResult {
    tools::fetch_url(p.url).await.map_err(err)
}

// ----------------------------------------------------------------------------- llm
/// Resolve the LM Studio endpoint from the Mac Mini's settings (remote 24GB Mac is
/// primary; falls back to the local host). The client never sees these.
fn resolve_llm(s: &Settings) -> (String, Option<String>) {
    if !s.lm_studio_remote_url.trim().is_empty() {
        (
            s.lm_studio_remote_url.clone(),
            Some(s.lm_studio_remote_token.clone()),
        )
    } else {
        (s.lm_studio_local_url.clone(), None)
    }
}

#[derive(Deserialize)]
struct LlmComplete {
    model: String,
    messages: Value,
    tools: Option<Value>,
    max_tokens: Option<u32>,
}
async fn llm_complete(
    State(st): State<Arc<AppState>>,
    Json(p): Json<LlmComplete>,
) -> Result<Json<llm::LlmResult>, (StatusCode, String)> {
    let (url, token) = resolve_llm(&st.settings);
    let r = llm::llm_complete(url, token, p.model, p.messages, p.tools, p.max_tokens)
        .await
        .map_err(err)?;
    Ok(Json(r))
}

async fn llm_probe(State(st): State<Arc<AppState>>) -> Json<llm::ProbeResult> {
    let (url, token) = resolve_llm(&st.settings);
    Json(llm::llm_probe(url, token).await)
}

// ----------------------------------------------------------------------------- stt
#[derive(Deserialize)]
struct Transcribe {
    audio_base64: String,
    mime: Option<String>,
}
async fn stt_transcribe(State(st): State<Arc<AppState>>, Json(p): Json<Transcribe>) -> ToolResult {
    voice::transcribe_audio_core(&st.settings, p.audio_base64, p.mime)
        .await
        .map_err(err)
}
