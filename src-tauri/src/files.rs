// Files and folders for the explorer and the editor tabs.

use serde::Serialize;
use std::path::Path;

fn msg(e: std::io::Error, what: &str, path: &str) -> String {
    format!("couldn't {} {}: {}", what, path, e)
}

#[tauri::command]
pub fn read_text(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| msg(e, "open", &path))?;
    String::from_utf8(bytes).map_err(|_| format!("{} isn't a text file", path))
}

#[tauri::command]
pub fn write_text(path: String, text: String) -> Result<(), String> {
    // Write to a temporary file first, so a crash mid-save never leaves half a file.
    let p = Path::new(&path);
    let tmp = p.with_extension(format!(
        "{}.jlb-ide-tmp",
        p.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default()
    ));
    std::fs::write(&tmp, text.as_bytes()).map_err(|e| msg(e, "save", &path))?;
    if let Err(e) = std::fs::rename(&tmp, p) {
        let _ = std::fs::remove_file(&tmp);
        return Err(msg(e, "save", &path));
    }
    Ok(())
}

#[derive(Serialize)]
pub struct Entry {
    name: String,
    path: String,
    is_dir: bool,
}

/// A folder's contents: folders first, then files, each sorted by name.
/// Hidden entries (starting with a dot) are left out.
#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    let rd = std::fs::read_dir(&path).map_err(|e| msg(e, "open the folder", &path))?;
    let mut out: Vec<Entry> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                return None;
            }
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            Some(Entry { name, path: e.path().to_string_lossy().into_owned(), is_dir })
        })
        .collect();
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

#[derive(Serialize)]
pub struct Info {
    exists: bool,
    is_dir: bool,
    /// Last change, in milliseconds since 1970 (0 if unknown).
    modified: u64,
}

#[tauri::command]
pub fn path_info(path: String) -> Info {
    match std::fs::metadata(&path) {
        Ok(m) => Info {
            exists: true,
            is_dir: m.is_dir(),
            modified: m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        },
        Err(_) => Info { exists: false, is_dir: false, modified: 0 },
    }
}

#[tauri::command]
pub fn create_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| msg(e, "create", &path))
}

#[tauri::command]
pub fn rename_path(from: String, to: String) -> Result<(), String> {
    if Path::new(&to).exists() {
        return Err(format!("{} already exists", to));
    }
    std::fs::rename(&from, &to).map_err(|e| msg(e, "rename", &from))
}

#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() {
        std::fs::remove_dir_all(p)
    } else {
        std::fs::remove_file(p)
    }
    .map_err(|e| msg(e, "delete", &path))
}
