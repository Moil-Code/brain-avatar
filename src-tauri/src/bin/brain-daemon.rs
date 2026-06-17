//! brain-daemon — exposes the Mac Mini's brain-owner tools over authenticated HTTP
//! so the MacBook client can reach the brain, calendar, mail, web, and LLM remotely
//! (over Tailscale). Secrets stay HERE — read from the app's settings.json; the
//! client holds only the daemon URL + a bearer token. Bind to the tailnet interface.
//!
//!   BRAIN_DAEMON_TOKEN   (required)  long random secret; clients send `Bearer <it>`
//!   BRAIN_DAEMON_BIND    (optional)  host:port to bind, default 127.0.0.1:8787
//!                                    (set to the Tailscale IP, e.g. 100.x.y.z:8787)

use std::sync::Arc;
use std::time::Duration;

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
use tokio::sync::{Notify, Semaphore};

use brain_avatar_lib::config::{self, Settings};
use brain_avatar_lib::{llm, tools, voice};

struct AppState {
    settings: Settings,
    token: String,
    /// Single-flight gate for LLM generation. The 24GB Mac (LM Studio) runs every
    /// concurrent request in PARALLEL — it never queues — and two heavy generations
    /// (e.g. the local avatar + the MacBook, or the 26B + 12B at once) overwhelm its
    /// memory and stall the whole box. With every client pointed at this daemon, this
    /// 1-permit semaphore serializes generation: the second request WAITS instead of
    /// piling on. Probes (/models) are intentionally NOT gated — they don't generate.
    gen_lock: Arc<Semaphore>,
    /// Fired by POST /llm/cancel (client hit Stop). The in-flight relay races its
    /// LM Studio request against this and drops it, so generation halts server-side
    /// instead of running to completion after the client hung up.
    cancel: Arc<Notify>,
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
    let state = Arc::new(AppState {
        settings,
        token,
        gen_lock: Arc::new(Semaphore::new(1)),
        cancel: Arc::new(Notify::new()),
    });

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
        .route("/chat/push", post(chat_push))
        .route("/facebook/insights", post(facebook_insights))
        .route("/web/search", post(web_search))
        .route("/web/fetch", post(web_fetch))
        .route("/web/task", post(web_task))
        .route("/llm/complete", post(llm_complete))
        .route("/llm/probe", post(llm_probe))
        .route("/stt/transcribe", post(stt_transcribe))
        // OpenAI-shaped passthrough so the app's existing LM Studio prober/completer
        // can point at the daemon and have it relay to the real LM Studio (on the
        // 24GB Mac, reachable from here over the LAN) — works from anywhere.
        .route("/api/v0/models", get(lm_api_v0_models))
        .route("/v1/models", get(lm_v1_models))
        .route("/v1/chat/completions", post(lm_v1_chat))
        .route("/llm/cancel", post(llm_cancel))
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
struct ChatPush {
    conversation_id: String,
    #[serde(default)]
    title: String,
    role: String,
    content: String,
}

/// Receive a chat turn pushed from a client (MacBook) and append it to the
/// cross-machine inbox so the nightly avatar-chat ingest captures it.
async fn chat_push(State(_st): State<Arc<AppState>>, Json(p): Json<ChatPush>) -> ToolResult {
    tools::push_chat_core(p.conversation_id, p.title, p.role, p.content)
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

// ------------------------------------------------------------------------ facebook
#[derive(Deserialize)]
struct FbInsights {
    page: Option<String>,
}
async fn facebook_insights(
    State(_st): State<Arc<AppState>>,
    Json(p): Json<FbInsights>,
) -> ToolResult {
    tools::facebook_insights_core(p.page).await.map_err(err)
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

#[derive(Deserialize)]
struct WebTask {
    intent: String,
}
async fn web_task(State(_st): State<Arc<AppState>>, Json(p): Json<WebTask>) -> ToolResult {
    // Runs the browser agent (localhost:3939) here on the Mac Mini, where Andres'
    // logged-in browser sessions live.
    tools::web_task_core(p.intent).await.map_err(err)
}

// ----------------------------------------------------------------------------- llm
/// Resolve the REAL LM Studio endpoint (the 24GB Mac). The client never sees this.
///
/// Env override (`BRAIN_DAEMON_LLM_URL` / `BRAIN_DAEMON_LLM_TOKEN`) wins over
/// settings. This is REQUIRED on the Mac Mini, where the local avatar and this
/// daemon share one settings.json: once the avatar points `lm_studio_remote_url`
/// at the daemon (to be serialized), the daemon must NOT read that same field for
/// its own upstream — that would relay to itself in a loop. The env pins the true
/// LM Studio address independently of what the avatar writes into settings.
fn resolve_llm(s: &Settings) -> (String, Option<String>) {
    if let Ok(url) = std::env::var("BRAIN_DAEMON_LLM_URL") {
        if !url.trim().is_empty() {
            let tok = std::env::var("BRAIN_DAEMON_LLM_TOKEN").ok().filter(|t| !t.trim().is_empty());
            return (url, tok);
        }
    }
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
    let _permit = acquire_gen(&st, "/llm/complete").await;
    let (url, token) = resolve_llm(&st.settings);
    let r = llm::llm_complete_core(url, token, p.model, p.messages, p.tools, p.max_tokens, None)
        .await
        .map_err(err)?;
    Ok(Json(r))
}

/// Acquire the single-flight generation permit, logging if the caller has to wait
/// (i.e. another generation is already running). The returned guard releases the
/// permit on drop — including if the client disconnects mid-request (Stop), which
/// cancels this handler's future and frees the box for the next request.
async fn acquire_gen(st: &Arc<AppState>, route: &str) -> tokio::sync::OwnedSemaphorePermit {
    match st.gen_lock.clone().try_acquire_owned() {
        Ok(p) => p,
        Err(_) => {
            eprintln!("[brain-daemon] {route} queued — another generation in flight");
            st.gen_lock
                .clone()
                .acquire_owned()
                .await
                .expect("gen_lock never closed")
        }
    }
}

async fn llm_probe(State(st): State<Arc<AppState>>) -> Json<llm::ProbeResult> {
    let (url, token) = resolve_llm(&st.settings);
    Json(llm::llm_probe(url, token).await)
}

// --- OpenAI-shaped passthrough: relay to the real LM Studio with its own token ---
async fn relay_get(st: &Arc<AppState>, full_url: String) -> Result<Json<Value>, (StatusCode, String)> {
    let (_url, token) = resolve_llm(&st.settings);
    let client = reqwest::Client::new();
    let mut req = client.get(&full_url).timeout(Duration::from_secs(15));
    if let Some(t) = &token {
        if !t.trim().is_empty() {
            req = req.header("Authorization", format!("Bearer {t}"));
        }
    }
    let resp = req
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("LM Studio unreachable: {e}")))?;
    let status = resp.status();
    let v: Value = resp
        .json()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;
    if status.is_success() {
        Ok(Json(v))
    } else {
        Err((
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            v.to_string(),
        ))
    }
}

/// LM Studio base with any trailing `/v1` removed (its native API lives at the root).
fn lm_native_base(settings: &Settings) -> String {
    let (url, _) = resolve_llm(settings);
    url.trim_end_matches('/').trim_end_matches("/v1").to_string()
}

async fn lm_api_v0_models(State(st): State<Arc<AppState>>) -> Result<Json<Value>, (StatusCode, String)> {
    let full = format!("{}/api/v0/models", lm_native_base(&st.settings));
    relay_get(&st, full).await
}

async fn lm_v1_models(State(st): State<Arc<AppState>>) -> Result<Json<Value>, (StatusCode, String)> {
    let full = format!("{}/v1/models", lm_native_base(&st.settings));
    relay_get(&st, full).await
}

async fn lm_v1_chat(
    State(st): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, (StatusCode, String)> {
    // Serialize generation: this is the path every client uses when pointed at the
    // daemon, so the permit here is what actually prevents concurrent generations
    // from overwhelming the 24GB Mac.
    let _permit = acquire_gen(&st, "/v1/chat/completions").await;
    let (_url, token) = resolve_llm(&st.settings);
    let full = format!("{}/v1/chat/completions", lm_native_base(&st.settings));
    let client = reqwest::Client::new();
    let mut req = client.post(&full).json(&body).timeout(Duration::from_secs(300));
    if let Some(t) = &token {
        if !t.trim().is_empty() {
            req = req.header("Authorization", format!("Bearer {t}"));
        }
    }
    // Race generation against a client Stop (POST /llm/cancel). On cancel, `gen`
    // drops → its reqwest closes the LM Studio connection → generation halts
    // server-side instead of running to completion.
    let gen = async {
        let resp = req
            .send()
            .await
            .map_err(|e| (StatusCode::BAD_GATEWAY, format!("LM Studio unreachable: {e}")))?;
        let status = resp.status();
        let v: Value = resp
            .json()
            .await
            .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;
        Ok::<(StatusCode, Value), (StatusCode, String)>((status, v))
    };
    let notified = st.cancel.notified();
    tokio::pin!(gen, notified);
    let (status, v) = tokio::select! {
        r = &mut gen => r?,
        _ = &mut notified => {
            return Err((
                StatusCode::from_u16(499).unwrap_or(StatusCode::REQUEST_TIMEOUT),
                "cancelled".into(),
            ));
        }
    };
    if status.is_success() {
        Ok(Json(v))
    } else {
        Err((
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            v.to_string(),
        ))
    }
}

/// Client pressed Stop → wake the in-flight relay so it drops its LM Studio request.
async fn llm_cancel(State(st): State<Arc<AppState>>) -> &'static str {
    st.cancel.notify_waiters();
    "ok"
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
