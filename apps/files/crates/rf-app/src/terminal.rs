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

/// The address of a new terminal tab in `dir`; `s` is the tab's own key (its kept history, see [`history_file`]).
pub fn url_for(dir: &Path) -> String {
    let key = format!("{:x}{:04x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_micros()), rand_bits());
    format!("https://{HOST}/index.html?dir={}&s={key}", encode(&dir.to_string_lossy()))
}

/// The address of terminal tab `key` in `dir` (a terminal the host kept, opened again as a tab).
pub fn url_for_key(dir: &Path, key: &str) -> String {
    format!("https://{HOST}/index.html?dir={}&s={key}", encode(&dir.to_string_lossy()))
}

/// The key in a terminal tab's address (its hosted terminal's name).
pub fn key_of(url: &str) -> Option<String> {
    if !is_terminal(url) {
        return None;
    }
    let q = url.split_once('?')?.1;
    q.split('&').find_map(|kv| kv.strip_prefix("s=")).map(str::to_string).filter(|k| !k.is_empty())
}

fn rand_bits() -> u16 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u32(std::process::id());
    h.finish() as u16
}

/// Where a tab's output is kept between runs of the app (the last 256 KB), by its key; None for a key that is not ours.
fn history_file(key: &str) -> Option<PathBuf> {
    if key.is_empty() || key.len() > 40 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(crate::settings::app_dir()?.join("TerminalHistory").join(format!("{key}.bin")))
}

/// History of tabs nobody opened for a week goes (a closed tab's stays until then: the app cannot tell closing a tab from
/// quitting).
fn prune_history() {
    let Some(dir) = crate::settings::app_dir().map(|d| d.join("TerminalHistory")) else { return };
    let week = std::time::Duration::from_secs(7 * 86_400);
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        if e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > week) {
            let _ = std::fs::remove_file(e.path());
        }
    }
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
        std::thread::spawn(prune_history);
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
//
// A terminal runs in one of two places. Hosted (the usual): in `pulse-termhost.exe` (rf-termhost), a process of its own that
// keeps the shell running when this app quits or crashes; the tab that comes back attaches to it again by its key (the `s` in
// its address), and terminals no tab shows are opened as tabs at the next start (`orphans`). Local: in a ConPTY of this
// process, as before, when the host cannot be started (its file missing); it ends with the app.

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
    /// Attached to a terminal that was already running: no card of ours to animate.
    reattached: bool,
    /// The tail of the output, kept on disk for the next run (`dirty`: not written yet).
    ring: Option<rf_pulse::agents::Ring>,
    dirty: bool,
}

/// What reading the output keeps from one chunk to the next.
#[derive(Default)]
struct Scan {
    bells: BellScanner,
    titles: TitleScanner,
    tail: Vec<u8>,
}

/// One chunk of a shell's output: the agent status (titles, the bell), the card's arrival, the kept tail, and the queue for
/// the page.
fn take_output(sh: &mut Shared, scan: &mut Scan, chunk: &[u8]) {
    let rang = scan.bells.scan(chunk);
    let said = scan.titles.scan(chunk);
    sh.last_output = Some(Instant::now());
    if let Some(r) = sh.ring.as_mut() {
        r.push(chunk);
        sh.dirty = true;
    }
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
        scan.tail.extend_from_slice(chunk);
        if scan.tail.windows(3).any(|w| w == "█".as_bytes()) {
            sh.card_seen = true;
        }
        if scan.tail.len() > 4096 {
            let cut = scan.tail.len() - 16;
            scan.tail.drain(..cut);
        }
    }
    match sh.queue.last_mut() {
        Some(Out::Bytes(b)) if b.len() < 256 * 1024 => b.extend_from_slice(chunk),
        _ => sh.queue.push(Out::Bytes(chunk.to_vec())),
    }
}

enum Backend {
    Local { writer: Box<dyn Write + Send>, master: Box<dyn MasterPty + Send>, child: Box<dyn Child + Send + Sync> },
    Hosted { key: String },
}

struct Session {
    owner: isize,
    backend: Backend,
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
        match &mut self.backend {
            // (a local shell goes with its tab; a hosted one stays with the host until its tab is closed: `end`)
            Backend::Local { child, .. } => {
                let _ = child.kill();
            }
            Backend::Hosted { key } => {
                if let Some(l) = LINK.lock().unwrap().as_ref() {
                    l.routes.lock().unwrap().remove(key);
                }
            }
        }
    }
}

thread_local! {
    static SESSIONS: RefCell<HashMap<EntityId, Session>> = RefCell::new(HashMap::new());
    /// A page's window → its tab (for [`WAKE`]).
    static HOSTS: RefCell<HashMap<isize, EntityId>> = RefCell::new(HashMap::new());
}

// ---------------------------------------------------------------------------------------------------------------
// the host (rf-termhost)

/// Where a hosted terminal's output goes: its tab's page.
struct Route {
    shared: Arc<Mutex<Shared>>,
    scan: Mutex<Scan>,
    host: isize,
    alive: Arc<AtomicBool>,
    /// The kept output of an earlier run, shown first when the host starts this terminal afresh (not when it attaches).
    history: Option<PathBuf>,
    rows: u16,
    /// The welcome card's file, which the start-up script removes; left over when the terminal was attached instead.
    card: Option<PathBuf>,
}

struct Link {
    client: rf_termhost::Client,
    routes: Mutex<HashMap<String, Arc<Route>>>,
    /// Someone waiting for the answer to a `list`.
    listing: Mutex<Option<std::sync::mpsc::Sender<Vec<rf_termhost::SessionInfo>>>>,
}

static LINK: Mutex<Option<Arc<Link>>> = Mutex::new(None);

fn host_exe() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?.parent()?.join("pulse-termhost.exe");
    exe.is_file().then_some(exe)
}

/// The connection to the host: made (the host started) when none is open; None when the host cannot be had (its file
/// missing), and terminals then run here.
fn link() -> Option<Arc<Link>> {
    link_with(true)
}

/// `start`: start the host when none runs (a terminal opening); else only connect to one that runs (asking what it keeps).
fn link_with(start: bool) -> Option<Arc<Link>> {
    let mut slot = LINK.lock().unwrap();
    if let Some(l) = slot.as_ref().filter(|l| l.client.is_alive()) {
        return Some(l.clone());
    }
    let exe = host_exe()?;
    let name = rf_termhost::default_name();
    let made = if start { rf_termhost::Client::connect_or_start(&name, &exe) } else { rf_termhost::Client::connect(&name) };
    let (client, events) = match made {
        Ok(c) => c,
        Err(e) => {
            if start {
                log::warn!("terminal host: {e:#}");
            }
            return None;
        }
    };
    let link = Arc::new(Link { client, routes: Mutex::new(HashMap::new()), listing: Mutex::new(None) });
    let l2 = link.clone();
    let _ = std::thread::Builder::new().name("terminal-host-events".into()).spawn(move || dispatch(l2, events));
    *slot = Some(link.clone());
    Some(link)
}

/// The host's events, handed to the tabs' pages (off the UI thread; the page's window is woken for each).
fn dispatch(link: Arc<Link>, events: rf_termhost::Events) {
    use rf_termhost::Event;
    for ev in events {
        match ev {
            Event::Output { id, data } => {
                let Some(r) = link.routes.lock().unwrap().get(&id).cloned() else { continue };
                if let (Ok(mut sh), Ok(mut scan)) = (r.shared.lock(), r.scan.lock()) {
                    take_output(&mut sh, &mut scan, &data);
                }
                wake(r.host);
            }
            Event::Opened { id, attached } => {
                let Some(r) = link.routes.lock().unwrap().get(&id).cloned() else { continue };
                if attached {
                    // the host replays what it kept; the card of the start that did not happen is not needed
                    if let Some(c) = &r.card {
                        let _ = std::fs::remove_file(c);
                    }
                    if let Ok(mut sh) = r.shared.lock() {
                        sh.reattached = true;
                    }
                } else if let Some(b) = r.history.as_ref().and_then(|f| restored(f, r.rows)) {
                    // a fresh start: the last run's output first (pushed up into the scrollback), then the shell
                    if let Ok(mut sh) = r.shared.lock() {
                        sh.queue.insert(0, Out::Bytes(b));
                    }
                }
                wake(r.host);
            }
            Event::Exit { id } => {
                let Some(r) = link.routes.lock().unwrap().remove(&id) else { continue };
                if let Ok(mut sh) = r.shared.lock() {
                    sh.queue.push(Out::Exit);
                }
                r.alive.store(false, Ordering::Relaxed);
                wake(r.host);
            }
            Event::Sessions(list) => {
                if let Some(tx) = link.listing.lock().unwrap().take() {
                    let _ = tx.send(list);
                }
            }
            Event::Disconnected => break,
        }
    }
    // the host is gone (it should not be): the tabs show their shells ended; the next terminal starts a host again
    for (_, r) in link.routes.lock().unwrap().drain() {
        if let Ok(mut sh) = r.shared.lock() {
            sh.queue.push(Out::Exit);
        }
        r.alive.store(false, Ordering::Relaxed);
        wake(r.host);
    }
    let mut slot = LINK.lock().unwrap();
    if slot.as_ref().is_some_and(|l| Arc::ptr_eq(l, &link)) {
        *slot = None;
    }
}

/// The kept output of an earlier run as the page shows it: then a quiet line, pushed up into the scrollback (the shell clears
/// the screen as it starts), the cursor back on the top line (the card's pulse line is drawn at fixed rows).
fn restored(file: &Path, rows: u16) -> Option<Vec<u8>> {
    let saved = std::fs::read(file).ok().filter(|b| !b.is_empty())?;
    let mut b = rf_pulse::agents::Ring::replay(&saved);
    b.extend_from_slice(b"\r\n\x1b[2m\xe2\x94\x80\xe2\x94\x80 restored from the last session \xe2\x94\x80\xe2\x94\x80\x1b[0m");
    b.extend(std::iter::repeat_n(b"\r\n".as_slice(), rows as usize).flatten());
    b.extend_from_slice(b"\x1b[H");
    Some(b)
}

/// The terminals the host keeps that no tab in `shown` (their keys) shows: (key, folder), to open as tabs after a restart.
/// Blocks for the host's answer (a second at most): call it off the UI thread.
pub fn orphans(shown: &[String]) -> Vec<(String, PathBuf)> {
    // (no host running: nothing kept, and none is started just to ask; the app's own connection otherwise: the host takes
    // one viewer, a second connection would push the first one out)
    let Some(link) = link_with(false) else { return vec![] };
    let (tx, rx) = std::sync::mpsc::channel();
    *link.listing.lock().unwrap() = Some(tx);
    if link.client.list().is_err() {
        return vec![];
    }
    let list = rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap_or_default();
    list.into_iter().filter(|s| !shown.contains(&s.id)).map(|s| (s.id, PathBuf::from(s.dir))).collect()
}

/// The tab was closed by the user: its terminal ends (a hosted one is told to the host; a window closing, the app quitting
/// or crashing leave hosted terminals running).
pub fn end(id: EntityId) {
    let key = SESSIONS.with_borrow(|s| match s.get(&id).map(|s| &s.backend) {
        Some(Backend::Hosted { key }) => Some(key.clone()),
        _ => None,
    });
    if let (Some(key), Some(l)) = (key, LINK.lock().unwrap().clone()) {
        let _ = l.client.close(&key);
    }
    close(id);
}

// ---------------------------------------------------------------------------------------------------------------

/// Something the page asked of the app.
#[derive(Debug, Clone, Copy)]
pub enum Command {
    Close,
    New,
    /// The Agents panel (Ctrl+Shift+A).
    Agents,
}

/// A message from tab `id`'s page (`host`: the page's window; `owner`: ours). Replies go out through `web_view::post`.
pub fn on_message(id: EntityId, host: isize, owner: isize, text: &str) -> Option<Command> {
    let m: serde_json::Value = serde_json::from_str(text).ok()?;
    match m.get("t")?.as_str()? {
        "ready" => {
            let cols = m.get("cols").and_then(|v| v.as_u64()).unwrap_or(100).clamp(20, 500) as u16;
            let rows = m.get("rows").and_then(|v| v.as_u64()).unwrap_or(30).clamp(5, 300) as u16;
            let light = m.get("light").and_then(|v| v.as_bool()).unwrap_or(false);
            let key = m.get("key").and_then(|v| v.as_str()).filter(|k| history_file(k).is_some()).map(str::to_string);
            let history = key.as_deref().and_then(history_file);
            let dir = m.get("dir").and_then(|v| v.as_str()).map(PathBuf::from).filter(|d| d.is_dir()).or_else(dirs::home_dir).unwrap_or_else(|| PathBuf::from("C:\\"));
            HOSTS.with_borrow_mut(|h| h.insert(host, id));
            // (a reload starts a new shell; the old one goes with its session)
            let old = SESSIONS.with_borrow_mut(|s| s.remove(&id));
            drop(old);
            // hosted under the tab's key (it outlives this app), else here; a page without a key gets one for this run
            let key = key.unwrap_or_else(|| format!("{:x}{:04x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_micros()), rand_bits()));
            let hosted = link();
            if hosted.is_none() {
                // (here, the last run's output is shown first; a hosted terminal shows it when the host starts it afresh)
                if let Some(b) = history.as_ref().and_then(|f| restored(f, rows)) {
                    crate::web_view::post(id, &serde_json::json!({"t": "out", "d": rf_pulse::term::base64(&b)}).to_string());
                }
            }
            match start(host, owner, &dir, cols, rows, light, history, hosted.map(|l| (l, key))) {
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
                    match &mut s.backend {
                        Backend::Local { writer, .. } => {
                            let _ = writer.write_all(d.as_bytes());
                            let _ = writer.flush();
                        }
                        Backend::Hosted { key } => {
                            if let Some(l) = LINK.lock().unwrap().clone() {
                                let _ = l.client.input(key, d.as_bytes());
                            }
                        }
                    }
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
                    match &s.backend {
                        Backend::Local { master, .. } => {
                            let _ = master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
                        }
                        Backend::Hosted { key } => {
                            if let Some(l) = LINK.lock().unwrap().clone() {
                                let _ = l.client.resize(key, cols, rows);
                            }
                        }
                    }
                }
            });
            None
        }
        "cmd" => match m.get("v")?.as_str()? {
            "close" => Some(Command::Close),
            "new" => Some(Command::New),
            "agents" => Some(Command::Agents),
            _ => None,
        },
        _ => None,
    }
}

/// A terminal tab as the Agents panel lists it.
pub struct Running {
    pub id: EntityId,
    pub status: Status,
    /// What the tab is called (the agent's name, or the folder's at the prompt).
    pub name: String,
    pub folder: String,
    pub alive: bool,
}

/// Every terminal tab of window `owner`: agents waiting for you first, then working ones, then the rest.
pub fn running(owner: isize) -> Vec<Running> {
    let mut v: Vec<Running> = SESSIONS.with_borrow(|all| {
        all.iter()
            .filter(|(_, s)| s.owner == owner)
            .map(|(id, s)| Running {
                id: *id,
                status: s.status,
                name: s.shown_title.trim_start_matches(s.status.mark()).to_string(),
                folder: s.folder.clone(),
                alive: s.alive.load(Ordering::Relaxed),
            })
            .collect()
    });
    let rank = |s: Status| match s {
        Status::Waiting => 0,
        Status::Working => 1,
        Status::Running => 2,
        Status::Idle => 3,
    };
    v.sort_by(|a, b| rank(a.status).cmp(&rank(b.status)).then_with(|| a.name.cmp(&b.name)));
    v
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

#[allow(clippy::too_many_arguments)]
fn start(host: isize, owner: isize, dir: &Path, cols: u16, rows: u16, light: bool, history: Option<PathBuf>, hosted: Option<(Arc<Link>, String)>) -> anyhow::Result<Session> {
    let info = welcome(dir, light);
    let card = rf_pulse::welcome::render(&info, cols as usize);
    let frames = rf_pulse::welcome::frames(&info, cols as usize, 1);
    let card_file = std::env::temp_dir().join(format!("pulse-card-{}-{}.txt", std::process::id(), host));
    std::fs::write(&card_file, card)?;
    let script = rf_pulse::term::powershell_init(Some(&card_file.to_string_lossy()), &[]);
    let program = shell();
    let args = vec!["-NoLogo".to_string(), "-NoExit".into(), "-EncodedCommand".into(), rf_pulse::term::encoded_command(&script)];
    let env = vec![("TERM_PROGRAM".to_string(), "PulseExplorer".to_string()), ("COLORTERM".into(), "truecolor".into())];

    let shared = Arc::new(Mutex::new(Shared { ring: history.is_some().then(|| rf_pulse::agents::Ring::new(256 * 1024)), ..Default::default() }));
    let alive = Arc::new(AtomicBool::new(true));
    let folder = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| dir.to_string_lossy().into_owned());
    let frames = Some(frames).filter(|f| !f.is_empty());

    let backend = if let Some((link, key)) = hosted {
        // the host's: the route first (its answer and output may come at once), then the request
        let route = Arc::new(Route {
            shared: shared.clone(),
            scan: Mutex::new(Scan::default()),
            host,
            alive: alive.clone(),
            history: history.clone(),
            rows,
            card: Some(card_file.clone()),
        });
        link.routes.lock().unwrap().insert(key.clone(), route);
        let open = rf_termhost::Open { id: key.clone(), dir: dir.to_string_lossy().into_owned(), cols, rows, program, args, env };
        if let Err(e) = link.client.open(&open) {
            link.routes.lock().unwrap().remove(&key);
            return Err(e);
        }
        Backend::Hosted { key }
    } else {
        let pair = portable_pty::native_pty_system().openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })?;
        let mut cmd = CommandBuilder::new(program);
        cmd.args(&args);
        cmd.cwd(dir);
        for (k, v) in &env {
            cmd.env(k, v);
        }
        let child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let (shared, alive) = (shared.clone(), alive.clone());
        std::thread::Builder::new().name("terminal-read".into()).spawn(move || {
            let mut scan = Scan::default();
            let mut buf = vec![0u8; 32 * 1024];
            loop {
                let n = match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                {
                    let Ok(mut sh) = shared.lock() else { break };
                    take_output(&mut sh, &mut scan, &buf[..n]);
                }
                wake(host);
            }
            if let Ok(mut sh) = shared.lock() {
                sh.queue.push(Out::Exit);
            }
            alive.store(false, Ordering::Relaxed);
            wake(host);
        })?;
        Backend::Local { writer, master: pair.master, child }
    };
    beat(host, alive.clone(), shared.clone(), history);
    Ok(Session { owner, backend, shared, alive, folder, frames, status: Status::Idle, shown_title: String::new() })
}

/// The status follows time too (an agent gone quiet is waiting): a beat while the shell lives. And the kept output is
/// written now and then (off the UI thread), once more when the shell ends.
fn beat(host: isize, alive: Arc<AtomicBool>, shared: Arc<Mutex<Shared>>, history: Option<PathBuf>) {
    let _ = std::thread::Builder::new().name("terminal-beat".into()).spawn(move || {
        let mut since_save = 0u32;
        loop {
            let live = alive.load(Ordering::Relaxed);
            std::thread::sleep(std::time::Duration::from_millis(500));
            wake(host);
            since_save += 1;
            if since_save >= 6 || !live {
                since_save = 0;
                let bytes = shared.lock().ok().and_then(|mut sh| {
                    let dirty = std::mem::take(&mut sh.dirty);
                    sh.ring.as_ref().filter(|_| dirty).map(|r| r.bytes().to_vec())
                });
                if let (Some(b), Some(f)) = (bytes, history.as_ref()) {
                    if let Some(d) = f.parent() {
                        let _ = std::fs::create_dir_all(d);
                    }
                    let _ = std::fs::write(f, b);
                }
            }
            if !live {
                break;
            }
        }
    });
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
        // (no pulse line over a terminal that was already running: its screen is not our card)
        if sh.reattached {
            s.frames = None;
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
        assert!(u.contains("&s="));
        let key = u.rsplit("&s=").next().unwrap();
        assert!(key.bytes().all(|b| b.is_ascii_hexdigit()));
        // a kept terminal opened again as a tab: the same key, read back from its address
        assert_eq!(key_of(&u).as_deref(), Some(key));
        let again = url_for_key(d, key);
        assert_eq!(key_of(&again).as_deref(), Some(key));
        assert_eq!(dir_of(&again).as_deref(), Some(d));
        assert!(key_of("https://example.com/?s=abc").is_none());
    }
}
