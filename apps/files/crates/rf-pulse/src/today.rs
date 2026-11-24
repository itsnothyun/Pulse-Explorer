//! "Changed today": files modified since the start of the day under a folder, newest first.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

const SKIP: [&str; 8] = ["node_modules", ".build", "target", "build", "dist", "DerivedData", "vendor", ".git"];

/// Files under `root` modified at or after `since`, newest first (build and dependency folders skipped), capped.
pub fn scan(root: &Path, since: SystemTime, limit: usize) -> Vec<(PathBuf, SystemTime)> {
    let mut out = vec![];
    let mut stack = vec![root.to_path_buf()];
    let mut visited = 0usize;
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            visited += 1;
            if visited > 300_000 || out.len() >= limit {
                break;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') && name != ".github" {
                continue;
            }
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                if !SKIP.contains(&name.as_str()) {
                    stack.push(e.path());
                }
            } else if ft.is_file() {
                if let Ok(m) = e.metadata().and_then(|m| m.modified()) {
                    if m >= since {
                        out.push((e.path(), m));
                    }
                }
            }
        }
    }
    out.sort_by(|a, b| b.1.cmp(&a.1));
    out
}

/// The start of today, local time.
pub fn start_of_today() -> SystemTime {
    let now = chrono::Local::now();
    let midnight = now.date_naive().and_hms_opt(0, 0, 0).unwrap();
    let local = midnight.and_local_timezone(chrono::Local).earliest().unwrap_or(now);
    SystemTime::from(local)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_todays_files_and_skips_build_folders() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("notes.txt"), "x").unwrap();
        std::fs::create_dir_all(d.path().join("node_modules/dep")).unwrap();
        std::fs::write(d.path().join("node_modules/dep/index.js"), "x").unwrap();
        let old = d.path().join("old.txt");
        std::fs::write(&old, "x").unwrap();
        let f = std::fs::File::options().write(true).open(&old).unwrap();
        f.set_modified(SystemTime::now() - std::time::Duration::from_secs(3 * 86_400)).unwrap();
        let found: Vec<String> = scan(d.path(), start_of_today(), 100).iter().map(|(p, _)| p.file_name().unwrap().to_string_lossy().into()).collect();
        assert_eq!(found, ["notes.txt"]);
    }
}
