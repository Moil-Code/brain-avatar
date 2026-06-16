mod commands;
mod config;
mod files;
mod history;
mod llm;
mod tools;
mod tts;
mod voice;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // Load persisted settings into managed state.
            let settings: Settings = config::load(&handle);
            app.manage(SettingsState(Mutex::new(settings)));
            app.manage(tts::TtsState(Mutex::new(None)));

            // --- Global summon hotkey: Cmd+Shift+Space ---
            let toggle_shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::Space);
            let shortcut_for_handler = toggle_shortcut;
            handle.plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(move |app, shortcut, event| {
                        if shortcut == &shortcut_for_handler
                            && event.state() == ShortcutState::Pressed
                        {
                            toggle_window(app);
                        }
                    })
                    .build(),
            )?;
            if let Err(e) = app.global_shortcut().register(toggle_shortcut) {
                eprintln!("Could not register global shortcut: {e}");
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
            commands::get_settings,
            commands::set_settings,
            commands::feature_flags,
            tools::brain_search,
            tools::brain_page,
            tools::calendar_events,
            tools::web_search,
            voice::transcribe_audio,
            llm::llm_probe,
            llm::llm_complete,
            history::save_message,
            history::fetch_messages,
            tts::tts_speak,
            tts::tts_stop,
            tts::list_voices,
            files::find_files,
            files::read_file,
            files::open_file,
            files::open_app,
            files::list_apps,
            files::run_applescript,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
