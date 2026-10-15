// JLB IDE: the native side. The window's UI (in ../src) calls these commands.
//
// files.rs   reading, writing and listing files
// runner.rs  running programs, syntax checks and Quick-try sessions through jlb
// backups.rs backups of unsaved work, brought back after a crash
// config.rs  settings, the plugins folder, and finding the interpreters
// windows.rs "Edit with JLB IDE" for .jlb files (Windows only)

mod backups;
mod config;
mod files;
mod runner;
mod windows;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(runner::Runs::default())
        .manage(runner::Repl::default())
        .manage(backups::Backups::default())
        .invoke_handler(tauri::generate_handler![
            files::read_text,
            files::write_text,
            files::list_dir,
            files::path_info,
            files::create_dir,
            files::rename_path,
            files::delete_path,
            files::list_files,
            files::read_texts,
            runner::run_program,
            runner::send_input,
            runner::stop_program,
            runner::run_capture,
            runner::check_code,
            runner::repl_eval,
            runner::repl_answer,
            runner::repl_reset,
            backups::backup_write,
            backups::backup_delete,
            backups::backup_heartbeat,
            backups::backup_close,
            backups::backup_leftovers,
            backups::backup_forget,
            config::load_settings,
            config::save_settings,
            config::list_plugins,
            config::plugins_dir,
            config::plugins_stamp,
            config::install_plugin,
            config::find_interpreters,
            config::app_info,
            config::startup_files,
            windows::file_setup_status,
            windows::file_setup,
        ])
        .run(tauri::generate_context!())
        .expect("couldn't start JLB IDE");
}
