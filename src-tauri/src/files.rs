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

#[derive(Serialize)]
pub struct FileItem {
    path: String,
    size: u64,
    modified: u64,
}

#[derive(Serialize)]
pub struct FileList {
    files: Vec<FileItem>,
    /// True when there were more than `limit` files and the rest were left out.
    truncated: bool,
}

/// Folders that hold tools' files rather than the person's own, skipped when listing.
const SKIP_DIRS: &[&str] = &["node_modules", "target", "__pycache__"];

fn millis(m: &std::fs::Metadata) -> u64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Every file under a folder, sorted by path, up to `limit` of them (20,000 if not given).
/// Hidden files and folders, links, and tool folders like node_modules are left out.
#[tauri::command]
pub fn list_files(root: String, limit: Option<usize>) -> Result<FileList, String> {
    let limit = limit.unwrap_or(20_000);
    if !Path::new(&root).is_dir() {
        return Err(format!("{} isn't a folder", root));
    }
    let mut files = Vec::new();
    let mut truncated = false;
    let mut stack = vec![std::path::PathBuf::from(&root)];
    'walk: while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.filter_map(|e| e.ok()) {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push(e.path());
                }
            } else if ft.is_file() {
                if files.len() >= limit {
                    truncated = true;
                    break 'walk;
                }
                let (size, modified) = e.metadata().map(|m| (m.len(), millis(&m))).unwrap_or((0, 0));
                files.push(FileItem { path: e.path().to_string_lossy().into_owned(), size, modified });
            }
        }
    }
    files.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok(FileList { files, truncated })
}

/// Several files' text in one go: null for a file that can't be read, isn't text,
/// or is bigger than `max_bytes` (1 MB if not given).
#[tauri::command]
pub fn read_texts(paths: Vec<String>, max_bytes: Option<u64>) -> Vec<Option<String>> {
    let max = max_bytes.unwrap_or(1 << 20);
    paths
        .iter()
        .map(|p| {
            let m = std::fs::metadata(p).ok()?;
            if !m.is_file() || m.len() > max {
                return None;
            }
            let bytes = std::fs::read(p).ok()?;
            if bytes.contains(&0) {
                return None;
            }
            String::from_utf8(bytes).ok()
        })
        .collect()
}
