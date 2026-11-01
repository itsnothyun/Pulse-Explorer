// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{ipc::Response, AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindowBuilder};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWithFilePayload {
    pub path: String,
    pub filename: String,
    pub extension: String,
    pub size_bytes: u64,
}

#[derive(Default)]
pub struct PendingStartupFiles(pub Mutex<Vec<OpenWithFilePayload>>);

fn inspect_cli_file_arg(raw_arg: &str) -> Option<OpenWithFilePayload> {
    if raw_arg.starts_with('-') {
        return None;
    }
    let path_buf = PathBuf::from(raw_arg);
    if !path_buf.exists() || !path_buf.is_file() {
        return None;
    }
    let canonical = path_buf.canonicalize().unwrap_or(path_buf);
    let metadata = std::fs::metadata(&canonical).ok()?;
    let filename = canonical
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unnamed-file")
        .to_string();
    let extension = canonical
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    Some(OpenWithFilePayload {
        path: canonical.to_string_lossy().to_string(),
        filename,
        extension,
        size_bytes: metadata.len(),
    })
}

#[tauri::command]
fn consume_startup_open_with_files(
    state: State<'_, PendingStartupFiles>,
) -> Vec<OpenWithFilePayload> {
    let mut guard = state.0.lock().expect("PendingStartupFiles mutex poisoned");
    std::mem::take(&mut *guard)
}

/// Returns raw bytes (an ArrayBuffer on the JS side) instead of a JSON number array.
#[tauri::command]
fn read_local_file_bytes(path: String) -> Result<Response, String> {
    let candidate = PathBuf::from(&path);
    if !candidate.exists() || !candidate.is_file() {
        return Err(format!("Requested file does not exist: {}", path));
    }
    std::fs::read(&candidate)
        .map(Response::new)
        .map_err(|err| format!("Failed to read file {}: {}", path, err))
}

/// File types Pulse can open; Explorer history is filtered to these.
const SUPPORTED_EXTENSIONS: &[&str] = &[
    "pdf", "docx", "doc", "odt", "rtf", "pptx", "ppt", "odp", "xlsx", "xls", "ods", "csv", "tsv",
    "epub", "fb2", "png", "jpg", "jpeg", "webp", "gif", "bmp", "ico", "svg", "md", "json", "yaml",
    "yml", "toml", "xml", "log", "ini", "txt", "ts", "js", "py", "go", "rs", "html", "css", "sql",
    "sh", "mp4", "webm", "mp3", "wav", "flac", "ogg", "aac", "zip", "tar", "gz", "tgz",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentSystemFile {
    pub path: String,
    pub filename: String,
    pub extension: String,
    pub folder: String,
    pub size_bytes: u64,
    /// When the file was last opened from Explorer (the shortcut's write time), ms since epoch.
    pub opened_at: u64,
    /// The file's own last-modified time, ms since epoch.
    pub modified_at: u64,
}

fn millis(t: std::io::Result<std::time::SystemTime>) -> u64 {
    t.ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Resolves a .lnk shortcut to its target. The parser can panic on unusual
/// shortcuts, so each one is isolated and simply skipped on failure.
fn resolve_shortcut(lnk_path: &std::path::Path) -> Option<PathBuf> {
    let owned = lnk_path.to_path_buf();
    std::panic::catch_unwind(move || {
        lnk::ShellLink::open(&owned, lnk::encoding::WINDOWS_1252)
            .ok()
            .and_then(|link| link.link_target())
            .map(PathBuf::from)
    })
    .ok()
    .flatten()
}

/// Files recently opened in Windows (File Explorer's Recent list), newest first,
/// limited to types Pulse can view and to files that still exist.
#[tauri::command]
async fn list_recent_system_files(limit: Option<usize>) -> Result<Vec<RecentSystemFile>, String> {
    let limit = limit.unwrap_or(60).min(200);
    tauri::async_runtime::spawn_blocking(move || collect_recent_system_files(limit))
        .await
        .map_err(|e| e.to_string())
}

fn collect_recent_system_files(limit: usize) -> Vec<RecentSystemFile> {
    {
        let Some(appdata) = std::env::var_os("APPDATA") else {
            return Vec::new();
        };
        let recent_dir = PathBuf::from(appdata).join("Microsoft").join("Windows").join("Recent");
        let Ok(entries) = std::fs::read_dir(&recent_dir) else {
            return Vec::new();
        };

        let mut shortcuts: Vec<(PathBuf, u64)> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().map(|x| x.eq_ignore_ascii_case("lnk")).unwrap_or(false))
            .map(|p| {
                let opened = millis(std::fs::metadata(&p).and_then(|m| m.modified()));
                (p, opened)
            })
            .collect();
        shortcuts.sort_by(|a, b| b.1.cmp(&a.1));

        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        for (lnk_path, opened_at) in shortcuts {
            if out.len() >= limit {
                break;
            }
            let Some(target) = resolve_shortcut(&lnk_path) else { continue };
            let extension = target
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            if !SUPPORTED_EXTENSIONS.contains(&extension.as_str()) {
                continue;
            }
            let Ok(meta) = std::fs::metadata(&target) else { continue };
            if !meta.is_file() || !seen.insert(target.to_string_lossy().to_lowercase()) {
                continue;
            }
            out.push(RecentSystemFile {
                filename: target
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("file")
                    .to_string(),
                folder: target
                    .parent()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default(),
                path: target.to_string_lossy().to_string(),
                extension,
                size_bytes: meta.len(),
                opened_at,
                modified_at: millis(meta.modified()),
            });
        }
        out
    }
}

/// Folders scanned for "recently modified" files of a type.
fn user_scan_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
        for name in ["Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music"] {
            roots.push(home.join(name));
        }
    }
    for var in ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"] {
        if let Some(p) = std::env::var_os(var).map(PathBuf::from) {
            for name in ["Desktop", "Documents", "Pictures"] {
                roots.push(p.join(name));
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    roots
        .into_iter()
        .filter(|p| p.is_dir())
        .filter(|p| seen.insert(p.to_string_lossy().to_lowercase()))
        .collect()
}

const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "appdata", "$recycle.bin", "vendor", "target", "dist", "build",
    ".cache", ".venv", "venv", "__pycache__", ".next", ".turbo", "my games",
];

/// Most recently modified files with the given extensions under the user's
/// folders. Breadth-first, depth-limited and capped so it stays fast.
fn collect_recent_files_by_type(extensions: &[String], limit: usize) -> Vec<RecentSystemFile> {
    const MAX_DEPTH: usize = 5;
    const MAX_ENTRIES: usize = 60_000;
    let wanted: std::collections::HashSet<String> = extensions.iter().map(|e| e.to_lowercase()).collect();
    let mut found: Vec<RecentSystemFile> = Vec::new();
    let mut queue: std::collections::VecDeque<(PathBuf, usize)> =
        user_scan_roots().into_iter().map(|p| (p, 0)).collect();
    let mut visited = 0usize;

    while let Some((dir, depth)) = queue.pop_front() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            visited += 1;
            if visited > MAX_ENTRIES {
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name.starts_with('~') {
                continue;
            }
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            let path = entry.path();
            if ft.is_dir() {
                if depth < MAX_DEPTH && !SKIP_DIRS.contains(&name.to_lowercase().as_str()) {
                    queue.push_back((path, depth + 1));
                }
                continue;
            }
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            if !wanted.contains(&ext) {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            found.push(RecentSystemFile {
                filename: name,
                folder: dir.to_string_lossy().to_string(),
                path: path.to_string_lossy().to_string(),
                extension: ext,
                size_bytes: meta.len(),
                opened_at: millis(meta.accessed()),
                modified_at: millis(meta.modified()),
            });
        }
        if visited > MAX_ENTRIES {
            break;
        }
    }
    found.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    found.truncate(limit);
    found
}

#[tauri::command]
async fn list_recent_files_by_type(extensions: Vec<String>, limit: Option<usize>) -> Result<Vec<RecentSystemFile>, String> {
    let limit = limit.unwrap_or(60).min(300);
    let extensions: Vec<String> = extensions
        .into_iter()
        .map(|e| e.to_lowercase())
        .filter(|e| SUPPORTED_EXTENSIONS.contains(&e.as_str()))
        .collect();
    if extensions.is_empty() {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || collect_recent_files_by_type(&extensions, limit))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn lists_recent_pdfs_by_type() {
        let start = std::time::Instant::now();
        let files = super::collect_recent_files_by_type(&["pdf".to_string()], 8);
        for f in &files {
            println!("{} | modified {} | {}", f.filename, f.modified_at, f.folder);
        }
        println!("pdf total: {} in {:?}", files.len(), start.elapsed());
        assert!(files.windows(2).all(|w| w[0].modified_at >= w[1].modified_at));
    }

    #[test]
    fn lists_recent_explorer_files() {
        let files = super::collect_recent_system_files(15);
        for f in &files {
            println!("{} | opened {} | modified {} | {}", f.filename, f.opened_at, f.modified_at, f.folder);
        }
        println!("total: {}", files.len());
        assert!(files.windows(2).all(|w| w[0].opened_at >= w[1].opened_at));
    }
}

/// Windows does not let apps set themselves as default; open the Settings page instead.
#[tauri::command]
fn open_default_apps_settings() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg("ms-settings:defaultapps")
            .spawn()
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn existing_file(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if p.is_file() {
        Ok(p)
    } else {
        Err(format!("{path} no longer exists"))
    }
}

/// Opens File Explorer with the file selected.
#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    let p = existing_file(&path)?;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // explorer wants `/select,"path"` as one raw argument.
        std::process::Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{}\"", p.display()))
            .spawn()
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

/// Shows the Windows "Open with" chooser, since Pulse is usually the default app.
#[tauri::command]
fn open_with_other_app(path: String) -> Result<(), String> {
    let p = existing_file(&path)?;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("rundll32.exe")
            .raw_arg(format!("shell32.dll,OpenAs_RunDLL {}", p.display()))
            .spawn()
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn emit_open_with_events(app: &AppHandle, payloads: &[OpenWithFilePayload]) {
    if payloads.is_empty() {
        return;
    }
    let _ = app.emit("omniview://open-with-files", payloads);
}

// ---------------------------------------------------------------- Quick View window
// Files opened from File Explorer float in a small transparent window placed
// over the Explorer window they came from, instead of raising the full app.

const QUICKVIEW: &str = "quickview";

#[derive(Default)]
pub struct QuickViewQueue(pub Mutex<Vec<OpenWithFilePayload>>);

pub struct ExplorerOpenMode(pub Mutex<String>);

fn mode_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("explorer-open-mode.txt"))
}

fn read_explorer_mode(app: &AppHandle) -> String {
    mode_file(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| s == "quick-view" || s == "tab")
        .unwrap_or_else(|| "quick-view".to_string())
}

/// The frontend mirrors its "Opening from File Explorer" setting here so a cold
/// start (before any web page has loaded) already knows where files should go.
#[tauri::command]
fn set_explorer_open_mode(app: AppHandle, state: State<'_, ExplorerOpenMode>, mode: String) -> Result<(), String> {
    if mode != "quick-view" && mode != "tab" {
        return Err(format!("unknown mode {mode}"));
    }
    if let Some(path) = mode_file(&app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        std::fs::write(path, &mode).map_err(|e| e.to_string())?;
    }
    *state.0.lock().expect("mode mutex poisoned") = mode;
    Ok(())
}

/// Screen rect (physical px) of the window the user was just in, normally the
/// Explorer window they double-clicked from. Falls back to the cursor position.
#[cfg(windows)]
fn anchor_rect() -> (i32, i32, i32, i32) {
    use windows::Win32::Foundation::{POINT, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId};
    unsafe {
        let hwnd = GetForegroundWindow();
        if !hwnd.is_invalid() {
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let mut r = RECT::default();
            if pid != std::process::id() && GetWindowRect(hwnd, &mut r).is_ok() && r.right - r.left > 200 {
                return (r.left, r.top, r.right - r.left, r.bottom - r.top);
            }
        }
        let mut p = POINT::default();
        let _ = GetCursorPos(&mut p);
        (p.x - 1, p.y - 1, 2, 2)
    }
}

#[cfg(not(windows))]
fn anchor_rect() -> (i32, i32, i32, i32) {
    (0, 0, 1280, 800)
}

/// Sizes the Quick View window to the anchor and centres it over it, clamped to
/// the work area of the monitor the anchor is on.
fn place_quickview(app: &AppHandle, win: &tauri::WebviewWindow) {
    let (ax, ay, aw, ah) = anchor_rect();
    let (cx, cy) = (ax + aw / 2, ay + ah / 2);
    let monitors = app.available_monitors().unwrap_or_default();
    let monitor = monitors
        .iter()
        .find(|m| {
            let a = m.work_area();
            cx >= a.position.x
                && cx < a.position.x + a.size.width as i32
                && cy >= a.position.y
                && cy < a.position.y + a.size.height as i32
        })
        .or(monitors.first())
        .cloned();
    let Some(monitor) = monitor else { return };
    let area = monitor.work_area().clone();
    let scale = monitor.scale_factor();
    let px = |logical: f64| (logical * scale).round() as i32;

    let max_w = area.size.width as i32 - px(24.0);
    let max_h = area.size.height as i32 - px(24.0);
    let base_w = if aw > 400 { (aw as f64 * 0.94) as i32 } else { px(1100.0) };
    let base_h = if ah > 300 { (ah as f64 * 0.94) as i32 } else { px(780.0) };
    let w = base_w.clamp(px(720.0), px(1240.0)).min(max_w);
    let h = base_h.clamp(px(520.0), px(900.0)).min(max_h);
    let min_x = area.position.x + px(12.0);
    let min_y = area.position.y + px(12.0);
    let x = (cx - w / 2).clamp(min_x, (area.position.x + area.size.width as i32 - w - px(12.0)).max(min_x));
    let y = (cy - h / 2).clamp(min_y, (area.position.y + area.size.height as i32 - h - px(12.0)).max(min_y));
    let _ = win.set_size(PhysicalSize::new(w as u32, h as u32));
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

fn show_quickview(app: &AppHandle, files: Vec<OpenWithFilePayload>) {
    if files.is_empty() {
        return;
    }
    if let Some(win) = app.get_webview_window(QUICKVIEW) {
        place_quickview(app, &win);
        let _ = win.emit_to(QUICKVIEW, "pulse://quickview-files", &files);
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    if let Some(queue) = app.try_state::<QuickViewQueue>() {
        *queue.0.lock().expect("queue mutex poisoned") = files;
    }
    let built = WebviewWindowBuilder::new(app, QUICKVIEW, WebviewUrl::App("index.html".into()))
        .title("Pulse Explorer Quick View")
        .decorations(false)
        // Opaque with the native DWM shadow: Windows draws the shadow outside the
        // window (never clipped), rounds the corners and provides resize edges.
        .shadow(true)
        .background_color(tauri::window::Color(9, 9, 9, 255))
        .resizable(true)
        .visible(false)
        .min_inner_size(560.0, 420.0)
        .build();
    if let Ok(win) = built {
        place_quickview(app, &win);
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Files waiting for a freshly created Quick View window.
#[tauri::command]
fn consume_quickview_files(state: State<'_, QuickViewQueue>) -> Vec<OpenWithFilePayload> {
    std::mem::take(&mut *state.0.lock().expect("queue mutex poisoned"))
}

/// Esc / close in Quick View. If the workspace was never shown, Pulse exits so
/// it doesn't linger invisibly in the background.
#[tauri::command]
fn close_quickview(app: AppHandle) {
    let main_visible = app
        .get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    if !main_visible {
        app.exit(0);
        return;
    }
    if let Some(win) = app.get_webview_window(QUICKVIEW) {
        let _ = win.hide();
    }
}

/// "Open in workspace": reveal the full app with the files as tabs.
#[tauri::command]
fn open_in_workspace(app: AppHandle, paths: Vec<String>) {
    let payloads: Vec<OpenWithFilePayload> = paths.iter().filter_map(|p| inspect_cli_file_arg(p)).collect();
    show_main(&app);
    let _ = app.emit_to("main", "pulse://open-in-tab", &payloads);
    if let Some(win) = app.get_webview_window(QUICKVIEW) {
        let _ = win.hide();
    }
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn main() {
    let startup_files: Vec<OpenWithFilePayload> = std::env::args()
        .skip(1)
        .filter_map(|arg| inspect_cli_file_arg(&arg))
        .collect();

    tauri::Builder::default()
        // Must be registered first: a second launch ("Open with" while running)
        // forwards its file arguments here and exits.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let payloads: Vec<OpenWithFilePayload> = argv
                .iter()
                .skip(1)
                .filter_map(|arg| inspect_cli_file_arg(arg))
                .collect();
            if payloads.is_empty() {
                show_main(app);
                return;
            }
            let mode = app
                .try_state::<ExplorerOpenMode>()
                .map(|m| m.0.lock().expect("mode mutex poisoned").clone())
                .unwrap_or_else(|| "quick-view".to_string());
            if mode == "quick-view" {
                show_quickview(app, payloads);
            } else {
                emit_open_with_events(app, &payloads);
                show_main(app);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_filename("omniview-window-state.json")
                // The frame is drawn by the web UI; never restore a saved native title bar.
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::DECORATIONS
                        & !tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                // Quick View is positioned over Explorer each time; never restore it.
                .with_denylist(&[QUICKVIEW])
                .build(),
        )
        .manage(QuickViewQueue::default())
        .invoke_handler(tauri::generate_handler![
            consume_startup_open_with_files,
            read_local_file_bytes,
            open_default_apps_settings,
            list_recent_system_files,
            list_recent_files_by_type,
            set_explorer_open_mode,
            consume_quickview_files,
            close_quickview,
            open_in_workspace,
            reveal_in_explorer,
            open_with_other_app
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let mode = read_explorer_mode(&handle);
            let quick = !startup_files.is_empty() && mode == "quick-view";
            app.manage(ExplorerOpenMode(Mutex::new(mode)));
            // Workspace files are drained by the main page; Quick View files go to their own window.
            app.manage(PendingStartupFiles(Mutex::new(if quick { Vec::new() } else { startup_files.clone() })));

            if let Some(main_window) = app.get_webview_window("main") {
                let _ = main_window.set_decorations(false);
                if !quick {
                    let _ = main_window.show();
                }
            }
            if quick {
                show_quickview(&handle, startup_files.clone());
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Pulse Explorer");
}
