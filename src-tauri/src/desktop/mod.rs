//! Rust-owned desktop seam.
//!
//! The webview can request domain operations by opaque IDs but never receives
//! arbitrary filesystem, shell, clipboard-read, or autostart capabilities.

pub(crate) mod commands;
mod error;
mod lifecycle;
mod projection;
mod settings;
mod state;
mod tray;
mod windows;

pub use commands::{
    choose_library_root, copy_prompt, hide_current_window, library_mutate, library_read,
    library_search, library_snapshot, open_prompt, reveal_prompt, settings_get, settings_update,
    show_window,
};
pub use lifecycle::{handle_second_instance, handle_window_event, lifecycle_plugin, setup};
pub use state::shortcut_handler;

/// Registers plugins that have Rust-owned system behavior. Single-instance is
/// intentionally first because the plugin requires first-registration order.
pub fn configure_plugins<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .plugin(tauri_plugin_single_instance::init(handle_second_instance))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .arg("--background")
                .build(),
        )
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(shortcut_handler)
                .build(),
        )
        .plugin(lifecycle_plugin())
}

/// Exact list for `tauri::generate_handler![...]` at the crate root. Keeping
/// this comment beside the module is the desktop/root wiring contract:
///
/// ```text
/// desktop::library_snapshot, desktop::library_read, desktop::library_search,
/// desktop::library_mutate, desktop::choose_library_root, desktop::copy_prompt,
/// desktop::open_prompt, desktop::reveal_prompt, desktop::settings_get,
/// desktop::settings_update, desktop::show_window, desktop::hide_current_window
/// ```
pub const COMMAND_NAMES: &[&str] = &[
    "library_snapshot",
    "library_read",
    "library_search",
    "library_mutate",
    "choose_library_root",
    "copy_prompt",
    "open_prompt",
    "reveal_prompt",
    "settings_get",
    "settings_update",
    "show_window",
    "hide_current_window",
];
