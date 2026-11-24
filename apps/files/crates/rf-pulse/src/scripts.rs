//! A project's scripts: package.json (with its package manager), Makefile, justfile, composer.json.

use std::path::Path;

#[derive(Debug, Clone, PartialEq)]
pub struct Script {
    pub name: String,
    pub detail: String,
    pub command: String,
}

pub const FILES: [&str; 5] = ["package.json", "makefile", "gnumakefile", "composer.json", "justfile"];

pub fn handles(file: &Path) -> bool {
    file.file_name().is_some_and(|n| FILES.contains(&n.to_string_lossy().to_lowercase().as_str()))
}

pub fn scripts(file: &Path) -> Vec<Script> {
    let Ok(text) = std::fs::read_to_string(file) else { return vec![] };
    let dir = file.parent().unwrap_or(Path::new("."));
    match file.file_name().map(|n| n.to_string_lossy().to_lowercase()).as_deref() {
        Some("package.json") => npm(&text, package_manager(dir)),
        Some("composer.json") => composer(&text),
        Some("makefile" | "gnumakefile") => make(&text),
        Some("justfile") => just(&text),
        _ => vec![],
    }
}

/// pnpm, yarn or bun from the lock file (here or up to five folders up), else npm.
pub fn package_manager(dir: &Path) -> &'static str {
    let mut d = Some(dir);
    for _ in 0..6 {
        let Some(p) = d else { break };
        for (lock, pm) in [("pnpm-lock.yaml", "pnpm"), ("yarn.lock", "yarn"), ("bun.lockb", "bun"), ("bun.lock", "bun"), ("package-lock.json", "npm")] {
            if p.join(lock).exists() {
                return pm;
            }
        }
        d = p.parent();
    }
    "npm"
}

/// The members of a top-level JSON object, in the order written.
fn ordered(json: &str, key: &str) -> Vec<(String, String)> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return vec![] };
    let Some(obj) = v.get(key).and_then(|o| o.as_object()) else { return vec![] };
    let tail = json.find(&format!("\"{key}\"")).map(|i| &json[i..]).unwrap_or(json);
    let mut members: Vec<(usize, String, String)> = obj
        .iter()
        .map(|(k, v)| {
            let pos = tail.find(&format!("\"{}\"", k.replace('\\', "\\\\").replace('"', "\\\""))).unwrap_or(usize::MAX);
            let body = match v {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Array(a) => a.iter().map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).collect::<Vec<_>>().join(" && "),
                _ => String::new(),
            };
            (pos, k.clone(), body)
        })
        .collect();
    members.sort_by_key(|m| m.0);
    members.into_iter().map(|(_, k, b)| (k, b)).collect()
}

pub fn npm(json: &str, manager: &str) -> Vec<Script> {
    ordered(json, "scripts").into_iter().map(|(n, b)| Script { command: format!("{manager} run {}", quote(&n)), name: n, detail: b }).collect()
}

pub fn composer(json: &str) -> Vec<Script> {
    ordered(json, "scripts").into_iter().map(|(n, b)| Script { command: format!("composer run-script {}", quote(&n)), name: n, detail: b }).collect()
}

/// Targets a person runs: `name:` at a line's start, not special (.PHONY), not a pattern or a variable.
pub fn make(text: &str) -> Vec<Script> {
    let lines: Vec<&str> = text.lines().collect();
    let mut out: Vec<Script> = vec![];
    for (i, line) in lines.iter().enumerate() {
        let Some(first) = line.chars().next() else { continue };
        if matches!(first, '\t' | ' ' | '#' | '.') {
            continue;
        }
        let Some(colon) = line.find(':') else { continue };
        if line[colon + 1..].starts_with('=') {
            continue;
        }
        let head = &line[..colon];
        if head.contains(['=', '%', '$']) {
            continue;
        }
        for t in head.split_whitespace() {
            if out.iter().any(|s| s.name == t) {
                continue;
            }
            let recipe = lines[i + 1..].iter().find(|l| l.starts_with('\t')).map(|l| l.trim().to_string()).unwrap_or_default();
            out.push(Script { name: t.into(), detail: recipe, command: format!("make {}", quote(t)) });
        }
    }
    out
}

pub fn just(text: &str) -> Vec<Script> {
    text.lines()
        .filter_map(|l| {
            let first = l.chars().next()?;
            if !(first.is_alphabetic() || first == '_') {
                return None;
            }
            let colon = l.find(':')?;
            if l[colon + 1..].starts_with('=') {
                return None;
            }
            let name = l[..colon].split_whitespace().next()?;
            (!name.contains('=')).then(|| Script { name: name.into(), detail: String::new(), command: format!("just {}", quote(name)) })
        })
        .collect()
}

/// A name as one shell word (bare when safe, else single-quoted; PowerShell and POSIX shells both take it).
pub fn quote(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_alphanumeric() || "-_:./@+=".contains(c)) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "''"))
    }
}

/// The usual ones first: dev, start, serve, build, test.
pub fn ranked(mut v: Vec<Script>) -> Vec<Script> {
    let rank = |n: &str| ["dev", "start", "serve", "build", "test"].iter().position(|r| *r == n).unwrap_or(10);
    v.sort_by_key(|s| rank(&s.name)); // stable: the rest keep their order
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_json_order_and_manager() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("app")).unwrap();
        std::fs::write(d.path().join("pnpm-lock.yaml"), "").unwrap();
        let json = r#"{"name":"x","scripts":{"dev":"vite","build":"tsc && vite build","test:unit":"vitest run","a b":"echo"},"dependencies":{"dev":"1"}}"#;
        std::fs::write(d.path().join("app/package.json"), json).unwrap();
        let s = scripts(&d.path().join("app/package.json"));
        assert_eq!(s.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["dev", "build", "test:unit", "a b"]);
        assert_eq!(s[2].command, "pnpm run test:unit");
        assert_eq!(s[3].command, "pnpm run 'a b'");
        assert!(npm("{ broken", "npm").is_empty());
    }

    #[test]
    fn makefile_and_composer_and_rank() {
        let mk = "CC := clang\n.PHONY: all test\nall: build test\n\tswift build\nbuild:\n\tcargo build --release\n%.o: %.c\n\t$(CC) -c $<\ntest lint: build\n\tcargo test\n";
        assert_eq!(make(mk).iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["all", "build", "test", "lint"]);
        let c = composer(r#"{"scripts":{"test":"phpunit","post":["a","b"]}}"#);
        assert_eq!(c[1].detail, "a && b");
        let r = ranked(npm(r#"{"scripts":{"lint":"x","build":"y","dev":"z"}}"#, "npm"));
        assert_eq!(r.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["dev", "build", "lint"]);
        assert_eq!(quote("it's"), "'it''s'");
    }
}
