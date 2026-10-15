// Windows only: right-click "Edit with JLB IDE" for .jlb files. Double-clicking a
// .jlb file keeps running it (jlb-rust's windows\install.bat sets that up; if it
// isn't set up yet, this sets it up with the interpreter bundled with the IDE).
// Everything goes in HKEY_CURRENT_USER, so no admin rights are needed.

#[cfg(windows)]
mod imp {
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::process::Command;

    const CLASSES: &str = r"HKCU\Software\Classes";

    fn reg(args: &[&str]) -> Result<String, String> {
        let out = Command::new("reg").args(args).creation_flags(0x0800_0000).output().map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    }

    fn get(key: &str) -> Option<String> {
        let out = reg(&["query", &format!(r"{}\{}", CLASSES, key), "/ve"]).ok()?;
        // A line like:    (Default)    REG_SZ    value
        out.lines().find(|l| l.contains("REG_SZ")).and_then(|l| l.split("REG_SZ").nth(1)).map(|v| v.trim().to_string())
    }

    fn set(key: &str, value: &str) -> Result<(), String> {
        reg(&["add", &format!(r"{}\{}", CLASSES, key), "/ve", "/d", value, "/f"]).map(|_| ())
    }

    fn refresh() {
        let _ = Command::new("ie4uinit.exe").arg("-show").creation_flags(0x0800_0000).status();
    }

    pub fn status(ide: &str) -> (bool, bool) {
        let edit = get(r"jlb.program\shell\edit\command").map(|v| v.to_lowercase().contains(&ide.to_lowercase())).unwrap_or(false);
        let runs = get(".jlb").as_deref() == Some("jlb.program") && get(r"jlb.program\shell\open\command").is_some();
        (edit, runs)
    }

    pub fn setup(enable: bool, ide: &str, interpreter: Option<PathBuf>) -> Result<String, String> {
        let mut notes = Vec::new();
        if enable {
            let (_, runs) = status(ide);
            if !runs {
                let jlb = interpreter.ok_or("couldn't find the bundled jlb.exe to run programs with")?;
                let jlb = jlb.to_string_lossy();
                set(".jlb", "jlb.program")?;
                set("jlb.program", ".jlb program")?;
                set(r"jlb.program\DefaultIcon", &format!("\"{}\",0", jlb))?;
                set(r"jlb.program\shell\open\command", &format!("\"{}\" \"%1\"", jlb))?;
                notes.push("Double-clicking a .jlb file now runs it.");
            }
            set(r"jlb.program\shell\edit", "Edit with JLB IDE")?;
            set(r"jlb.program\shell\edit\command", &format!("\"{}\" \"%1\"", ide))?;
            notes.push("Right-click a .jlb file and choose Edit with JLB IDE to open it here.");
        } else {
            set(r"jlb.program\shell\edit", "Edit")?;
            set(r"jlb.program\shell\edit\command", "notepad.exe \"%1\"")?;
            notes.push("Edit opens .jlb files in Notepad again.");
        }
        refresh();
        Ok(notes.join(" "))
    }
}

use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
pub struct FileSetup {
    supported: bool,
    edit_with_ide: bool,
    double_click_runs: bool,
}

#[allow(unused_variables)]
#[tauri::command]
pub fn file_setup_status(app: AppHandle) -> FileSetup {
    #[cfg(windows)]
    {
        let ide = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        let (edit_with_ide, double_click_runs) = imp::status(&ide);
        FileSetup { supported: true, edit_with_ide, double_click_runs }
    }
    #[cfg(not(windows))]
    FileSetup { supported: false, edit_with_ide: false, double_click_runs: false }
}

#[allow(unused_variables)]
#[tauri::command]
pub fn file_setup(app: AppHandle, enable: bool) -> Result<String, String> {
    #[cfg(windows)]
    {
        let ide = std::env::current_exe().map_err(|e| e.to_string())?.to_string_lossy().into_owned();
        let mut places = Vec::new();
        if let Ok(r) = app.path().resource_dir() {
            places.push(r.join("interpreters").join("jlb.exe"));
        }
        if let Some(d) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())) {
            places.push(d.join("interpreters").join("jlb.exe"));
            places.push(d.join("jlb.exe"));
        }
        imp::setup(enable, &ide, places.into_iter().find(|p| p.is_file()))
    }
    #[cfg(not(windows))]
    {
        let _ = app.path();
        Err("this is only available on Windows".into())
    }
}
