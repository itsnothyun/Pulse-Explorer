//! `pulse-termhost --serve <name>`: Pulse Explorer's terminal session host (rf-termhost). Started by the file manager, not
//! by hand; it ends itself once it has had no terminal and no viewer for a minute.
#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let name = match args.iter().position(|a| a == "--serve") {
        Some(i) => args.get(i + 1).cloned().unwrap_or_else(rf_termhost::default_name),
        None => rf_termhost::default_name(),
    };
    let idle = std::env::var("PULSE_TERMHOST_IDLE_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(60);
    if let Err(e) = rf_termhost::run_host(&name, std::time::Duration::from_secs(idle)) {
        eprintln!("pulse-termhost: {e:#}");
        std::process::exit(1);
    }
}
