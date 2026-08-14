pub mod desktop;
pub mod library;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = desktop::configure_plugins(tauri::Builder::default());

    builder
        .setup(desktop::setup)
        .on_window_event(desktop::handle_window_event)
        .invoke_handler(tauri::generate_handler![
            desktop::commands::library_snapshot,
            desktop::commands::library_read,
            desktop::commands::library_search,
            desktop::commands::library_mutate,
            desktop::commands::choose_library_root,
            desktop::commands::copy_prompt,
            desktop::commands::open_prompt,
            desktop::commands::reveal_prompt,
            desktop::commands::settings_get,
            desktop::commands::settings_update,
            desktop::commands::show_window,
            desktop::commands::hide_current_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Prompter");
}
