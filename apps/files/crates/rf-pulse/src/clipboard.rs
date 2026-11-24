//! "Paste as file": what is on the clipboard becomes a file in the folder.

use crate::naming::{sanitize, stamp, unique};

#[derive(Debug, Clone, PartialEq)]
pub enum Content {
    Png(Vec<u8>),
    Link { url: String, title: Option<String> },
    Text(String),
}

/// Pictures first, then a web address on its own, then any text.
pub fn choose(png: Option<Vec<u8>>, text: Option<String>, url_title: Option<String>) -> Option<Content> {
    if let Some(p) = png.filter(|p| !p.is_empty()) {
        return Some(Content::Png(p));
    }
    let text = text.filter(|t| !t.trim().is_empty())?;
    let t = text.trim();
    let lower = t.to_lowercase();
    if !t.contains(char::is_whitespace) && (lower.starts_with("http://") || lower.starts_with("https://")) && t.split("://").nth(1).is_some_and(|r| !r.is_empty()) {
        return Some(Content::Link { url: t.to_string(), title: url_title });
    }
    Some(Content::Text(text))
}

/// The file's name (free per `taken`) and bytes. Links become `.url` files (Windows' Internet Shortcut) or `.webloc`.
pub fn output(content: &Content, now: chrono::DateTime<chrono::Local>, windows: bool, taken: impl Fn(&str) -> bool) -> (String, Vec<u8>) {
    let s = stamp(now);
    match content {
        Content::Png(d) => (unique(&format!("Pasted image {s}"), "png", true, taken), d.clone()),
        Content::Link { url, title } => {
            let host = url.split("://").nth(1).unwrap_or("Link").split('/').next().unwrap_or("Link").to_string();
            let base = title.as_deref().map(|t| sanitize(t, "Link")).unwrap_or(host);
            if windows {
                (unique(&base, "url", true, taken), format!("[InternetShortcut]\r\nURL={url}\r\n").into_bytes())
            } else {
                let plist = format!(
                    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>URL</key><string>{}</string></dict></plist>\n",
                    url.replace('&', "&amp;").replace('<', "&lt;")
                );
                (unique(&base, "webloc", true, taken), plist.into_bytes())
            }
        }
        Content::Text(t) => {
            let first = t.lines().next().unwrap_or("");
            let mut title: String = first.trim_matches(|c: char| "#*>- \t".contains(c)).to_string();
            if title.chars().count() > 40 {
                title = title.chars().take(40).collect::<String>().trim_end().to_string() + "…";
            }
            let ext = if looks_like_markdown(t) { "md" } else { "txt" };
            let base = if title.is_empty() { format!("Pasted text {s}") } else { title };
            (unique(&base, ext, true, taken), t.as_bytes().to_vec())
        }
    }
}

fn looks_like_markdown(s: &str) -> bool {
    let lines: Vec<&str> = s.lines().collect();
    let marks = lines.iter().filter(|l| ["# ", "## ", "- ", "* ", "```", "> "].iter().any(|m| l.starts_with(m))).count();
    marks > 0 && (marks * 4 >= lines.len() || lines.first().is_some_and(|l| l.starts_with('#')))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn none(_: &str) -> bool {
        false
    }

    #[test]
    fn preference_order() {
        assert_eq!(choose(Some(vec![1]), Some("x".into()), None), Some(Content::Png(vec![1])));
        assert!(matches!(choose(None, Some("https://example.com/a".into()), None), Some(Content::Link { .. })));
        assert_eq!(choose(None, Some("see https://x.y".into()), None), Some(Content::Text("see https://x.y".into())));
        assert_eq!(choose(Some(vec![]), Some("  ".into()), None), None);
    }

    #[test]
    fn files_are_named_and_never_replace() {
        let now = chrono::Local::now();
        assert_eq!(output(&Content::Text("# Plan\n- one\n- two".into()), now, true, none).0, "Plan.md");
        let (name, body) = output(&Content::Link { url: "https://pulse.app/x".into(), title: Some("Pulse: home".into()) }, now, true, none);
        assert_eq!(name, "Pulse- home.url");
        assert!(String::from_utf8(body).unwrap().contains("URL=https://pulse.app/x"));
        assert!(output(&Content::Link { url: "https://a.b".into(), title: None }, now, false, none).0.ends_with(".webloc"));
        let first = output(&Content::Png(vec![1]), now, true, none).0;
        let second = output(&Content::Png(vec![1]), now, true, |n| n == first).0;
        assert!(second.ends_with(" 2.png"));
    }
}
