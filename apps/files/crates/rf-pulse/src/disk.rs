//! "What's taking space here": big files not used for a long time, and copies of the same file (confirmed by content).

use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub path: PathBuf,
    pub size: u64,
    /// Last opened (the file system's access time where kept), else modified.
    pub last_used: SystemTime,
}

/// Every regular file under `root` (hidden ones and symlinks skipped), at most `max` of them.
pub fn scan(root: &Path, max: usize, cancelled: &dyn Fn() -> bool) -> Vec<Item> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            if out.len() >= max || cancelled() {
                return out;
            }
            let name = e.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                stack.push(e.path());
            } else if ft.is_file() {
                let Ok(m) = e.metadata() else { continue };
                let modified = m.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                let accessed = m.accessed().unwrap_or(modified);
                out.push(Item { path: e.path(), size: m.len(), last_used: accessed.max(modified) });
            }
        }
    }
    out
}

/// Big and not used for `unused_for`, biggest first.
pub fn big_and_unused(items: &[Item], min_size: u64, unused_for: Duration, now: SystemTime) -> Vec<Item> {
    let mut v: Vec<Item> = items
        .iter()
        .filter(|i| i.size >= min_size && now.duration_since(i.last_used).unwrap_or_default() >= unused_for)
        .cloned()
        .collect();
    v.sort_by(|a, b| b.size.cmp(&a.size));
    v
}

/// Sets of files with the same content (two or more each), biggest waste first: by size, then the first and last 64 KB,
/// then the whole file.
pub fn duplicates(items: &[Item], min_size: u64, cancelled: &dyn Fn() -> bool) -> Vec<Vec<Item>> {
    let mut by_size: HashMap<u64, Vec<&Item>> = HashMap::new();
    for i in items.iter().filter(|i| i.size >= min_size) {
        by_size.entry(i.size).or_default().push(i);
    }
    let mut groups = Vec::new();
    for same in by_size.values().filter(|v| v.len() > 1) {
        if cancelled() {
            break;
        }
        let mut by_quick: HashMap<String, Vec<&Item>> = HashMap::new();
        for i in same {
            if let Some(h) = quick_hash(&i.path) {
                by_quick.entry(h).or_default().push(i);
            }
        }
        for c in by_quick.values().filter(|v| v.len() > 1) {
            let mut by_full: HashMap<String, Vec<Item>> = HashMap::new();
            for i in c {
                if let Some(h) = full_hash(&i.path) {
                    by_full.entry(h).or_default().push((*i).clone());
                }
            }
            for mut g in by_full.into_values().filter(|v| v.len() > 1) {
                g.sort_by(|a, b| a.path.cmp(&b.path));
                groups.push(g);
            }
        }
    }
    groups.sort_by(|a, b| wasted(b).cmp(&wasted(a)));
    groups
}

/// Space the extra copies take (all but one).
pub fn wasted(group: &[Item]) -> u64 {
    group.iter().skip(1).map(|i| i.size).sum()
}

fn quick_hash(p: &Path) -> Option<String> {
    let mut f = std::fs::File::open(p).ok()?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let n = f.read(&mut buf).ok()?;
    h.update(&buf[..n]);
    let len = f.metadata().ok()?.len();
    if len > 128 * 1024 {
        f.seek(SeekFrom::Start(len - 64 * 1024)).ok()?;
        let n = f.read(&mut buf).ok()?;
        h.update(&buf[..n]);
    }
    Some(format!("{:x}", h.finalize()))
}

fn full_hash(p: &Path) -> Option<String> {
    let mut f = std::fs::File::open(p).ok()?;
    let mut h = Sha256::new();
    std::io::copy(&mut f, &mut h).ok()?;
    Some(format!("{:x}", h.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicates_need_the_same_content_not_just_the_same_size() {
        let d = tempfile::tempdir().unwrap();
        let mb = 1024 * 1024;
        let mut a = vec![7u8; 2 * mb];
        std::fs::create_dir_all(d.path().join("one")).unwrap();
        std::fs::create_dir_all(d.path().join("two")).unwrap();
        std::fs::write(d.path().join("one/a.bin"), &a).unwrap();
        std::fs::write(d.path().join("two/a copy.bin"), &a).unwrap();
        a[mb] = 8; // same size, head and tail; another middle
        std::fs::write(d.path().join("almost.bin"), &a).unwrap();
        std::fs::write(d.path().join(".hidden.bin"), &a).unwrap();
        let items = scan(d.path(), 1000, &|| false);
        assert_eq!(items.len(), 3, "hidden files are skipped");
        let g = duplicates(&items, mb as u64, &|| false);
        assert_eq!(g.len(), 1);
        let names: Vec<String> = g[0].iter().map(|i| i.path.file_name().unwrap().to_string_lossy().into()).collect();
        assert!(names.contains(&"a.bin".to_string()) && names.contains(&"a copy.bin".to_string()));
        assert_eq!(wasted(&g[0]), 2 * mb as u64);
    }

    #[test]
    fn big_and_unused_filter() {
        let now = SystemTime::now();
        let day = Duration::from_secs(86_400);
        let it = |p: &str, size: u64, ago: u64| Item { path: p.into(), size, last_used: now - day * ago as u32 };
        let items = [it("a", 500, 2), it("b", 50, 9), it("c", 900, 0), it("d", 700, 3)];
        let v = big_and_unused(&items, 100, day, now);
        assert_eq!(v.iter().map(|i| i.path.to_string_lossy().to_string()).collect::<Vec<_>>(), ["d", "a"]);
    }
}
