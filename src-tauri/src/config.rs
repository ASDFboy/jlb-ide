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
