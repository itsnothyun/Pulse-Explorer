//! Pulse Explorer's terminal tabs on Windows (TerminalTabs.swift on the Mac): a browser tab (`web_view`) on our own page at
//! `https://pulse-terminal.local/`, xterm.js drawing, and a PowerShell in a ConPTY here behind it.
//!
//! The page and the shell talk over WebView2's messages (JSON): the page sends `ready` (with its size), `in` (what was typed),
//! `size` and `cmd` (close the tab, a new terminal); we send `out` (the shell's bytes, base64), `frames` (the welcome card's
//! pulse line), `title` and `exit`. The shell's output is read on a thread of its own, queued, and handed to the page on the
//! UI thread: the reader posts [`WAKE`] to the page's window, whose window procedure calls [`pump`].
//!
//! What is in front comes from the titles the start-up script sets (`rf_pulse::term`): the tab's name and its agent mark
//! (working, waiting for you) follow it; an agent that stops to ask flashes the window in the taskbar when it is not in front.

use std::cell::RefCell;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use gpui_kit::EntityId;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize};
use rf_pulse::agents::{BellScanner, Status};
use rf_pulse::term::{Title, TitleScanner};
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_APP};

pub const HOST: &str = "pulse-terminal.local";
/// Posted to a page's window when its shell has something for it.
pub const WAKE: u32 = WM_APP + 0x51;
/// An agent quiet this long is waiting for you (seconds; the Mac's default).
const QUIET_AFTER: f64 = 3.0;

const PAGE: [(&str, &str); 4] = [
    ("index.html", include_str!("../assets/terminal/index.html")),
    ("xterm.js", include_str!("../assets/terminal/xterm.js")),
    ("xterm.css", include_str!("../assets/terminal/xterm.css")),
    ("addon-fit.js", include_str!("../assets/terminal/addon-fit.js")),
];

/// The address of a terminal tab in `dir`.
pub fn url_for(dir: &Path) -> String {
    format!("https://{HOST}/index.html?dir={}", encode(&dir.to_string_lossy()))
}

pub fn is_terminal(url: &str) -> bool {
    url.to_ascii_lowercase().starts_with(&format!("https://{HOST}/"))
}

/// The folder a terminal tab's address names.
pub fn dir_of(url: &str) -> Option<PathBuf> {
    if !is_terminal(url) {
        return None;
    }
    let q = url.split_once('?')?.1;
    q.split('&').find_map(|kv| kv.strip_prefix("dir=")).map(decode).filter(|d| !d.is_empty()).map(PathBuf::from)
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The page's files on disk (written once per run, next to WebView2's data), for the virtual host.
pub fn page_dir() -> Option<PathBuf> {
    static DIR: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    DIR.get_or_init(|| {
        let dir = crate::settings::app_dir().unwrap_or_else(std::env::temp_dir).join("TerminalPage");
        std::fs::create_dir_all(&dir).ok()?;
        for (name, text) in PAGE {
            let p = dir.join(name);
            if std::fs::read_to_string(&p).ok().as_deref() != Some(text) {
                std::fs::write(&p, text).ok()?;
            }
        }
        Some(dir)
    })
    .clone()
}

// ---------------------------------------------------------------------------------------------------------------
// sessions

enum Out {
    Bytes(Vec<u8>),
    Exit,
}

#[derive(Default)]
struct Shared {
    queue: Vec<Out>,
    last_output: Option<Instant>,
    rang: bool,
    /// The program in front (from the titles), and the name it gave itself.
    program: Option<String>,
    own_title: Option<String>,
    /// The welcome card has come through (its pulse line is drawn in then).
    card_seen: bool,
}

struct Session {
    owner: isize,
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    shared: Arc<Mutex<Shared>>,
    alive: Arc<AtomicBool>,
    folder: String,
    frames: Option<Vec<String>>,
    status: Status,
    shown_title: String,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Relaxed);
        let _ = self.child.kill();
    }
}

thread_local! {
    static SESSIONS: RefCell<HashMap<EntityId, Session>> = RefCell::new(HashMap::new());
    /// A page's window → its tab (for [`WAKE`]).
    static HOSTS: RefCell<HashMap<isize, EntityId>> = RefCell::new(HashMap::new());
}

/// Something the page asked of the app.
#[derive(Debug, Clone, Copy)]
pub enum Command {
    Close,
    New,
}

/// A message from tab `id`'s page (`host`: the page's window; `owner`: ours). Replies go out through `web_view::post`.
pub fn on_message(id: EntityId, host: isize, owner: isize, text: &str) -> Option<Command> {
    let m: serde_json::Value = serde_json::from_str(text).ok()?;
    match m.get("t")?.as_str()? {
        "ready" => {
            let cols = m.get("cols").and_then(|v| v.as_u64()).unwrap_or(100).clamp(20, 500) as u16;
            let rows = m.get("rows").and_then(|v| v.as_u64()).unwrap_or(30).clamp(5, 300) as u16;
            let light = m.get("light").and_then(|v| v.as_bool()).unwrap_or(false);
            let dir = m.get("dir").and_then(|v| v.as_str()).map(PathBuf::from).filter(|d| d.is_dir()).or_else(dirs::home_dir).unwrap_or_else(|| PathBuf::from("C:\\"));
            HOSTS.with_borrow_mut(|h| h.insert(host, id));
            // (a reload starts a new shell; the old one goes with its session)
            let old = SESSIONS.with_borrow_mut(|s| s.remove(&id));
            drop(old);
            match start(host, owner, &dir, cols, rows, light) {
                Ok(s) => {
                    SESSIONS.with_borrow_mut(|all| all.insert(id, s));
                }
                Err(e) => {
                    log::warn!("terminal: {e:#}");
                    let msg = format!("\x1b[31mCouldn't start PowerShell: {e}\x1b[0m\r\n");
                    crate::web_view::post(id, &serde_json::json!({"t": "out", "d": rf_pulse::term::base64(msg.as_bytes())}).to_string());
                    crate::web_view::post(id, r#"{"t":"exit"}"#);
                }
            }
            None
        }
        "in" => {
            let d = m.get("d")?.as_str()?.to_string();
            SESSIONS.with_borrow_mut(|s| {
                if let Some(s) = s.get_mut(&id) {
                    let _ = s.writer.write_all(d.as_bytes());
                    let _ = s.writer.flush();
                    // you answered: the bell is heard
                    if let Ok(mut sh) = s.shared.lock() {
                        sh.rang = false;
                    }
                }
            });
            None
        }
        "size" => {
            let cols = m.get("cols")?.as_u64()?.clamp(20, 500) as u16;
            let rows = m.get("rows")?.as_u64()?.clamp(5, 300) as u16;
            SESSIONS.with_borrow(|s| {
                if let Some(s) = s.get(&id) {
                    let _ = s.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
                }
            });
            None
        }
        "cmd" => match m.get("v")?.as_str()? {
            "close" => Some(Command::Close),
            "new" => Some(Command::New),
            _ => None,
        },
        _ => None,
    }
}

/// The tab is gone: its shell ends.
pub fn close(id: EntityId) {
    let s = SESSIONS.with_borrow_mut(|s| s.remove(&id));
    HOSTS.with_borrow_mut(|h| h.retain(|_, v| *v != id));
    drop(s);
}

fn wake(host: isize) {
    unsafe {
        let _ = PostMessageW(Some(HWND(host as *mut _)), WAKE, WPARAM(0), LPARAM(0));
    }
}

fn shell() -> String {
    // PowerShell 7 when it is installed, else the one Windows has
    let on_path = std::env::var_os("PATH").into_iter().flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).any(|d| d.join("pwsh.exe").is_file());
    if on_path { "pwsh.exe".into() } else { "powershell.exe".into() }
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new("git").arg("-C").arg(dir).args(args).creation_flags(0x0800_0000).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn welcome(dir: &Path, light: bool) -> rf_pulse::welcome::Info {
    let items = std::fs::read_dir(dir).ok().map(|r| r.filter_map(|e| e.ok()).filter(|e| !e.file_name().to_string_lossy().starts_with('.')).count());
    let branch = git(dir, &["rev-parse", "--abbrev-ref", "HEAD"]).filter(|b| !b.is_empty());
    let (mut changed, mut ahead, mut behind) = (0, 0, 0);
    if branch.is_some() {
        if let Some(s) = git(dir, &["status", "--porcelain=v1", "--branch"]) {
            for l in s.lines() {
                if let Some(head) = l.strip_prefix("## ") {
                    let num = |key: &str| head.split(key).nth(1).and_then(|r| r.split([',', ']']).next()).and_then(|n| n.trim().parse().ok()).unwrap_or(0);
                    ahead = num("ahead ");
                    behind = num("behind ");
                } else if !l.is_empty() {
                    changed += 1;
                }
            }
        }
    }
    let commands = rf_pulse::scripts::FILES
        .iter()
        .map(|f| dir.join(f))
        .find(|f| f.is_file())
        .map(|f| rf_pulse::scripts::ranked(rf_pulse::scripts::scripts(&f)).into_iter().take(3).map(|s| s.command).collect())
        .unwrap_or_default();
    rf_pulse::welcome::Info {
        folder: dir.to_string_lossy().into_owned(),
        home: dirs::home_dir().map(|h| h.to_string_lossy().into_owned()).unwrap_or_default(),
        items,
        branch,
        changed,
        ahead,
        behind,
        commands,
        light,
        try_box: false,
        windows: true,
    }
}

fn start(host: isize, owner: isize, dir: &Path, cols: u16, rows: u16, light: bool) -> anyhow::Result<Session> {
    let info = welcome(dir, light);
    let card = rf_pulse::welcome::render(&info, cols as usize);
    let frames = rf_pulse::welcome::frames(&info, cols as usize, 1);
    let card_file = std::env::temp_dir().join(format!("pulse-card-{}-{}.txt", std::process::id(), host));
    std::fs::write(&card_file, card)?;
    let script = rf_pulse::term::powershell_init(Some(&card_file.to_string_lossy()), &[]);

    let pair = portable_pty::native_pty_system().openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })?;
    let mut cmd = CommandBuilder::new(shell());
    cmd.args(["-NoLogo", "-NoExit", "-EncodedCommand", &rf_pulse::term::encoded_command(&script)]);
    cmd.cwd(dir);
    cmd.env("TERM_PROGRAM", "PulseExplorer");
    cmd.env("COLORTERM", "truecolor");
    let child = pair.slave.spawn_command(cmd)?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;

    let shared = Arc::new(Mutex::new(Shared::default()));
    let alive = Arc::new(AtomicBool::new(true));
    {
        let (shared, alive) = (shared.clone(), alive.clone());
        std::thread::Builder::new().name("terminal-read".into()).spawn(move || {
            let (mut bells, mut titles) = (BellScanner::default(), TitleScanner::default());
            let mut tail: Vec<u8> = Vec::new();
            let mut buf = vec![0u8; 32 * 1024];
            loop {
                let n = match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                let chunk = &buf[..n];
                let rang = bells.scan(chunk);
                let said = titles.scan(chunk);
                {
                    let Ok(mut sh) = shared.lock() else { break };
                    sh.last_output = Some(Instant::now());
                    sh.rang |= rang;
                    for t in said {
                        match rf_pulse::term::title(&t) {
                            Title::Idle => {
                                sh.program = None;
                                sh.own_title = None;
                            }
                            Title::Run(p) => {
                                sh.program = Some(p);
                                sh.own_title = None;
                            }
                            // (PowerShell names the window itself while it starts: only a program's own name counts)
                            Title::Own(t) if sh.program.is_some() => sh.own_title = Some(t),
                            Title::Own(_) => {}
                        }
                    }
                    if !sh.card_seen {
                        tail.extend_from_slice(chunk);
                        if tail.windows(3).any(|w| w == "█".as_bytes()) {
                            sh.card_seen = true;
                        }
                        if tail.len() > 4096 {
                            tail.drain(..tail.len() - 16);
                        }
                    }
                    match sh.queue.last_mut() {
                        Some(Out::Bytes(b)) if b.len() < 256 * 1024 => b.extend_from_slice(chunk),
                        _ => sh.queue.push(Out::Bytes(chunk.to_vec())),
                    }
                }
                wake(host);
            }
            if let Ok(mut sh) = shared.lock() {
                sh.queue.push(Out::Exit);
            }
            alive.store(false, Ordering::Relaxed);
            wake(host);
        })?;
    }
    {
        // the status follows time too (an agent gone quiet is waiting): a beat while the shell lives
        let alive = alive.clone();
        std::thread::Builder::new().name("terminal-beat".into()).spawn(move || {
            while alive.load(Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_millis(500));
                wake(host);
            }
        })?;
    }
    let folder = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| dir.to_string_lossy().into_owned());
    Ok(Session { owner, writer, master: pair.master, child, shared, alive, folder, frames: Some(frames).filter(|f| !f.is_empty()), status: Status::Idle, shown_title: String::new() })
}

/// How a program is named in its tab.
fn pretty(program: &str) -> String {
    match program {
        "claude" | "claude-code" => "Claude Code".into(),
        "agy" | "antigravity" => "Antigravity".into(),
        "codex" => "Codex".into(),
        "gemini" => "Gemini".into(),
        "cursor-agent" => "Cursor Agent".into(),
        "copilot" => "Copilot".into(),
        p => {
            let mut c = p.chars();
            c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
        }
    }
}

/// Hands what tab `host`'s shell queued to its page (the UI thread, from the page window's procedure).
pub fn pump(host: isize) {
    let Some(id) = HOSTS.with_borrow(|h| h.get(&host).copied()) else { return };
    let mut posts: Vec<String> = Vec::new();
    let mut flash = None;
    SESSIONS.with_borrow_mut(|all| {
        let Some(s) = all.get_mut(&id) else { return };
        let Ok(mut sh) = s.shared.lock() else { return };
        for out in std::mem::take(&mut sh.queue) {
            match out {
                Out::Bytes(b) => posts.push(serde_json::json!({"t": "out", "d": rf_pulse::term::base64(&b)}).to_string()),
                Out::Exit => posts.push(r#"{"t":"exit"}"#.into()),
            }
        }
        if sh.card_seen {
            if let Some(frames) = s.frames.take() {
                posts.push(serde_json::json!({"t": "frames", "v": frames, "ms": 40, "after": 150}).to_string());
            }
        }
        let quiet = sh.last_output.map_or(f64::MAX, |t| t.elapsed().as_secs_f64());
        let status = rf_pulse::agents::status(sh.program.as_deref(), quiet, sh.rang, QUIET_AFTER, &[]);
        let name = match (&sh.program, &sh.own_title) {
            (Some(_), Some(own)) if !own.trim().is_empty() => own.trim().to_string(),
            (Some(p), _) => pretty(p),
            (None, _) => s.folder.clone(),
        };
        let shown = format!("{}{}", status.mark(), name);
        if status.notifies(s.status) {
            flash = Some(s.owner);
        }
        s.status = status;
        if shown != s.shown_title {
            s.shown_title = shown.clone();
            posts.push(serde_json::json!({"t": "title", "v": shown}).to_string());
        }
    });
    for p in posts {
        crate::web_view::post(id, &p);
    }
    if let Some(owner) = flash {
        flash_if_away(owner);
    }
}

/// An agent waiting for you, in a window that is not in front: the taskbar button flashes until the window is.
fn flash_if_away(owner: isize) {
    use windows::Win32::UI::WindowsAndMessaging::{FLASHW_TIMERNOFG, FLASHW_TRAY, FLASHWINFO, FlashWindowEx, GetForegroundWindow};
    let hwnd = HWND(owner as *mut _);
    unsafe {
        if GetForegroundWindow() == hwnd {
            return;
        }
        let info = FLASHWINFO { cbSize: std::mem::size_of::<FLASHWINFO>() as u32, hwnd, dwFlags: FLASHW_TRAY | FLASHW_TIMERNOFG, uCount: 0, dwTimeout: 0 };
        let _ = FlashWindowEx(&info);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_carry_the_folder() {
        let d = Path::new(r"C:\Users\Ana Lí\code & co");
        let u = url_for(d);
        assert!(is_terminal(&u));
        assert!(!u.contains(' '));
        assert_eq!(dir_of(&u).as_deref(), Some(d));
        assert!(dir_of("https://example.com/?dir=C%3A%5C").is_none());
    }
}
