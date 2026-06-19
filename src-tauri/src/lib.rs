mod automations;
mod commands;
pub mod config;
mod files;
mod history;
pub mod llm;
mod mcp;
mod shell;
mod task_board;
mod video;
pub mod tools;
mod tts;
pub mod voice;

use config::{Settings, SettingsState};
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewWindow,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

/// Show+focus the avatar if hidden/unfocused, otherwise hide it.
fn toggle_window(app: &AppHandle) {
    if let Some(win) = main_window(app) {
        let visible = win.is_visible().unwrap_or(false);
        let focused = win.is_focused().unwrap_or(false);
        if visible && focused {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

fn show_window(app: &AppHandle) {
    if let Some(win) = main_window(app) {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Global cursor position (physical px, same space as window position) — drives the
/// top-edge peek reveal/hide without relying on flaky webview hover events.
#[tauri::command]
fn cursor_position(app: AppHandle) -> (f64, f64) {
    app.cursor_position().map(|p| (p.x, p.y)).unwrap_or((0.0, 0.0))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // Load persisted settings into managed state.
            let settings: Settings = config::load(&handle);
            app.manage(SettingsState(Mutex::new(settings)));
            app.manage(tts::TtsState(Mutex::new(None)));
            app.manage(llm::CancelState::default());

            // --- Global hotkeys: Cmd+Shift+Space = summon/hide, Cmd+Shift+V = talk ---
            let toggle_shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::Space);
            let voice_shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyV);
            handle.plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(move |app, shortcut, event| {
                        if event.state() != ShortcutState::Pressed {
                            return;
                        }
                        if shortcut == &toggle_shortcut {
                            toggle_window(app);
                        } else if shortcut == &voice_shortcut {
                            show_window(app);
                            let _ = app.emit("toggle-voice", ());
                        }
                    })
                    .build(),
            )?;
            for sc in [toggle_shortcut, voice_shortcut] {
                if let Err(e) = app.global_shortcut().register(sc) {
                    eprintln!("Could not register global shortcut: {e}");
                }
            }

            // --- System tray ---
            let show_item = MenuItem::with_id(app, "show", "Show / Hide", true, None::<&str>)?;
            let settings_item =
                MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit Brain Avatar", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &settings_item, &quit_item])?;

            let icon = app
                .default_window_icon()
                .cloned()
                .expect("default window icon present");
            TrayIconBuilder::with_id("brain-tray")
                .icon(icon)
                .tooltip("Brain Avatar")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => toggle_window(app),
                    "settings" => {
                        show_window(app);
                        let _ = app.emit("open-settings", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // Position the avatar near the bottom-right of the primary screen.
            if let Some(win) = main_window(&handle) {
                if let (Ok(Some(monitor)), Ok(size)) = (win.primary_monitor(), win.outer_size()) {
                    let screen = monitor.size();
                    let margin = 24u32;
                    let x = screen.width.saturating_sub(size.width + margin);
                    let y = screen.height.saturating_sub(size.height + margin + 40);
                    let _ = win.set_position(tauri::PhysicalPosition { x: x as i32, y: y as i32 });
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cursor_position,
            commands::get_settings,
            commands::set_settings,
            commands::feature_flags,
            commands::notify,
            automations::get_automations,
            automations::set_automations,
            tools::brain_search,
            tools::brain_page,
            tools::calendar_events,
            tools::calendar_create,
            tools::calendar_update,
            tools::calendar_delete,
            tools::create_teams_meeting,
            tools::web_search,
            tools::fetch_url,
            tools::web_task,
            tools::send_email,
            tools::read_emails,
            tools::read_teams,
            tools::email_details,
            tools::x_bookmarks,
            tools::generate_image,
            tools::post_to_facebook,
            tools::facebook_insights,
            tools::push_chat,
            tools::create_reminder,
            tools::send_teams_message,
            tools::daemon_probe,
            voice::transcribe_audio,
            llm::llm_probe,
            llm::llm_complete,
            llm::cancel_generation,
            history::save_message,
            history::fetch_messages,
            history::fetch_conversations,
            history::list_conversations,
            history::get_conversation,
            history::append_turn,
            history::replace_conversation,
            history::delete_conversation,
            task_board::get_task_board,
            task_board::set_task_board,
            task_board::list_task_boards,
            task_board::clear_task_board,
            tts::tts_speak,
            tts::tts_stop,
            tts::list_voices,
            tts::open_voice_download,
            files::find_files,
            files::read_file,
            files::extract_doc_text,
            files::open_file,
            files::open_app,
            files::list_apps,
            files::run_applescript,
            files::system_control,
            files::send_imessage,
            files::read_imessage,
            files::browser_control,
            shell::run_shell,
            video::watch_video,
            mcp::mcp_list_tools,
            mcp::mcp_call_tool,
            mcp::mcp_probe,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
