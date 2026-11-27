//! The host's promise, end to end with the real binary and a real shell: a session outlives its viewer (the file manager
//! crashing: here a viewer process that just exits), is listed and attached again with its output by the next viewer,
//! keeps taking input, ends when closed, and the host then ends itself.
//!
//! Each viewer is a process of its own (this test binary run again for one of the `viewer_*` steps), as the file manager
//! is: its connection goes when it exits, which is what the host has to survive.

use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use rf_termhost::{Client, Event, Events, Open};

/// Waits for an event `done` accepts, answering the terminal's questions as a terminal does: ConPTY asks where the cursor
/// is (`ESC [6n`) when a shell starts, and waits for the answer (xterm.js gives it in the app).
fn wait_for(c: &Client, ev: &Events, what: &str, timeout: Duration, mut done: impl FnMut(&Event) -> bool) -> Vec<Event> {
    let deadline = Instant::now() + timeout;
    let mut seen = Vec::new();
    while Instant::now() < deadline {
        if let Ok(e) = ev.recv_timeout(Duration::from_millis(100)) {
            if let Event::Output { id, data } = &e {
                for _ in 0..data.windows(4).filter(|w| *w == b"\x1b[6n").count() {
                    let _ = c.input(id, b"\x1b[1;1R");
                }
            }
            let stop = done(&e);
            seen.push(e);
            if stop {
                return seen;
            }
        }
    }
    panic!("timed out waiting for {what}; saw {seen:?}");
}

fn output_of(events: &[Event], id: &str) -> String {
    events
        .iter()
        .filter_map(|e| match e {
            Event::Output { id: i, data } if i == id => Some(String::from_utf8_lossy(data).into_owned()),
            _ => None,
        })
        .collect()
}

fn open() -> Open {
    let shell = if cfg!(windows) { "cmd.exe" } else { "/bin/sh" };
    Open { id: "tab-1".into(), dir: std::env::temp_dir().display().to_string(), cols: 100, rows: 30, program: shell.into(), args: vec![], env: vec![] }
}

/// A line for the shell whose output says `FIRST_42` / `SECOND_42` while the typed line (echoed back) does not: the check
/// cannot pass on the echo alone. sh: arithmetic; cmd.exe: an empty slice of a variable.
fn say(word: &str) -> Vec<u8> {
    if cfg!(windows) { format!("echo {word}_%COMPUTERNAME:~0,0%42\r\n").into_bytes() } else { format!("echo {word}_$((40+2))\n").into_bytes() }
}

fn host_name() -> String {
    std::env::var("TERMHOST_TEST_NAME").unwrap_or_default()
}

/// Runs one viewer step in a process of its own; it must succeed, within a minute (a step that hangs fails the test
/// instead of the whole job). Its output goes to a file: a pipe would be held open by anything the step leaves running.
fn step(name: &str, which: &str) {
    let log = std::env::temp_dir().join(format!("{name}-{which}.log"));
    let file = std::fs::File::create(&log).unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([which, "--exact", "--ignored", "--nocapture"])
        .env("TERMHOST_TEST_NAME", name)
        .env("PULSE_TERMHOST_IDLE_SECS", "2")
        .stdout(file.try_clone().unwrap())
        .stderr(file)
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(60);
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break Some(s);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            break None;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let text = std::fs::read_to_string(&log).unwrap_or_default();
    let _ = std::fs::remove_file(&log);
    assert!(status.is_some(), "step {which} did not finish in a minute:\n{text}");
    assert!(status.unwrap().success() && text.contains("1 passed"), "step {which} failed:\n{text}");
}

#[test]
fn a_session_outlives_its_viewer() {
    let name = format!("pulse-termhost-test-{}", std::process::id());
    // 1. a viewer starts the host and a session, runs something, and is gone (its process exits)
    step(&name, "viewer_starts_and_vanishes");
    // 2. and 3. the next viewer finds the session running, with its output, and closes it at the end
    step(&name, "viewer_comes_back_and_closes");
    // 4. no session, no viewer: the host ends itself (idle 2 s here; looked at once, since looking is connecting)
    std::thread::sleep(Duration::from_secs(4));
    assert!(Client::connect(&name).is_err(), "the host ended once idle");
}

#[test]
#[ignore = "a step of a_session_outlives_its_viewer, run in a process of its own"]
fn viewer_starts_and_vanishes() {
    let exe = Path::new(env!("CARGO_BIN_EXE_pulse-termhost"));
    let (c, ev) = Client::connect_or_start(&host_name(), exe).expect("host");
    c.open(&open()).unwrap();
    wait_for(&c, &ev, "opened", Duration::from_secs(5), |e| matches!(e, Event::Opened { attached: false, .. }));
    c.input("tab-1", &say("FIRST")).unwrap();
    wait_for(&c, &ev, "first output", Duration::from_secs(5), |e| matches!(e, Event::Output { data, .. } if String::from_utf8_lossy(data).contains("FIRST_42")));
    // then this process exits, without closing anything: as the file manager does when it crashes
}

#[test]
#[ignore = "a step of a_session_outlives_its_viewer, run in a process of its own"]
fn viewer_comes_back_and_closes() {
    let (c, ev) = Client::connect(&host_name()).expect("the host outlived the first viewer");
    c.list().unwrap();
    let seen = wait_for(&c, &ev, "sessions", Duration::from_secs(5), |e| matches!(e, Event::Sessions(_)));
    match seen.last() {
        Some(Event::Sessions(list)) => assert!(list.iter().any(|s| s.id == "tab-1"), "the session is still running: {list:?}"),
        other => panic!("{other:?}"),
    }
    c.open(&open()).unwrap();
    let seen = wait_for(&c, &ev, "attached", Duration::from_secs(5), |e| matches!(e, Event::Output { .. }));
    assert!(seen.iter().any(|e| matches!(e, Event::Opened { attached: true, .. })), "attached to the running session: {seen:?}");
    assert!(output_of(&seen, "tab-1").contains("FIRST_42"), "the kept output comes back");
    c.input("tab-1", &say("SECOND")).unwrap();
    wait_for(&c, &ev, "second output", Duration::from_secs(5), |e| matches!(e, Event::Output { data, .. } if String::from_utf8_lossy(data).contains("SECOND_42")));
    // closing the tab ends the session
    c.close("tab-1").unwrap();
    wait_for(&c, &ev, "exit", Duration::from_secs(5), |e| matches!(e, Event::Exit { id } if id == "tab-1"));
    c.list().unwrap();
    let seen = wait_for(&c, &ev, "empty list", Duration::from_secs(5), |e| matches!(e, Event::Sessions(_)));
    assert!(matches!(seen.last(), Some(Event::Sessions(l)) if l.is_empty()), "{seen:?}");
}

/// Four terminals printing 100,000 lines each at once: every line reaches the viewer, in order per terminal.
#[cfg(unix)]
#[test]
fn heavy_output_from_several_terminals_arrives_whole() {
    let exe = Path::new(env!("CARGO_BIN_EXE_pulse-termhost"));
    let name = format!("pulse-termhost-stress-{}", std::process::id());
    // SAFETY: set before the host starts (it reads it); a short idle time, so the host goes when the test is done
    unsafe { std::env::set_var("PULSE_TERMHOST_IDLE_SECS", "2") };
    let (c, ev) = Client::connect_or_start(&name, exe).expect("host");
    let ids: Vec<String> = (0..4).map(|i| format!("t{i}")).collect();
    for id in &ids {
        let mut o = open();
        o.id = id.clone();
        o.program = "/bin/sh".into();
        o.args = vec!["-c".into(), "seq 1 100000; echo END_OF_RUN".into()];
        c.open(&o).unwrap();
    }
    let started = Instant::now();
    let mut text: std::collections::HashMap<String, String> = Default::default();
    let mut exited = 0;
    while exited < ids.len() && started.elapsed() < Duration::from_secs(60) {
        match ev.recv_timeout(Duration::from_millis(200)) {
            Ok(Event::Output { id, data }) => text.entry(id).or_default().push_str(&String::from_utf8_lossy(&data)),
            Ok(Event::Exit { .. }) => exited += 1,
            _ => {}
        }
    }
    let took = started.elapsed();
    assert_eq!(exited, ids.len(), "every terminal ended");
    for id in &ids {
        let t = &text[id];
        let lines: Vec<&str> = t.split(['\r', '\n']).filter(|l| !l.is_empty()).collect();
        assert!(t.contains("END_OF_RUN"), "{id}: the end arrived");
        let numbers: Vec<u32> = lines.iter().filter_map(|l| l.parse().ok()).collect();
        assert_eq!(numbers.len(), 100_000, "{id}: every line arrived");
        assert!(numbers.windows(2).all(|w| w[1] == w[0] + 1), "{id}: in order");
    }
    eprintln!("4 × 100,000 lines through the host in {:.2} s", took.as_secs_f64());
    // (the terminals ended; the host ends itself once idle: here it is stopped with the test's process group)
    drop(c);
}
