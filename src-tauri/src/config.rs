// Settings, plugins, and finding the interpreters.

use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

/// The settings file's text, or "{}" before anything has been saved.
#[tauri::command]
pub fn load_settings(app: AppHandle) -> Result<String, String> {
    let p = config_dir(&app)?.join("settings.json");
    Ok(std::fs::read_to_string(p).unwrap_or_else(|_| "{}".into()))
}

#[tauri::command]
pub fn save_settings(app: AppHandle, text: String) -> Result<(), String> {
    let p = config_dir(&app)?.join("settings.json");
    std::fs::write(p, text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plugins_dir(app: AppHandle) -> Result<String, String> {
    let d = config_dir(&app)?.join("plugins");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d.to_string_lossy().into_owned())
}

#[derive(Serialize)]
pub struct PluginFiles {
    folder: String,
    manifest: String,
    main: Option<String>,
    style: Option<String>,
    error: Option<String>,
}

/// Every folder in the plugins folder that has a plugin.json.
#[tauri::command]
pub fn list_plugins(app: AppHandle) -> Result<Vec<PluginFiles>, String> {
    let dir = PathBuf::from(plugins_dir(app)?);
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(&dir) else { return Ok(out) };
    let mut folders: Vec<PathBuf> = rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_dir()).collect();
    folders.sort();
    for f in folders {
        let Ok(manifest) = std::fs::read_to_string(f.join("plugin.json")) else { continue };
        let read = |name: &str| std::fs::read_to_string(f.join(name)).ok();
        // The manifest names its files; these are the defaults.
        let parsed: serde_json::Value = serde_json::from_str(&manifest).unwrap_or_default();
        let main_name = parsed.get("main").and_then(|v| v.as_str()).unwrap_or("main.js");
        let style_name = parsed.get("style").and_then(|v| v.as_str()).unwrap_or("style.css");
        let safe = |n: &str| !n.contains("..") && !n.starts_with('/') && !n.starts_with('\\');
        let (main, style, error) = if safe(main_name) && safe(style_name) {
            (read(main_name), read(style_name), None)
        } else {
            (None, None, Some("plugin.json points outside the plugin's folder".to_string()))
        };
        out.push(PluginFiles { folder: f.to_string_lossy().into_owned(), manifest, main, style, error });
    }
    Ok(out)
}

/// A cheap fingerprint of the plugins folder (names, sizes and change times of the
/// files at the top of each plugin), so the IDE can notice edits without reading them.
#[tauri::command]
pub fn plugins_stamp(app: AppHandle) -> Result<String, String> {
    let dir = PathBuf::from(plugins_dir(app)?);
    let mut parts = Vec::new();
    let Ok(rd) = std::fs::read_dir(&dir) else { return Ok(String::new()) };
    for folder in rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_dir()) {
        let Ok(files) = std::fs::read_dir(&folder) else { continue };
        for f in files.filter_map(|e| e.ok()) {
            let Ok(meta) = f.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0);
            parts.push(format!("{}|{}|{}", f.path().to_string_lossy(), meta.len(), modified));
        }
    }
    parts.sort();
    Ok(parts.join("\n"))
}

fn copy_tree(from: &std::path::Path, to: &std::path::Path, depth: u32) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let name = e.file_name();
        let n = name.to_string_lossy();
        // Development leftovers aren't part of the plugin.
        if n == ".git" || n == "node_modules" {
            continue;
        }
        let kind = e.file_type()?;
        if kind.is_dir() {
            if depth < 8 {
                copy_tree(&e.path(), &to.join(&name), depth + 1)?;
            }
        } else if kind.is_file() {
            std::fs::copy(e.path(), to.join(&name))?;
        }
    }
    Ok(())
}

/// Copies a plugin's folder into the plugins folder, named after its id. Gives back
/// where it went. With `replace`, an installed plugin with the same id is replaced.
#[tauri::command]
pub fn install_plugin(app: AppHandle, from: String, replace: bool) -> Result<String, String> {
    let src = PathBuf::from(&from);
    let manifest = std::fs::read_to_string(src.join("plugin.json")).map_err(|_| "that folder has no plugin.json, so it isn't a plugin".to_string())?;
    let parsed: serde_json::Value = serde_json::from_str(&manifest).map_err(|e| format!("plugin.json isn't valid JSON ({})", e))?;
    let id = parsed.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let valid = !id.is_empty() && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') && !id.starts_with('-');
    if !valid {
        return Err(format!("\"{}\" in plugin.json isn't a valid plugin id (use lowercase letters, digits and dashes)", id));
    }
    let dir = PathBuf::from(plugins_dir(app)?);
    let dest = dir.join(id);
    if src.canonicalize().ok() == dest.canonicalize().ok() {
        return Err("that plugin is already in the plugins folder".into());
    }
    if dest.exists() {
        if !replace {
            return Err(format!("already installed: {}", id));
        }
        std::fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
    }
    copy_tree(&src, &dest, 0).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

#[derive(Serialize)]
pub struct Found {
    rust: Option<String>,
    c: Option<String>,
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{}.exe", name)
    } else {
        name.to_string()
    }
}

/// Looks for the interpreters bundled with the IDE or sitting next to it.
#[tauri::command]
pub fn find_interpreters(app: AppHandle) -> Found {
    let mut places: Vec<PathBuf> = Vec::new();
    if let Ok(r) = app.path().resource_dir() {
        places.push(r.join("interpreters"));
        places.push(r);
    }
    if let Some(d) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())) {
        places.push(d.join("interpreters"));
        places.push(d);
    }
    let find = |name: &str| {
        places.iter().map(|p| p.join(exe(name))).find(|p| p.is_file()).map(|p| p.to_string_lossy().into_owned())
    };
    Found { rust: find("jlb"), c: find("jlb-c") }
}

/// Files named when the IDE was started (like `jlb-ide program.jlb`, or opening a
/// .jlb file with JLB IDE from Explorer), as full paths.
#[tauri::command]
pub fn startup_files() -> Vec<String> {
    std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .map(|p| std::fs::canonicalize(&p).unwrap_or(p))
        .map(|p| {
            let s = p.to_string_lossy().into_owned();
            // Windows' canonical form starts with \\?\, which other programs don't expect.
            s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
        })
        .collect()
}

#[derive(Serialize)]
pub struct AppInfo {
    version: String,
    os: String,
    config_dir: String,
    home: String,
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        config_dir: config_dir(&app).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        home: app.path().home_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
    }
}
