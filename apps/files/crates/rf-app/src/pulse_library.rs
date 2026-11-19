//! Pulse Explorer's library, ported from its web workspace (Library, Types, Recent, Favorites and the Home stats)
//! into the file manager. The web app kept imported copies of files; here the library is the user's own folders:
//! one background scan of Desktop, Documents, Downloads, Pictures, Music and Videos sorts every file Pulse can view
//! into Pulse's nine types. The views open as `Location::Pulse { key, .. }` and list like a tag does.

use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use gpui_kit::assets::IconName as L;
use gpui_kit::*;
use rf_core::Location;

/// One of Pulse's file types (packages/shared-types `FileCategory`, as the web sidebar groups them).
pub struct PulseType {
    pub key: &'static str,
    pub name: &'static str,
    pub icon: L,
    pub exts: &'static [&'static str],
}

pub const TYPES: [PulseType; 9] = [
    PulseType { key: "pdf", name: "PDF", icon: L::FileText, exts: &["pdf"] },
    PulseType { key: "documents", name: "Documents", icon: L::FileText, exts: &["docx", "doc", "odt", "rtf", "txt", "md"] },
    PulseType { key: "slides", name: "Slides", icon: L::Presentation, exts: &["pptx", "ppt", "odp"] },
    PulseType { key: "sheets", name: "Sheets", icon: L::FileSpreadsheet, exts: &["xlsx", "xls", "ods", "csv", "tsv"] },
    PulseType { key: "ebooks", name: "eBooks", icon: L::BookOpen, exts: &["epub", "fb2"] },
    PulseType {
        key: "images",
        name: "Images",
        icon: L::FileImage,
        exts: &["png", "jpg", "jpeg", "webp", "gif", "bmp", "ico", "svg"],
    },
    PulseType {
        key: "code",
        name: "Code",
        icon: L::FileCode,
        exts: &[
            "ts", "tsx", "js", "jsx", "py", "go", "rs", "json", "yaml", "yml", "toml", "xml", "html", "css", "sql", "sh", "ini", "log",
        ],
    },
    PulseType {
        key: "media",
        name: "Media",
        icon: L::FileMusic,
        exts: &["mp4", "webm", "ogg", "mp3", "wav", "flac", "aac", "m4a", "mov", "mkv"],
    },
    PulseType { key: "archives", name: "Archives", icon: L::FileArchive, exts: &["zip", "tar", "gz", "tgz", "7z", "rar"] },
];

/// The index in [`TYPES`] of a file's type, from its extension; `None`: not a type Pulse lists.
pub fn type_index(path: &Path) -> Option<usize> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    TYPES.iter().position(|t| t.exts.contains(&ext.as_str()))
}

pub fn type_by_key(key: &str) -> Option<&'static PulseType> {
    TYPES.iter().find(|t| t.key == key)
}

/// The location of a library view.
pub fn location(key: &str) -> Location {
    let name = match key {
        "library" => "Library",
        "recent" => "Recent",
        "favorites" => "Favorites",
        k => type_by_key(k).map_or("Library", |t| t.name),
    };
    Location::Pulse { key: key.into(), name: name.into() }
}

pub fn icon(key: &str) -> L {
    match key {
        "library" => L::Library,
        "recent" => L::Clock,
        "favorites" => L::Star,
        k => type_by_key(k).map_or(L::File, |t| t.icon),
    }
}

/// A file the scan found.
#[derive(Clone)]
pub struct LibFile {
    pub path: PathBuf,
    pub size: u64,
    pub mtime_ms: i64,
    pub ctime_ms: i64,
    pub attrs: u32,
    pub ty: usize,
}

/// The scan's result, a global: every window reads it.
#[derive(Default)]
pub struct Library {
    pub files: Arc<Vec<LibFile>>,
    pub scanning: bool,
    pub scanned: bool,
}
impl Global for Library {}

impl Library {
    pub fn count(&self, ty: Option<usize>) -> usize {
        self.files.iter().filter(|f| ty.is_none_or(|t| f.ty == t)).count()
    }

    pub fn bytes(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }

    /// The newest files (by when they were last written), newest first.
    pub fn newest(&self, n: usize) -> Vec<LibFile> {
        let mut v: Vec<LibFile> = self.files.iter().cloned().collect();
        v.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
        v.truncate(n);
        v
    }
}

/// The folders the library is made of.
pub fn roots() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = [dirs::desktop_dir(), dirs::document_dir(), dirs::download_dir(), dirs::picture_dir(), dirs::audio_dir(), dirs::video_dir()]
        .into_iter()
        .flatten()
        .filter(|p| p.is_dir())
        .collect();
    v.dedup();
    v
}

/// At most this many files (a library is for finding things, not an index of the disk).
const MAX_FILES: usize = 50_000;
const MAX_DEPTH: usize = 12;

/// Folders a person does not keep documents in: tool caches and repositories' innards.
fn skipped(name: &str) -> bool {
    name.starts_with('.') || name.starts_with('$') || matches!(name.to_ascii_lowercase().as_str(), "node_modules" | "appdata" | "target" | "__pycache__")
}

fn scan() -> Vec<LibFile> {
    let mut out = Vec::new();
    let mut stack: Vec<(PathBuf, usize)> = roots().into_iter().map(|r| (r, 0)).collect();
    let mut seen = std::collections::HashSet::new();
    while let Some((dir, depth)) = stack.pop() {
        if out.len() >= MAX_FILES || !seen.insert(dir.clone()) {
            continue;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let Ok(m) = e.metadata() else { continue };
            // hidden and system items and links (a junction could loop) stay out
            const HIDDEN: u32 = 0x2;
            const SYSTEM: u32 = 0x4;
            const REPARSE: u32 = 0x400;
            if m.file_attributes() & (HIDDEN | SYSTEM | REPARSE) != 0 {
                continue;
            }
            let path = e.path();
            if m.is_dir() {
                if depth < MAX_DEPTH && !skipped(&e.file_name().to_string_lossy()) {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            let Some(ty) = type_index(&path) else { continue };
            out.push(LibFile {
                path,
                size: m.file_size(),
                mtime_ms: rf_core::format::filetime_to_unix_ms(m.last_write_time()),
                ctime_ms: rf_core::format::filetime_to_unix_ms(m.creation_time()),
                attrs: m.file_attributes(),
                ty,
            });
            if out.len() >= MAX_FILES {
                break;
            }
        }
    }
    out
}

/// Scans the library in the background (again, when asked once more), then redraws every window.
pub fn start_scan(cx: &mut App) {
    if cx.default_global::<Library>().scanning {
        return;
    }
    cx.global_mut::<Library>().scanning = true;
    let task = cx.background_executor().spawn(async { scan() });
    cx.spawn(async move |cx| {
        let files = task.await;
        cx.update(|cx| {
            let lib = cx.global_mut::<Library>();
            lib.files = Arc::new(files);
            lib.scanning = false;
            lib.scanned = true;
            cx.refresh_windows();
        });
    })
    .detach();
}

/// The files of a library view (not "recent": that one comes from the places' recent list).
pub fn paths(key: &str, cx: &App) -> Vec<PathBuf> {
    match key {
        "favorites" => cx.try_global::<Favorites>().map(|f| f.0.clone()).unwrap_or_default(),
        "library" => cx.try_global::<Library>().map(|l| l.files.iter().map(|f| f.path.clone()).collect()).unwrap_or_default(),
        k => {
            let Some(ty) = TYPES.iter().position(|t| t.key == k) else { return Vec::new() };
            cx.try_global::<Library>()
                .map(|l| l.files.iter().filter(|f| f.ty == ty).map(|f| f.path.clone()).collect())
                .unwrap_or_default()
        }
    }
}

// ---------------------------------------------------------------- favorites

/// Starred files and folders, persisted to `favorites.json` next to the settings.
#[derive(Default)]
pub struct Favorites(pub Vec<PathBuf>);
impl Global for Favorites {}

fn favorites_file() -> Option<PathBuf> {
    crate::settings::app_dir().map(|d| d.join("favorites.json"))
}

pub fn load_favorites() -> Favorites {
    let list = favorites_file()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<Vec<PathBuf>>(&b).ok())
        .unwrap_or_default();
    Favorites(list)
}

pub fn is_favorite(cx: &App, path: &Path) -> bool {
    cx.try_global::<Favorites>().is_some_and(|f| f.0.iter().any(|p| same_path(p, path)))
}

fn same_path(a: &Path, b: &Path) -> bool {
    a.as_os_str().eq_ignore_ascii_case(b.as_os_str())
}

/// Stars the paths, or takes the star off when every one of them has it (as tags toggle).
pub fn toggle_favorites(cx: &mut App, paths: &[PathBuf]) {
    let all = paths.iter().all(|p| is_favorite(cx, p));
    let favs = cx.default_global::<Favorites>();
    if all {
        favs.0.retain(|f| !paths.iter().any(|p| same_path(f, p)));
    } else {
        for p in paths {
            if !favs.0.iter().any(|f| same_path(f, p)) {
                favs.0.push(p.clone());
            }
        }
    }
    let snapshot = favs.0.clone();
    std::thread::spawn(move || {
        if let Some(file) = favorites_file() {
            if let Ok(json) = serde_json::to_vec_pretty(&snapshot) {
                if let Err(e) = std::fs::write(&file, json) {
                    log::warn!("favorites save: {e}");
                }
            }
        }
    });
    cx.refresh_windows();
}

#[cfg(test)]
mod tests {
    // (not `super::*`: that brings gpui's own `test` macro over the standard one)
    use super::{TYPES, skipped, type_index};
    use std::path::Path;

    #[test]
    fn files_sort_into_pulses_types_by_extension() {
        let key = |p: &str| type_index(Path::new(p)).map(|i| TYPES[i].key);
        assert_eq!(key(r"C:\a\Report.PDF"), Some("pdf"));
        assert_eq!(key(r"C:\a\deck.pptx"), Some("slides"));
        assert_eq!(key(r"C:\a\book.epub"), Some("ebooks"));
        assert_eq!(key(r"C:\a\clip.mp3"), Some("media"));
        assert_eq!(key(r"C:\a\setup.exe"), None);
        assert_eq!(key(r"C:\a\README"), None);
    }

    #[test]
    fn every_extension_belongs_to_one_type() {
        let mut seen = std::collections::HashSet::new();
        for t in &TYPES {
            for e in t.exts {
                assert!(seen.insert(*e), "{e} is in two types");
            }
        }
    }

    #[test]
    fn tool_folders_are_skipped() {
        assert!(skipped("node_modules") && skipped(".git") && skipped("AppData") && skipped("$RECYCLE.BIN"));
        assert!(!skipped("Projects") && !skipped("Invoices 2026"));
    }
}
