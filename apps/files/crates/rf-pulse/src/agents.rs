//! What a terminal pane is doing, for its tab's mark, the Agents panel and notifications; the bell; the scrollback kept
//! for a restore. (The Mac app's PulseKit AgentStatus, the same rules.)

pub const AGENT_NAMES: [&str; 15] = [
    "claude", "claude-code", "agy", "antigravity", "codex", "gemini", "aider", "opencode", "amp", "cursor-agent", "goose", "crush", "qwen", "droid", "copilot",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Idle,
    Running,
    Working,
    Waiting,
}

impl Status {
    pub fn mark(self) -> &'static str {
        match self {
            Status::Working => "◌ ",
            Status::Waiting => "◐ ",
            _ => "",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Status::Idle => "At the prompt",
            Status::Running => "Running",
            Status::Working => "Working",
            Status::Waiting => "Waiting for you",
        }
    }
    /// An agent stopping to ask is worth telling.
    pub fn notifies(self, old: Status) -> bool {
        self == Status::Waiting && old == Status::Working
    }
}

/// "claude.exe", "Gemini-CLI", "codex": the program's name without ".exe" or "-cli", lowercase.
pub fn base_name(program: &str) -> String {
    let p = program.to_lowercase();
    let p = p.rsplit(['\\', '/']).next().unwrap_or(&p).to_string();
    let p = p.strip_suffix(".exe").map(String::from).unwrap_or(p);
    let p = p.strip_suffix(".cmd").map(String::from).unwrap_or(p);
    p.strip_suffix("-cli").map(String::from).unwrap_or(p)
}

pub fn is_agent(program: &str, extra: &[String]) -> bool {
    let b = base_name(program);
    AGENT_NAMES.contains(&b.as_str()) || extra.iter().any(|e| e.to_lowercase() == b)
}

/// An agent in front that has said nothing for `quiet_after` seconds, or has just rung, waits.
pub fn status(program: Option<&str>, quiet_for: f64, rang: bool, quiet_after: f64, extra: &[String]) -> Status {
    match program {
        None => Status::Idle,
        Some(p) if !is_agent(p, extra) => Status::Running,
        Some(_) if rang || quiet_for >= quiet_after => Status::Waiting,
        Some(_) => Status::Working,
    }
}

/// Whether a typed command line starts an agent (env assignments and wrappers like npx, pnpm dlx, bunx, uvx, npm exec
/// skipped; npm package names like @anthropic-ai/claude-code understood).
pub fn command_is_agent(line: &str, extra: &[String]) -> bool {
    let words: Vec<&str> = line.split_whitespace().collect();
    let mut i = 0;
    while i < words.len() {
        let w = words[i];
        if w.contains('=') || w.starts_with('-') || ["env", "nohup", "time", "command", "exec", "&"].contains(&w) {
            i += 1;
        } else if ["npx", "bunx", "pnpx", "uvx", "pipx"].contains(&w) {
            i += 1;
            if words.get(i) == Some(&"run") {
                i += 1;
            }
        } else if ["pnpm", "yarn", "bun", "npm"].contains(&w) && matches!(words.get(i + 1), Some(&"dlx" | &"x" | &"exec")) {
            i += 2;
        } else {
            break;
        }
    }
    let Some(w) = words.get(i) else { return false };
    let w = w.trim_start_matches('&').trim_matches(['"', '\'']);
    let w = w.rsplit('/').next().unwrap_or(w);
    let w = w.split('@').find(|s| !s.is_empty()).unwrap_or(w);
    is_agent(w, extra)
}

/// Finds the bell in output, leaving out the BEL that ends an OSC sequence.
#[derive(Default)]
pub struct BellScanner {
    in_osc: bool,
    saw_esc: bool,
}

impl BellScanner {
    pub fn scan(&mut self, bytes: &[u8]) -> bool {
        let mut rang = false;
        for &b in bytes {
            if self.in_osc {
                if b == 0x07 || (self.saw_esc && b == b'\\') {
                    self.in_osc = false;
                }
            } else if self.saw_esc && b == b']' {
                self.in_osc = true;
            } else if b == 0x07 {
                rang = true;
            }
            self.saw_esc = b == 0x1B;
        }
        rang
    }
}

/// The tail of a terminal's output, cut at a line start.
pub struct Ring {
    cap: usize,
    data: Vec<u8>,
}

impl Ring {
    pub fn new(cap: usize) -> Self {
        Self { cap, data: Vec::new() }
    }
    pub fn push(&mut self, bytes: &[u8]) {
        self.data.extend_from_slice(bytes);
        if self.data.len() > self.cap {
            let mut cut = self.data.len() - self.cap;
            if let Some(nl) = self.data[cut..].iter().position(|&b| b == b'\n') {
                cut += nl + 1;
            }
            self.data.drain(..cut);
        }
    }
    pub fn bytes(&self) -> &[u8] {
        &self.data
    }
    /// What to show again: alternate-screen switches taken out, colours reset at the end.
    pub fn replay(saved: &[u8]) -> Vec<u8> {
        let mut t = String::from_utf8_lossy(saved).to_string();
        for s in ["\x1b[?1049h", "\x1b[?1049l", "\x1b[?47h", "\x1b[?47l", "\x1b[?1047h", "\x1b[?1047l"] {
            t = t.replace(s, "");
        }
        (t + "\x1b[0m").into_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses() {
        assert_eq!(status(None, 9.0, true, 3.0, &[]), Status::Idle);
        assert_eq!(status(Some("npm.exe"), 9.0, false, 3.0, &[]), Status::Running);
        assert_eq!(status(Some("claude.exe"), 0.4, false, 3.0, &[]), Status::Working);
        assert_eq!(status(Some("claude.exe"), 5.0, false, 3.0, &[]), Status::Waiting);
        assert_eq!(status(Some("codex"), 0.1, true, 3.0, &[]), Status::Waiting);
        assert_eq!(status(Some("Gemini-CLI.exe"), 9.0, false, 3.0, &[]), Status::Waiting);
        assert_eq!(status(Some("mybot"), 9.0, false, 3.0, &["mybot".into()]), Status::Waiting);
        assert!(Status::Waiting.notifies(Status::Working));
        assert!(!Status::Idle.notifies(Status::Working));
    }

    #[test]
    fn agent_command_lines() {
        for l in ["claude", "claude --resume", "agy", "codex exec hi", "npx @anthropic-ai/claude-code", "npx -y @google/gemini-cli", "pnpm dlx opencode",
                  "C:/Users/a/.local/bin/claude", "& claude", "\"claude\""] {
            assert!(command_is_agent(l, &[]), "{l}");
        }
        for l in ["ls", "git commit -m claude", "echo claude", "pnpm run dev", "code claude.md", ""] {
            assert!(!command_is_agent(l, &[]), "{l}");
        }
    }

    #[test]
    fn bell_and_ring() {
        let mut s = BellScanner::default();
        assert!(!s.scan(b"\x1b]0;title\x07text"));
        assert!(s.scan(b"done\x07"));
        assert!(!s.scan(b"\x1b]0;long ti"));
        assert!(!s.scan(b"tle\x07"));
        let mut r = Ring::new(20);
        r.push(b"line one\nline two\nline three\n");
        assert!(r.bytes().len() <= 20 && r.bytes().starts_with(b"line") && r.bytes().ends_with(b"line three\n"));
        assert_eq!(Ring::replay(b"a\x1b[?1049hfull\x1b[?1049lb"), b"afullb\x1b[0m");
    }
}
