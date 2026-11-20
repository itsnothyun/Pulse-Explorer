// No console window, in dev builds too: the file manager starts this executable to view a file,
// and a console build would open a terminal next to Quick View. DO NOT REMOVE!!
#![windows_subsystem = "windows"]

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
    // (canonicalize gives `\\?\C:\...` on Windows: shown to people, the plain form reads better and works the same)
    let canonical = path_buf.canonicalize().unwrap_or(path_buf);
    let canonical = match canonical.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
        Some(plain) if !plain.starts_with(r"UNC\") => PathBuf::from(plain),
        _ => canonical,
    };
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

/// A name for a new file next to another: one plain file name, nothing that could reach another folder.
fn validate_save_name(name: &str) -> Result<(), String> {
    let bad = name.is_empty()
        || name.len() > 255
        || name == "."
        || name.contains("..")
        || name.chars().any(|c| matches!(c, '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*') || c.is_control())
        || name.trim() != name
        || name.ends_with('.');
    if bad {
        Err(format!("Not a valid file name: {name}"))
    } else {
        Ok(())
    }
}

/// The n-th name tried for `name`: `a.png`, then `a 2.png`, `a 3.png`… (the number goes before the extension).
fn numbered_name(name: &str, n: u32) -> String {
    if n <= 1 {
        return name.to_string();
    }
    match name.rfind('.') {
        Some(i) if i > 0 => format!("{} {n}{}", &name[..i], &name[i..]),
        _ => format!("{name} {n}"),
    }
}

/// `%XX` decoding for the header values `save_next_to` takes (headers are ASCII; paths are not).
fn percent_decode(s: &str) -> Result<String, String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3).ok_or("Bad percent-encoding")?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| "Bad percent-encoding")?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "Header is not UTF-8".to_string())
}

/// Writes `bytes` as a new file named `name` in `source`'s own folder. Never overwrites: if the name is taken it
/// tries `name 2`, `name 3`… (create_new, so a file appearing meanwhile is not clobbered). Returns the final path.
fn write_next_to(source: &std::path::Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    use std::io::Write;
    validate_save_name(name)?;
    if !source.is_file() {
        return Err(format!("{} no longer exists", source.display()));
    }
    let folder = source.parent().ok_or("The file has no folder")?;
    for n in 1..=9999 {
        let target = folder.join(numbered_name(name, n));
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&target) {
            Ok(mut f) => {
                if let Err(err) = f.write_all(bytes).and_then(|_| f.sync_all()) {
                    drop(f);
                    let _ = std::fs::remove_file(&target);
                    return Err(format!("Could not write {}: {err}", target.display()));
                }
                return Ok(target);
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(format!("Could not create {}: {err}", target.display())),
        }
    }
    Err(format!("No free name for {name}"))
}

/// Saves bytes from the web side (a frame or a clip from the player) next to the file they came from. The bytes are
/// the raw IPC body (no JSON number array); the source path and the name come as percent-encoded headers
/// `x-source` and `x-name`. Returns the path written.
#[tauri::command]
fn save_next_to(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let header = |key: &str| -> Result<String, String> {
        let raw = request.headers().get(key).ok_or(format!("Missing {key}"))?;
        percent_decode(raw.to_str().map_err(|_| format!("Bad {key}"))?)
    };
    let source = header("x-source")?;
    let name = header("x-name")?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw bytes".into());
    };
    write_next_to(std::path::Path::new(&source), &name, bytes).map(|p| p.to_string_lossy().to_string())
}

#[cfg(test)]
mod save_next_to_tests {
    use super::*;

    #[test]
    fn rejects_names_that_leave_the_folder() {
        for bad in ["", ".", "..", "../x.png", "a/b.png", "a\\b.png", "x..png", "C:x.png", "a\0.png", " a.png", "a.png ", "a."] {
            assert!(validate_save_name(bad).is_err(), "{bad:?} should be rejected");
        }
        for good in ["clip frame 0m12s.png", "My video clip 0m10s-0m25s.mp4", "été.gif"] {
            assert!(validate_save_name(good).is_ok(), "{good:?} should be accepted");
        }
    }

    #[test]
    fn numbers_go_before_the_extension() {
        assert_eq!(numbered_name("a.png", 1), "a.png");
        assert_eq!(numbered_name("a.png", 2), "a 2.png");
        assert_eq!(numbered_name("a b.c.mp4", 3), "a b.c 3.mp4");
        assert_eq!(numbered_name("noext", 2), "noext 2");
        assert_eq!(numbered_name(".hidden", 2), ".hidden 2");
    }

    #[test]
    fn decodes_percent_headers() {
        assert_eq!(percent_decode("%2FUsers%2Fme%2F%C3%A9t%C3%A9%20x.mp4").unwrap(), "/Users/me/été x.mp4");
        assert!(percent_decode("%zz").is_err());
        assert!(percent_decode("%2").is_err());
    }

    #[test]
    fn writes_next_to_the_source_without_overwriting() {
        let dir = std::env::temp_dir().join(format!("pulse-save-next-to-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("movie.mp4");
        std::fs::write(&source, b"src").unwrap();

        let first = write_next_to(&source, "movie frame 0m12s.png", b"one").unwrap();
        let second = write_next_to(&source, "movie frame 0m12s.png", b"two").unwrap();
        let third = write_next_to(&source, "movie frame 0m12s.png", b"three").unwrap();
        assert_eq!(first, dir.join("movie frame 0m12s.png"));
        assert_eq!(second, dir.join("movie frame 0m12s 2.png"));
        assert_eq!(third, dir.join("movie frame 0m12s 3.png"));
        assert_eq!(std::fs::read(&first).unwrap(), b"one");
        assert_eq!(std::fs::read(&second).unwrap(), b"two");

        assert!(write_next_to(&source, "../escape.png", b"x").is_err());
        assert!(write_next_to(&dir.join("gone.mp4"), "a.png", b"x").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
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
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open")
            .arg("-R")
            .arg(&p)
            .spawn()
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

/// The bundled file manager (apps/files, rustyfiles in Pulse colours). Installed next to the app as a resource;
/// a dev build falls back to the release build in the workspace (`pnpm files:build`, `pnpm files:build:mac`).
/// On macOS it is the native Mac file manager (apps/files/macos), staged as "Pulse Explorer.app" inside ours.
#[cfg(not(target_os = "macos"))]
const FILE_MANAGER: (&str, &str) = ("rustyfiles.exe", "../../files/target/release/rustyfiles.exe");
#[cfg(target_os = "macos")]
const FILE_MANAGER: (&str, &str) = ("Pulse Explorer.app", "../../files/macos/build/Pulse Explorer.app");

fn file_manager_exe(app: &AppHandle) -> Result<PathBuf, String> {
    let bundled = app
        .path()
        .resource_dir()
        .map(|d| d.join("files").join(FILE_MANAGER.0))
        .ok();
    let dev = cfg!(debug_assertions).then(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(FILE_MANAGER.1));
    bundled
        .into_iter()
        .chain(dev)
        .find(|p| p.exists())
        .ok_or_else(|| "The file manager is not installed (build it with `pnpm files:build`)".to_string())
}

/// What the file manager opens Pulse's file types with (rf-win `openrules`, the Mac app's OpenRules): this executable
/// on Windows, our app bundle on macOS (where apps are opened as bundles).
fn pulse_viewer_path() -> Option<PathBuf> {
    let me = std::env::current_exe().ok()?;
    #[cfg(target_os = "macos")]
    {
        // <bundle>.app/Contents/MacOS/PulseExplorer
        let bundle = me.parent()?.parent()?.parent()?;
        if bundle.extension().is_some_and(|e| e == "app") {
            return Some(bundle.to_path_buf());
        }
    }
    Some(me)
}

/// Starts the file manager at a folder, or at the folder holding a file; with no path, at its home page.
/// `PULSE_VIEWER` tells it to open files Pulse can view with this executable (rf-win `openrules`).
#[cfg(not(target_os = "macos"))]
fn spawn_file_manager(app: &AppHandle, path: Option<PathBuf>) -> Result<std::process::Child, String> {
    let exe = file_manager_exe(app)?;
    let mut cmd = std::process::Command::new(&exe);
    if let Some(me) = pulse_viewer_path() {
        cmd.env("PULSE_VIEWER", me);
    }
    if let Some(d) = folder_of(path) {
        cmd.arg(d);
    }
    cmd.spawn().map_err(|err| err.to_string())
}

/// macOS: through LaunchServices (`open`), so a running file manager gets the folder in a new tab or window instead
/// of a second copy starting. `-W` makes the child live as long as the file manager does.
#[cfg(target_os = "macos")]
fn spawn_file_manager(app: &AppHandle, path: Option<PathBuf>) -> Result<std::process::Child, String> {
    let bundle = file_manager_exe(app)?;
    let mut cmd = std::process::Command::new("/usr/bin/open");
    cmd.arg("-W");
    if let Some(me) = pulse_viewer_path() {
        cmd.arg("--env").arg(format!("PULSE_VIEWER={}", me.display()));
    }
    cmd.arg("-a").arg(&bundle);
    if let Some(d) = folder_of(path) {
        cmd.arg(d);
    }
    cmd.spawn().map_err(|err| err.to_string())
}

fn folder_of(path: Option<PathBuf>) -> Option<PathBuf> {
    let p = path?;
    let dir = if p.is_file() { p.parent().map(PathBuf::from) } else { Some(p) };
    dir.filter(|d| d.is_dir())
}

#[tauri::command]
fn open_file_manager(app: AppHandle, path: Option<String>) -> Result<(), String> {
    spawn_file_manager(&app, path.map(PathBuf::from)).map(|_| ())
}

/// Managed when this process started the file manager and waits behind it as its viewer.
struct BehindFileManager;

/// A start with no files opens the file manager: Pulse Explorer is the file manager (apps/files), and this
/// process stays in the background as its viewer (Quick View). Released builds quit once the file manager
/// closes and Quick View is not showing; a dev build keeps running so the dev server stays up.
fn start_as_file_manager(app: &AppHandle) {
    let mut child = match spawn_file_manager(app, None) {
        Ok(c) => c,
        Err(err) => {
            eprintln!("file manager: {err}");
            app.exit(1);
            return;
        }
    };
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let _ = child.wait();
        let showing = app.get_webview_window(QUICKVIEW).is_some_and(|w| w.is_visible().unwrap_or(false));
        if !showing {
            app.exit(0);
        }
    });
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
    // macOS has no "Open with" chooser to show: the file goes to the app Finder opens it with.
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open").arg(&p).spawn().map_err(|err| err.to_string())?;
    }
    Ok(())
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
fn anchor_rect(_app: &AppHandle) -> (i32, i32, i32, i32) {
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

/// Elsewhere: the cursor, which is over the file manager the file was opened from.
#[cfg(not(windows))]
fn anchor_rect(app: &AppHandle) -> (i32, i32, i32, i32) {
    match app.cursor_position() {
        Ok(p) => (p.x as i32 - 1, p.y as i32 - 1, 2, 2),
        Err(_) => (0, 0, 1280, 800),
    }
}

/// Sizes the Quick View window to the anchor and centres it over it, clamped to
/// the work area of the monitor the anchor is on.
fn place_quickview(app: &AppHandle, win: &tauri::WebviewWindow) {
    // macOS: screens of different scales share one coordinate space in points, which physical pixels do not map onto;
    // size in points and let AppKit centre it on the screen in use (the file manager's).
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        let (mut w, mut h) = (1100.0_f64, 780.0_f64);
        if let Ok(Some(m)) = win.current_monitor() {
            let s = m.scale_factor();
            w = w.min(m.work_area().size.width as f64 / s - 48.0);
            h = h.min(m.work_area().size.height as f64 / s - 48.0);
        }
        let _ = win.set_size(tauri::LogicalSize::new(w.max(560.0), h.max(420.0)));
        let _ = win.center();
        return;
    }
    #[allow(unreachable_code)]
    let (ax, ay, aw, ah) = anchor_rect(app);
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
    if let Some(shown) = app.try_state::<QuickViewShown>() {
        shown.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
    // macOS: this process runs in the background (no Dock icon); come forward, over the file manager.
    #[cfg(target_os = "macos")]
    let _ = app.show();
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
    let builder = WebviewWindowBuilder::new(app, QUICKVIEW, WebviewUrl::App("index.html".into()))
        .title("Pulse Explorer Quick View");
    // macOS: a real window frame under a see-through title bar, so the corners, shadow and traffic lights are the
    // system's, the same as the file manager's (the page leaves room for the lights: html.qv-mac in index.css).
    #[cfg(target_os = "macos")]
    let builder = builder.decorations(true).title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false);
    let built = builder
        // The native DWM shadow: Windows draws the shadow outside the window (never
        // clipped), rounds the corners and provides resize edges.
        .shadow(true)
        // Liquid glass, like the file manager: a see-through page over Windows'
        // acrylic blur, dark so the frost stays monochrome. The page lays a
        // grey wash of its own on top (html.qv-window in index.css).
        .transparent(true)
        .background_color(tauri::window::Color(9, 9, 9, 0))
        .theme(Some(tauri::Theme::Dark))
        .effects(quickview_effects())
        .resizable(true)
        .visible(false)
        .min_inner_size(560.0, 420.0)
        .build();
    match built {
        Ok(win) => {
            place_quickview(app, &win);
            let _ = win.show();
            let _ = win.set_focus();
        }
        Err(err) => eprintln!("quick view: {err}"),
    }
}

/// Windows' acrylic; on macOS the dark HUD vibrancy with rounded corners (the frameless window has none).
fn quickview_effects() -> tauri::utils::config::WindowEffectsConfig {
    #[cfg(target_os = "macos")]
    {
        tauri::window::EffectsBuilder::new()
            .effect(tauri::window::Effect::HudWindow)
            .state(tauri::window::EffectState::Active)
            .build()
    }
    #[cfg(not(target_os = "macos"))]
    {
        tauri::window::EffectsBuilder::new()
            .effect(tauri::window::Effect::Acrylic)
            .color(tauri::window::Color(9, 9, 9, 200))
            .build()
    }
}

/// Counts Quick View's showings, so a release scheduled before the last one can tell it is out of date.
#[derive(Default)]
struct QuickViewShown(std::sync::atomic::AtomicU64);

/// How long a hidden Quick View keeps its page: opening the next file in that time is instant; after it, the page (and
/// the web process behind it, a few hundred MB once documents and pictures were shown) is let go. With its last window
/// gone this process ends too; the file manager keeps running, and the next file starts the viewer again (about a second).
const QUICKVIEW_KEEP: std::time::Duration = std::time::Duration::from_secs(120);

fn release_quickview_later(app: &AppHandle) {
    let Some(shown) = app.try_state::<QuickViewShown>() else { return };
    let at = shown.0.load(std::sync::atomic::Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(QUICKVIEW_KEEP);
        let still = app.try_state::<QuickViewShown>().is_some_and(|s| s.0.load(std::sync::atomic::Ordering::SeqCst) == at);
        if !still {
            return;
        }
        let h = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(win) = h.get_webview_window(QUICKVIEW) {
                if !win.is_visible().unwrap_or(true) {
                    let _ = win.destroy();
                }
            }
        });
    });
}

/// Files waiting for a freshly created Quick View window.
#[tauri::command]
fn consume_quickview_files(state: State<'_, QuickViewQueue>) -> Vec<OpenWithFilePayload> {
    std::mem::take(&mut *state.0.lock().expect("queue mutex poisoned"))
}

/// Esc / close in Quick View. Behind the file manager this process is its viewer and stays, hidden, for the
/// next file; started for one file only (Open with), it exits so it doesn't linger invisibly.
#[tauri::command]
fn close_quickview(app: AppHandle) {
    if app.try_state::<BehindFileManager>().is_none() {
        app.exit(0);
        return;
    }
    if let Some(win) = app.get_webview_window(QUICKVIEW) {
        // the player pauses with it (a hidden window would otherwise keep playing), and the page lets go of what it showed
        let _ = win.emit_to(QUICKVIEW, "pulse://quickview-closed", ());
        let _ = win.hide();
        release_quickview_later(&app);
    }
}

fn main() {
    let startup_files: Vec<OpenWithFilePayload> = std::env::args()
        .skip(1)
        .filter_map(|arg| inspect_cli_file_arg(&arg))
        .collect();
    let file_manager_start = startup_files.is_empty();

    tauri::Builder::default()
        // Must be registered first: a second launch ("Open with" while running)
        // forwards its file arguments here and exits.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            // (a relative path is the launching process's, not ours)
            let payloads: Vec<OpenWithFilePayload> = argv
                .iter()
                .skip(1)
                .filter_map(|arg| {
                    let full = if arg.starts_with('-') { PathBuf::from(arg) } else { PathBuf::from(&cwd).join(arg) };
                    inspect_cli_file_arg(&full.to_string_lossy())
                })
                .collect();
            // no files: another file manager window; files: Quick View
            if payloads.is_empty() {
                if let Err(err) = spawn_file_manager(app, None) {
                    eprintln!("file manager: {err}");
                }
            } else {
                show_quickview(app, payloads);
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
        .manage(QuickViewShown::default())
        .invoke_handler(tauri::generate_handler![
            consume_startup_open_with_files,
            read_local_file_bytes,
            open_default_apps_settings,
            list_recent_system_files,
            list_recent_files_by_type,
            set_explorer_open_mode,
            consume_quickview_files,
            close_quickview,
            reveal_in_explorer,
            open_with_other_app,
            open_file_manager,
            save_next_to
        ])
        .setup(move |app| {
            // Pulse Explorer has no window of its own any more: the file manager is the app and Quick View
            // its viewer.
            let handle = app.handle().clone();
            app.manage(ExplorerOpenMode(Mutex::new(read_explorer_mode(&handle))));
            app.manage(PendingStartupFiles::default());
            #[cfg(target_os = "macos")]
            {
                // The file manager is the app in the Dock; this process only shows Quick View.
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                app.manage(MacStart::default());
            }
            if file_manager_start {
                app.manage(BehindFileManager);
                // macOS hands files from Finder over after launch (RunEvent::Opened), not as arguments: wait a
                // moment before deciding this start had no files.
                #[cfg(target_os = "macos")]
                {
                    let handle = handle.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(600));
                        let h = handle.clone();
                        let _ = handle.run_on_main_thread(move || {
                            let opened = h.state::<MacStart>().0.lock().map(|g| *g).unwrap_or(false);
                            if !opened {
                                start_as_file_manager(&h);
                            }
                        });
                    });
                }
                #[cfg(not(target_os = "macos"))]
                start_as_file_manager(&handle);
            } else {
                show_quickview(&handle, startup_files.clone());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running Pulse Explorer")
        .run(|_app, _event| {
            // The window's own close (macOS: the red traffic light) does what Esc does.
            if let tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::CloseRequested { api, .. }, .. } = &_event {
                if label == QUICKVIEW {
                    api.prevent_close();
                    close_quickview(_app.clone());
                    return;
                }
            }
            // macOS: files opened from Finder or the file manager ("Open with", double click) arrive here.
            #[cfg(target_os = "macos")]
            match _event {
                tauri::RunEvent::Opened { urls } => {
                    let files: Vec<OpenWithFilePayload> = urls
                        .iter()
                        .filter_map(|u| u.to_file_path().ok())
                        .filter_map(|p| inspect_cli_file_arg(&p.to_string_lossy()))
                        .collect();
                    if files.is_empty() {
                        return;
                    }
                    if let Some(s) = _app.try_state::<MacStart>() {
                        if let Ok(mut g) = s.0.lock() {
                            *g = true;
                        }
                    }
                    show_quickview(_app, files);
                }
                // Clicking the Dock icon / launching again while running: bring the file manager forward.
                tauri::RunEvent::Reopen { has_visible_windows: false, .. } => {
                    if let Err(err) = spawn_file_manager(_app, None) {
                        eprintln!("file manager: {err}");
                    }
                }
                _ => {}
            }
        });
}

/// macOS: set once Finder has handed this start a file, so it opens Quick View instead of the file manager.
#[cfg(target_os = "macos")]
#[derive(Default)]
struct MacStart(Mutex<bool>);
