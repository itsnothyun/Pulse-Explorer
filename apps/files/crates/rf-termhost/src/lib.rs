//! Pulse Explorer's terminal session host (the Windows counterpart of the Mac app's tmux sessions, TerminalSessions.swift).
//!
//! A small program of its own (`pulse-termhost`) owns the terminals: each session is a shell in a pseudo-terminal (ConPTY on
//! Windows), with the tail of its output kept. The file manager is only a viewer, connected over a local socket (a named
//! pipe on Windows). When the file manager quits or crashes, the host and its shells (Claude Code and the other agents in
//! them included) keep running; when it comes back it connects again, asks which sessions there are, and attaches to them:
//! the kept output is replayed and the terminal is resized once, which makes full-screen programs draw themselves again.
//!
//! One viewer at a time (a new connection takes over: the file manager after a crash). The host ends itself when it has no
//! session and no viewer for a while. A session ends when its shell exits or when the viewer closes it (its tab closed).
//!
//! The wire: frames of `[u32 little-endian length][u8 kind][payload]`; JSON for the requests and answers, raw bytes for the
//! input and output (prefixed by the session id's length and the id).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result};
use interprocess::local_socket::prelude::*;
use interprocess::local_socket::{GenericFilePath, GenericNamespaced, ListenerOptions, Name, Stream};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};

/// The output kept per session for a viewer that attaches later.
pub const RING: usize = 256 * 1024;

// ------------------------------------------------------------------------------------------------ wire

const OPEN: u8 = 1;
const INPUT: u8 = 2;
const RESIZE: u8 = 3;
const CLOSE: u8 = 4;
const LIST: u8 = 5;
const OUTPUT: u8 = 10;
const EXIT: u8 = 11;
const OPENED: u8 = 12;
const SESSIONS: u8 = 13;

/// What a new session runs, and where.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Open {
    pub id: String,
    pub dir: String,
    pub cols: u16,
    pub rows: u16,
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionInfo {
    pub id: String,
    /// The folder it started in.
    pub dir: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Output { id: String, data: Vec<u8> },
    Exit { id: String },
    /// The answer to an open: `attached` when the session was already running (its kept output follows).
    Opened { id: String, attached: bool },
    Sessions(Vec<SessionInfo>),
    /// The host went away.
    Disconnected,
}

fn write_frame(w: &mut dyn Write, kind: u8, payload: &[u8]) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(5 + payload.len());
    buf.extend_from_slice(&((payload.len() + 1) as u32).to_le_bytes());
    buf.push(kind);
    buf.extend_from_slice(payload);
    w.write_all(&buf)?;
    w.flush()
}

fn read_frame(r: &mut impl Read) -> std::io::Result<(u8, Vec<u8>)> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len)?;
    let len = u32::from_le_bytes(len) as usize;
    if len == 0 || len > 64 << 20 {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "bad frame"));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    let kind = buf.remove(0);
    Ok((kind, buf))
}

fn with_id(id: &str, data: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(1 + id.len() + data.len());
    v.push(id.len().min(255) as u8);
    v.extend_from_slice(&id.as_bytes()[..id.len().min(255)]);
    v.extend_from_slice(data);
    v
}

fn split_id(p: &[u8]) -> Option<(String, &[u8])> {
    let n = *p.first()? as usize;
    let id = std::str::from_utf8(p.get(1..1 + n)?).ok()?.to_string();
    Some((id, &p[1 + n..]))
}

/// The socket's name for `name`: a named pipe on Windows, a file in the temporary folder elsewhere.
fn socket_name(name: &str) -> Result<Name<'static>> {
    if GenericNamespaced::is_supported() && cfg!(windows) {
        Ok(name.to_string().to_ns_name::<GenericNamespaced>()?)
    } else {
        let path = std::env::temp_dir().join(format!("{name}.sock"));
        Ok(path.to_fs_name::<GenericFilePath>()?.into_owned())
    }
}

/// The host's name for this user (one host per user).
pub fn default_name() -> String {
    let user = std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_else(|_| "user".into());
    let user: String = user.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    format!("pulse-termhost-{user}")
}

/// One connection, read on one thread and written on another (`&Stream` reads and writes).
#[derive(Clone)]
struct Shared(Arc<Stream>);
impl Read for Shared {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        (&*self.0).read(buf)
    }
}
impl Write for Shared {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        (&*self.0).write(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        (&*self.0).flush()
    }
}

// ------------------------------------------------------------------------------------------------ host

struct Session {
    dir: String,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    ring: Arc<Mutex<Vec<u8>>>,
}

type Sender = Arc<Mutex<Option<(u64, Box<dyn Write + Send>)>>>;

struct Host {
    sessions: Mutex<HashMap<String, Session>>,
    /// The viewer connected now: its number and its sending half.
    viewer: Sender,
    last_seen: Mutex<Instant>,
}

impl Host {
    fn send(&self, kind: u8, payload: &[u8]) {
        let mut v = self.viewer.lock().unwrap();
        if let Some((_, w)) = v.as_mut() {
            if write_frame(w, kind, payload).is_err() {
                *v = None;
            }
        }
    }
}

fn push_ring(ring: &Mutex<Vec<u8>>, data: &[u8]) {
    let mut r = ring.lock().unwrap();
    r.extend_from_slice(data);
    if r.len() > RING {
        let mut cut = r.len() - RING;
        // (at a line start, so a replay does not begin in the middle of an escape sequence)
        if let Some(nl) = r[cut..].iter().position(|&b| b == b'\n') {
            cut += nl + 1;
        }
        r.drain(..cut);
    }
}

/// Runs the host until it has had no session and no viewer for `idle` (blocks).
pub fn run_host(name: &str, idle: Duration) -> Result<()> {
    let listener = ListenerOptions::new().name(socket_name(name)?).try_overwrite(true).create_sync().context("listen")?;
    let host = Arc::new(Host { sessions: Mutex::new(HashMap::new()), viewer: Arc::new(Mutex::new(None)), last_seen: Mutex::new(Instant::now()) });
    {
        let host = host.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(500));
            let empty = host.sessions.lock().unwrap().is_empty();
            let viewer = host.viewer.lock().unwrap().is_some();
            if viewer || !empty {
                *host.last_seen.lock().unwrap() = Instant::now();
            } else if host.last_seen.lock().unwrap().elapsed() >= idle {
                std::process::exit(0);
            }
        });
    }
    let mut serial = 0u64;
    for conn in listener.incoming() {
        let Ok(conn) = conn else { continue };
        serial += 1;
        let me = serial;
        let (recv, send) = { let c = Shared(Arc::new(conn)); (c.clone(), c) };
        // a new viewer takes over (the file manager again, after a crash)
        *host.viewer.lock().unwrap() = Some((me, Box::new(send)));
        let host = host.clone();
        std::thread::spawn(move || {
            let mut recv = recv;
            while let Ok((kind, payload)) = read_frame(&mut recv) {
                handle(&host, kind, &payload);
            }
            let mut v = host.viewer.lock().unwrap();
            if v.as_ref().is_some_and(|(n, _)| *n == me) {
                *v = None;
            }
        });
    }
    Ok(())
}

fn handle(host: &Arc<Host>, kind: u8, payload: &[u8]) {
    match kind {
        OPEN => {
            let Ok(o) = serde_json::from_slice::<Open>(payload) else { return };
            let running = host.sessions.lock().unwrap().contains_key(&o.id);
            if running {
                host.send(OPENED, &serde_json::to_vec(&serde_json::json!({"id": o.id, "attached": true})).unwrap());
                let kept = host.sessions.lock().unwrap().get(&o.id).map(|s| s.ring.lock().unwrap().clone()).unwrap_or_default();
                if !kept.is_empty() {
                    host.send(OUTPUT, &with_id(&o.id, &kept));
                }
                // a size change makes the terminal and the full-screen programs in it draw everything again
                if let Some(s) = host.sessions.lock().unwrap().get(&o.id) {
                    let _ = s.master.resize(PtySize { rows: o.rows.max(2), cols: o.cols.saturating_sub(1).max(2), pixel_width: 0, pixel_height: 0 });
                    let _ = s.master.resize(PtySize { rows: o.rows, cols: o.cols, pixel_width: 0, pixel_height: 0 });
                }
                return;
            }
            match spawn(&o) {
                Ok((s, reader)) => {
                    host.sessions.lock().unwrap().insert(o.id.clone(), s);
                    // the answer first, then the shell's output (the viewer puts the saved history before it)
                    host.send(OPENED, &serde_json::to_vec(&serde_json::json!({"id": o.id, "attached": false})).unwrap());
                    let ring = host.sessions.lock().unwrap().get(&o.id).map(|s| s.ring.clone());
                    if let Some(ring) = ring {
                        read_session(host.clone(), o.id.clone(), ring, reader);
                    }
                }
                Err(e) => {
                    let msg = format!("\x1b[31mCouldn't start the shell: {e:#}\x1b[0m\r\n");
                    host.send(OUTPUT, &with_id(&o.id, msg.as_bytes()));
                    host.send(EXIT, &serde_json::to_vec(&serde_json::json!({"id": o.id})).unwrap());
                }
            }
        }
        INPUT => {
            let Some((id, data)) = split_id(payload) else { return };
            if let Some(s) = host.sessions.lock().unwrap().get_mut(&id) {
                let _ = s.writer.write_all(data);
                let _ = s.writer.flush();
            }
        }
        RESIZE => {
            #[derive(Deserialize)]
            struct R {
                id: String,
                cols: u16,
                rows: u16,
            }
            let Ok(r) = serde_json::from_slice::<R>(payload) else { return };
            if let Some(s) = host.sessions.lock().unwrap().get(&r.id) {
                let _ = s.master.resize(PtySize { rows: r.rows, cols: r.cols, pixel_width: 0, pixel_height: 0 });
            }
        }
        CLOSE => {
            #[derive(Deserialize)]
            struct C {
                id: String,
            }
            let Ok(c) = serde_json::from_slice::<C>(payload) else { return };
            if let Some(mut s) = host.sessions.lock().unwrap().remove(&c.id) {
                let _ = s.child.kill();
            }
        }
        LIST => {
            let list: Vec<SessionInfo> = host.sessions.lock().unwrap().iter().map(|(id, s)| SessionInfo { id: id.clone(), dir: s.dir.clone() }).collect();
            host.send(SESSIONS, &serde_json::to_vec(&list).unwrap());
        }
        _ => {}
    }
}

fn spawn(o: &Open) -> Result<(Session, Box<dyn Read + Send>)> {
    let pair = portable_pty::native_pty_system().openpty(PtySize { rows: o.rows.max(2), cols: o.cols.max(2), pixel_width: 0, pixel_height: 0 })?;
    let mut cmd = CommandBuilder::new(&o.program);
    cmd.args(&o.args);
    if Path::new(&o.dir).is_dir() {
        cmd.cwd(&o.dir);
    }
    for (k, v) in &o.env {
        cmd.env(k, v);
    }
    let child = pair.slave.spawn_command(cmd)?;
    drop(pair.slave);
    let reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;
    let ring = Arc::new(Mutex::new(Vec::new()));
    Ok((Session { dir: o.dir.clone(), master: pair.master, writer, child, ring }, reader))
}

/// The session's output: kept, and sent to the viewer while there is one; its end when the shell exits.
fn read_session(host: Arc<Host>, id: String, ring: Arc<Mutex<Vec<u8>>>, mut reader: Box<dyn Read + Send>) {
    let _ = std::thread::Builder::new().name(format!("session-{id}")).spawn(move || {
        let mut buf = vec![0u8; 32 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    push_ring(&ring, &buf[..n]);
                    host.send(OUTPUT, &with_id(&id, &buf[..n]));
                }
            }
        }
        if let Some(mut s) = host.sessions.lock().unwrap().remove(&id) {
            let _ = s.child.wait();
        }
        host.send(EXIT, &serde_json::to_vec(&serde_json::json!({"id": id})).unwrap());
    });
}

// ------------------------------------------------------------------------------------------------ viewer

/// The file manager's side: requests go out through it (from any thread); events come in on the receiver `connect` gives.
pub struct Client {
    send: Mutex<Box<dyn Write + Send>>,
    alive: Arc<AtomicBool>,
}

pub type Events = mpsc::Receiver<Event>;

impl Client {
    pub fn connect(name: &str) -> Result<(Client, Events)> {
        let conn = Stream::connect(socket_name(name)?)?;
        let (recv, send) = { let c = Shared(Arc::new(conn)); (c.clone(), c) };
        let (tx, events) = mpsc::channel();
        let alive = Arc::new(AtomicBool::new(true));
        {
            let alive = alive.clone();
            std::thread::Builder::new().name("termhost-events".into()).spawn(move || {
                let mut recv = recv;
                while let Ok((kind, p)) = read_frame(&mut recv) {
                    let ev = match kind {
                        OUTPUT => split_id(&p).map(|(id, d)| Event::Output { id, data: d.to_vec() }),
                        EXIT => serde_json::from_slice::<serde_json::Value>(&p).ok().and_then(|v| Some(Event::Exit { id: v.get("id")?.as_str()?.to_string() })),
                        OPENED => serde_json::from_slice::<serde_json::Value>(&p).ok().and_then(|v| {
                            Some(Event::Opened { id: v.get("id")?.as_str()?.to_string(), attached: v.get("attached")?.as_bool()? })
                        }),
                        SESSIONS => serde_json::from_slice(&p).ok().map(Event::Sessions),
                        _ => None,
                    };
                    if let Some(ev) = ev {
                        if tx.send(ev).is_err() {
                            break;
                        }
                    }
                }
                alive.store(false, Ordering::Relaxed);
                let _ = tx.send(Event::Disconnected);
            })?;
        }
        Ok((Client { send: Mutex::new(Box::new(send)), alive }, events))
    }

    /// Connects to the host, starting `host_exe` first when none runs (detached: it outlives the caller).
    pub fn connect_or_start(name: &str, host_exe: &Path) -> Result<(Client, Events)> {
        if let Ok(c) = Self::connect(name) {
            return Ok(c);
        }
        start_detached(host_exe, name)?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match Self::connect(name) {
                Ok(c) => return Ok(c),
                Err(e) if Instant::now() >= deadline => return Err(e.context("the terminal host did not start")),
                Err(_) => std::thread::sleep(Duration::from_millis(50)),
            }
        }
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }

    fn send(&self, kind: u8, payload: &[u8]) -> Result<()> {
        write_frame(&mut **self.send.lock().unwrap(), kind, payload).context("terminal host")
    }

    /// Opens session `o.id`, or attaches to it when it is already running.
    pub fn open(&self, o: &Open) -> Result<()> {
        self.send(OPEN, &serde_json::to_vec(o)?)
    }
    pub fn input(&self, id: &str, data: &[u8]) -> Result<()> {
        self.send(INPUT, &with_id(id, data))
    }
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        self.send(RESIZE, &serde_json::to_vec(&serde_json::json!({"id": id, "cols": cols, "rows": rows}))?)
    }
    /// Ends session `id` (its tab was closed).
    pub fn close(&self, id: &str) -> Result<()> {
        self.send(CLOSE, &serde_json::to_vec(&serde_json::json!({"id": id}))?)
    }
    /// Asks which sessions run (answered by an `Event::Sessions`).
    pub fn list(&self) -> Result<()> {
        self.send(LIST, b"{}")
    }
}

/// Starts the host as a process of its own: no console window, not in the caller's job (on Windows a crashed parent's job
/// would otherwise take it along), its own process group elsewhere.
pub fn start_detached(host_exe: &Path, name: &str) -> Result<()> {
    let mut cmd = std::process::Command::new(host_exe);
    cmd.arg("--serve").arg(name).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB);
        if cmd.spawn().is_ok() {
            return Ok(());
        }
        // (a job that forbids breaking away: started inside it, still detached from the console)
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.spawn().context("start the terminal host")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip() {
        let mut buf = Vec::new();
        write_frame(&mut buf, OUTPUT, &with_id("tab-1", b"hello")).unwrap();
        let (kind, p) = read_frame(&mut buf.as_slice()).unwrap();
        assert_eq!(kind, OUTPUT);
        let (id, data) = split_id(&p).unwrap();
        assert_eq!((id.as_str(), data), ("tab-1", &b"hello"[..]));
    }

    #[test]
    fn the_ring_keeps_the_tail_from_a_line_start() {
        let ring = Mutex::new(Vec::new());
        for i in 0..20_000 {
            push_ring(&ring, format!("line {i}\r\n").as_bytes());
        }
        let r = ring.lock().unwrap();
        assert!(r.len() <= RING);
        assert!(r.starts_with(b"line "), "starts at a line start");
        assert!(r.ends_with(b"line 19999\r\n"));
    }
}
