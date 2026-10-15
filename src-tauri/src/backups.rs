// Backups of unsaved work, so a crash (of the IDE or the computer) loses nothing.
//
// Each running IDE keeps its backups in its own folder, backups/<session>/, one
// <key>.json per unsaved tab, plus an "alive" file it touches every few seconds.
// A folder whose "alive" file has gone stale (the IDE crashed) or that has a
// "closed" file (the IDE closed and kept its unsaved changes) is left over, and
// the next IDE to start brings its tabs back.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

/// An "alive" file older than this means its IDE isn't running any more.
const STALE: Duration = Duration::from_secs(45);

pub struct Backups {
    session: String,
    dir: Mutex<Option<PathBuf>>,
}

impl Default for Backups {
    fn default() -> Self {
        let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        Backups { session: format!("s{}-{}", t, std::process::id()), dir: Mutex::new(None) }
    }
}

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_config_dir().map_err(|e| e.to_string())?.join("backups");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

/// Keys and folder names come from the window, so only plain names are allowed.
fn plain(name: &str) -> Result<&str, String> {
    if !name.is_empty() && name.len() <= 80 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Ok(name)
    } else {
        Err(format!("\"{}\" isn't a valid backup name", name))
    }
}

fn session_dir(app: &AppHandle, b: &Backups) -> Result<PathBuf, String> {
    let mut g = b.dir.lock().unwrap();
    if let Some(d) = &*g {
        return Ok(d.clone());
    }
    let d = root(app)?.join(&b.session);
    *g = Some(d.clone());
    Ok(d)
}

fn touch(dir: &Path) {
    let _ = std::fs::write(dir.join("alive"), b"");
}

/// Saves one tab's backup (JSON from the window), replacing the last one.
#[tauri::command]
pub fn backup_write(app: AppHandle, b: State<Backups>, key: String, data: String) -> Result<(), String> {
    let dir = session_dir(&app, &b)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    touch(&dir);
    let file = dir.join(format!("{}.json", plain(&key)?));
    let tmp = dir.join(format!("{}.tmp", plain(&key)?));
    std::fs::write(&tmp, data.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &file).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Removes one tab's backup (it was saved, or its changes were thrown away).
#[tauri::command]
pub fn backup_delete(app: AppHandle, b: State<Backups>, key: String) -> Result<(), String> {
    let dir = session_dir(&app, &b)?;
    let _ = std::fs::remove_file(dir.join(format!("{}.json", plain(&key)?)));
    remove_if_empty(&dir);
    Ok(())
}

fn remove_if_empty(dir: &Path) {
    let has_backups = std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(|e| e.ok()).any(|e| e.path().extension().is_some_and(|x| x == "json")))
        .unwrap_or(false);
    if !has_backups {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// Tells other IDEs this one is still running (only while it has backups).
#[tauri::command]
pub fn backup_heartbeat(app: AppHandle, b: State<Backups>) -> Result<(), String> {
    let dir = session_dir(&app, &b)?;
    if dir.is_dir() {
        touch(&dir);
    }
    Ok(())
}

/// On closing: keep the backups for next time (`keep`), or remove them.
#[tauri::command]
pub fn backup_close(app: AppHandle, b: State<Backups>, keep: bool) -> Result<(), String> {
    let dir = session_dir(&app, &b)?;
    if !dir.is_dir() {
        return Ok(());
    }
    if keep {
        std::fs::write(dir.join("closed"), b"").map_err(|e| e.to_string())
    } else {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())
    }
}

#[derive(serde::Serialize)]
pub struct LeftOver {
    folder: String,
    items: Vec<String>,
}

/// Backups left by IDEs that crashed or closed with unsaved changes.
#[tauri::command]
pub fn backup_leftovers(app: AppHandle, b: State<Backups>) -> Result<Vec<LeftOver>, String> {
    let root = root(&app)?;
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(&root) else { return Ok(out) };
    for e in rd.filter_map(|e| e.ok()) {
        let dir = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if !dir.is_dir() || name == b.session || plain(&name).is_err() {
            continue;
        }
        let stale = std::fs::metadata(dir.join("alive"))
            .and_then(|m| m.modified())
            .map(|t| t.elapsed().unwrap_or_default() > STALE)
            .unwrap_or(true);
        if !stale && !dir.join("closed").exists() {
            continue; // another IDE that's still running
        }
        let mut items = Vec::new();
        for f in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.filter_map(|e| e.ok()) {
            if f.path().extension().is_some_and(|x| x == "json") {
                if let Ok(text) = std::fs::read_to_string(f.path()) {
                    items.push(text);
                }
            }
        }
        out.push(LeftOver { folder: name, items });
    }
    Ok(out)
}

/// Removes a left-over folder once its tabs are back (and backed up again).
#[tauri::command]
pub fn backup_forget(app: AppHandle, b: State<Backups>, folder: String) -> Result<(), String> {
    if folder == b.session {
        return Ok(());
    }
    let dir = root(&app)?.join(plain(&folder)?);
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}
