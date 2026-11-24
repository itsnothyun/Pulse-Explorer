//! A short note on a folder, kept on the folder itself so it moves and copies with it: an NTFS alternate data stream on
//! Windows (`folder:app.pulse.note`), an extended attribute elsewhere is the Mac app's (this crate falls back to a hidden
//! `.pulse-note` file off Windows, for tests and other systems).

use std::path::{Path, PathBuf};

pub const MAX_BYTES: usize = 16 * 1024;

fn store(folder: &Path) -> PathBuf {
    if cfg!(windows) {
        let mut s = folder.as_os_str().to_os_string();
        s.push(":app.pulse.note");
        PathBuf::from(s)
    } else {
        folder.join(".pulse-note")
    }
}

pub fn read(folder: &Path) -> Option<String> {
    let t = std::fs::read_to_string(store(folder)).ok()?;
    let t = t.trim().to_string();
    (!t.is_empty()).then_some(t)
}

/// Writes the note; an empty one removes it. Refuses more than 16 KB.
pub fn write(folder: &Path, note: &str) -> Result<(), String> {
    let t = note.trim();
    if !folder.is_dir() {
        return Err(format!("{} is not a folder", folder.display()));
    }
    if t.is_empty() {
        return match std::fs::remove_file(store(folder)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        };
    }
    if t.len() > MAX_BYTES {
        return Err("The note is too long (16 KB at most).".into());
    }
    std::fs::write(store(folder), t).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_read_replace_remove() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(read(d.path()), None);
        write(d.path(), "Invoices 2026 — send to the accountant").unwrap();
        assert_eq!(read(d.path()).as_deref(), Some("Invoices 2026 — send to the accountant"));
        write(d.path(), "  second\n").unwrap();
        assert_eq!(read(d.path()).as_deref(), Some("second"));
        write(d.path(), "  ").unwrap();
        assert_eq!(read(d.path()), None);
        write(d.path(), "").unwrap();
        assert!(write(d.path(), &"x".repeat(MAX_BYTES + 1)).is_err());
        assert!(write(&d.path().join("nope"), "x").is_err());
    }
}
