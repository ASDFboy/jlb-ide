// JLB IDE: the native side. The window's UI (in ../src) calls these commands.
//
// files.rs   reading, writing and listing files
// runner.rs  running programs, syntax checks and Quick-try sessions through jlb
// config.rs  settings, the plugins folder, and finding the interpreters
// windows.rs "Edit with JLB IDE" for .jlb files (Windows only)

mod config;
mod files;
mod runner;
mod windows;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(runner::Runs::default())
        .manage(runner::Repl::default())
        .invoke_handler(tauri::generate_handler![
            files::read_text,
            files::write_text,
            files::list_dir,
            files::path_info,
            files::create_dir,
            files::rename_path,
            files::delete_path,
            runner::run_program,
            runner::send_input,
            runner::stop_program,
            runner::check_code,
            runner::repl_eval,
            runner::repl_reset,
            config::load_settings,
            config::save_settings,
            config::list_plugins,
            config::plugins_dir,
            config::find_interpreters,
            config::app_info,
            config::startup_files,
            windows::file_setup_status,
            windows::file_setup,
        ])
        .run(tauri::generate_context!())
        .expect("couldn't start JLB IDE");
}
