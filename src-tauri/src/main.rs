// เลี่ยง console window โผล่บน Windows release build
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(agent::AgentState::default())
        .invoke_handler(tauri::generate_handler![
            agent::run_agent,
            agent::cancel_agent,
            agent::read_file_text,
            agent::write_file_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
