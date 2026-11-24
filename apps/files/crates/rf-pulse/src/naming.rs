//! Names for files Pulse makes: never one that is taken, never one Windows or macOS refuses.

const RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5",
    "lpt6", "lpt7", "lpt8", "lpt9",
];

/// A name any disk takes: no separators or `<>:"|?*`, no control characters, no leading dots, no trailing dots or spaces
/// (Windows), not a reserved device name, at most 240 bytes.
pub fn sanitize(name: &str, fallback: &str) -> String {
    let mut s: String = name
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| if matches!(c, '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*') { '-' } else { c })
        .collect();
    s = s.trim().trim_start_matches('.').trim_end_matches(['.', ' ']).to_string();
    if s.is_empty() {
        s = fallback.to_string();
    }
    if RESERVED.contains(&s.to_lowercase().as_str()) {
        s.push('_');
    }
    while s.len() > 240 {
        s.pop();
    }
    s
}

/// `base.ext`, or `base 2.ext`, `base 3.ext`… the first `taken` says is free (case ignored).
pub fn unique(base: &str, ext: &str, sanitizing: bool, taken: impl Fn(&str) -> bool) -> String {
    let b = if sanitizing { sanitize(base, "Untitled") } else { base.to_string() };
    let e = if sanitizing { ext.trim_matches('.').to_lowercase() } else { ext.to_string() };
    let name = |n: u32| {
        let stem = if n == 1 { b.clone() } else { format!("{b} {n}") };
        if e.is_empty() { stem } else { format!("{stem}.{e}") }
    };
    (1..=10_000).map(name).find(|n| !taken(n)).unwrap_or_else(|| name(chrono::Utc::now().timestamp() as u32))
}

/// `unique` against what is in `folder` on disk.
pub fn unique_in(base: &str, ext: &str, folder: &std::path::Path) -> String {
    let existing: std::collections::HashSet<String> = std::fs::read_dir(folder)
        .map(|r| r.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_lowercase()).collect())
        .unwrap_or_default();
    unique(base, ext, true, |n| existing.contains(&n.to_lowercase()))
}

/// "2026-11-21 at 14.05.09" (dots: ":" can't be in a name).
pub fn stamp(t: chrono::DateTime<chrono::Local>) -> String {
    t.format("%Y-%m-%d at %H.%M.%S").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_for_every_disk() {
        assert_eq!(sanitize("a/b:c<d>|e?*", "x"), "a-b-c-d--e--");
        assert_eq!(sanitize("..hidden", "x"), "hidden");
        assert_eq!(sanitize("trailing. ", "x"), "trailing");
        assert_eq!(sanitize("CON", "x"), "CON_");
        assert_eq!(sanitize("  \n ", "Untitled"), "Untitled");
        assert!(sanitize(&"é".repeat(300), "x").len() <= 240);
    }

    #[test]
    fn unique_skips_taken_names_ignoring_case() {
        let taken = ["report.pdf", "report 2.pdf"];
        assert_eq!(unique("Report", "PDF", true, |n| taken.contains(&n.to_lowercase().as_str())), "Report 3.pdf");
        assert_eq!(unique(".env", "", false, |n| n == ".env"), ".env 2");
    }

    #[test]
    fn stamp_has_no_colons() {
        assert!(!stamp(chrono::Local::now()).contains(':'));
    }
}
