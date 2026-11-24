//! The card a new terminal tab opens with (the Mac app's PulseKit TerminalWelcome, ported): the PULSE wordmark and the
//! pulse line beside what is useful here, fitted to the pane's width, in 24-bit colour; and the frames that draw the line in.

#[derive(Debug, Clone, Default)]
pub struct Info {
    pub folder: String,
    pub home: String,
    pub items: Option<usize>,
    pub branch: Option<String>,
    pub changed: usize,
    pub ahead: usize,
    pub behind: usize,
    pub commands: Vec<String>,
    pub light: bool,
    /// The "> Try …" box under the card; off when the shell's prompt is drawn as that box.
    pub try_box: bool,
    /// Windows: Ctrl instead of ⌘ in the key hints.
    pub windows: bool,
}

pub const WORDMARK: [&str; 4] = ["█▀▀▀▄ █   █ █     ▄▀▀▀▀ █▀▀▀▀", "█▄▄▄▀ █   █ █     ▀▄▄▄  █▄▄▄", "█     █   █ █         █ █", "▀      ▀▀▀  ▀▀▀▀▀ ▀▀▀▀  ▀▀▀▀▀"];
pub const ART: [&str; 12] = ["              **", "              #*=*", "              #*##", "              ##*#", "            !=::#*", "            ##  ##", "    :!      *#  !!!:  !!", "...:!!:::!  ##    $#::==!:!:!:", ":::!  ===*::==    #*##  *=*=*=", "          **      #*#*", "                  #**=", "                  #*"];

const RESET: &str = "\x1b[0m";

struct Style { light: bool }
impl Style {
    fn rgb(h: u32) -> String { format!("\x1b[38;2;{};{};{}m", h >> 16 & 255, h >> 8 & 255, h & 255) }
    fn title(&self, t: &str) -> String { format!("\x1b[1m{}{t}{RESET}", Self::rgb(if self.light { 0x090909 } else { 0xF2F2ED })) }
    fn plain_title(&self, t: &str) -> String { format!("{}{t}{RESET}", Self::rgb(if self.light { 0x090909 } else { 0xF2F2ED })) }
    fn body(&self, t: &str) -> String { format!("{}{t}{RESET}", Self::rgb(if self.light { 0x3A3A38 } else { 0xC8C8C2 })) }
    fn dim(&self, t: &str) -> String { format!("{}{t}{RESET}", Self::rgb(if self.light { 0x757573 } else { 0x7C7C79 })) }
    fn art(&self, t: &str) -> String { format!("{}{t}{RESET}", Self::rgb(if self.light { 0x2A2A28 } else { 0xE6E6E0 })) }
    fn head(&self, t: &str) -> String { format!("\x1b[1m{}{t}{RESET}", Self::rgb(if self.light { 0x000000 } else { 0xFFFFFF })) }
    fn border(&self, t: &str) -> String { format!("{}{t}{RESET}", Self::rgb(if self.light { 0xC4C4BF } else { 0x4A4A47 })) }
}

/// Text without escape sequences.
pub fn strip(s: &str) -> String {
    let mut out = String::new();
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\x1b' {
            if it.peek() == Some(&'[') {
                it.next();
                while let Some(&n) = it.peek() { it.next(); if n.is_ascii_alphabetic() { break; } }
            } else { it.next(); }
        } else { out.push(c); }
    }
    out
}

fn width(s: &str) -> usize { strip(s).chars().count() }
fn spaces(n: usize) -> String { " ".repeat(n) }
fn clip(s: &str, n: usize) -> String {
    if s.chars().count() <= n { return s.to_string(); }
    if n > 1 { s.chars().take(n - 1).collect::<String>() + "…" } else { s.chars().take(n).collect() }
}

/// "~/dev/pulse" (or "~\\dev\\pulse"), cut from the left when longer than `max`.
pub fn short_path(path: &str, home: &str, max: usize) -> String {
    let mut p = path.to_string();
    if !home.is_empty() {
        if p == home { p = "~".into(); } else if let Some(rest) = p.strip_prefix(home) { if rest.starts_with(['/', '\\']) { p = format!("~{rest}"); } }
    }
    if p.chars().count() <= max || max < 2 { return p; }
    let tail: String = p.chars().rev().take(max - 1).collect::<Vec<_>>().into_iter().rev().collect();
    format!("…{tail}")
}

pub fn suggestion(i: &Info) -> String {
    i.commands.first().cloned().unwrap_or_else(|| if i.branch.is_some() { "git status".into() } else if i.windows { "ls".into() } else { "ls -la".into() })
}

fn git_line(i: &Info, branch: &str) -> String {
    let mut t = format!("⎇ {branch}");
    if i.ahead > 0 { t += &format!(" ↑{}", i.ahead); }
    if i.behind > 0 { t += &format!(" ↓{}", i.behind); }
    t += &if i.changed == 0 { " · clean".to_string() } else { format!(" · {} changed", i.changed) };
    t
}

fn keys(i: &Info) -> (&'static str, &'static str, &'static str) {
    if i.windows { ("Ctrl+Shift+D split right · Ctrl+Shift+E down", "Ctrl+Shift+[ ] move · Ctrl+Shift+W close", "Ctrl+K commands · Ctrl+` new terminal") }
    else { ("⌘D split right · ⇧⌘D split down", "⌘[ ⌘] move between · ⌘W close", "⌘K commands · ⌃` new terminal") }
}

/// The card as terminal output (lines end in CR LF) for a pane `cols` wide.
pub fn render(i: &Info, cols: usize) -> String {
    let lines = if cols >= 80 { full(i, cols) } else if cols >= 44 { compact(i, cols) } else { tiny(i, cols) };
    lines.into_iter().map(|l| l + RESET).collect::<Vec<_>>().join("\r\n") + "\r\n"
}

pub fn plain(i: &Info, cols: usize) -> Vec<String> {
    let r = render(i, cols);
    let mut v: Vec<String> = r.split("\r\n").map(strip).collect();
    v.pop();
    v
}

fn full(i: &Info, cols: usize) -> Vec<String> {
    let s = Style { light: i.light };
    let w = (cols - 2).min(100);
    let left_w = 34;
    let right_w = w - 7 - left_w;
    let center = |styled: String, vis: usize| spaces((left_w.saturating_sub(vis)) / 2) + &styled;
    let mut left: Vec<String> = vec![String::new()];
    for m in WORDMARK { left.push(center(s.plain_title(m), 30)); }
    left.push(center(s.dim("E X P L O R E R"), 15));
    left.push(String::new());
    for a in ART { left.push(center(s.art(&format!("{a:<30}")), 30)); }
    left.push(String::new());
    let place = short_path(&i.folder, &i.home, left_w - 2);
    left.push(center(s.dim(&place), place.chars().count()));
    let mut right: Vec<String> = vec![String::new()];
    let line = |t: String| clip(&t, right_w);
    right.push(s.title("Here"));
    right.push(s.body(&line(short_path(&i.folder, &i.home, right_w))));
    if let Some(n) = i.items { right.push(s.body(&line(if n == 1 { "1 item".into() } else { format!("{n} items") }))); }
    if let Some(b) = &i.branch { right.push(s.body(&line(git_line(i, b)))); }
    right.push(String::new());
    right.push(s.border(&"─".repeat(right_w)));
    right.push(String::new());
    let (k1, k2, k3) = keys(i);
    right.push(s.title("Panes"));
    right.push(s.body(&line(k1.into())));
    right.push(s.body(&line(k2.into())));
    right.push(String::new());
    if !i.commands.is_empty() {
        right.push(s.title("Run"));
        for c in i.commands.iter().take(3) { right.push(s.body(&line(c.clone()))); }
    } else {
        right.push(s.title("Pulse"));
        right.push(s.body(&line(k3.into())));
    }
    let rows = left.len().max(right.len()) + 1;
    let label = " Pulse ";
    let mut out = vec![s.border("╭─") + &s.dim(label) + &s.border(&("─".repeat(w - 3 - label.len()) + "╮"))];
    for r in 0..rows {
        let l = left.get(r).cloned().unwrap_or_default();
        let rr = right.get(r).cloned().unwrap_or_default();
        out.push(s.border("│ ") + &l + &spaces(left_w.saturating_sub(width(&l))) + &s.border(" │ ") + &rr + &spaces(right_w.saturating_sub(width(&rr))) + &s.border(" │"));
    }
    out.push(s.border(&format!("╰{}╯", "─".repeat(w - 2))));
    if i.try_box { out.extend(try_box(i, w, &s)); } else { out.push(format!(" {}", s.dim(k3))); }
    out
}

fn compact(i: &Info, cols: usize) -> Vec<String> {
    let s = Style { light: i.light };
    let w = (cols - 2).min(76);
    let inner = w - 4;
    let mut body = vec![s.title("Pulse Explorer"), s.dim(&clip(&short_path(&i.folder, &i.home, inner), inner))];
    if let Some(b) = &i.branch { body.push(s.body(&clip(&git_line(i, b), inner))); }
    body.push(s.body(&clip(keys(i).2, inner)));
    let mut out = vec![s.border(&format!("╭{}╮", "─".repeat(w - 2)))];
    for b in body { out.push(s.border("│ ") + &b + &spaces(inner.saturating_sub(width(&b))) + &s.border(" │")); }
    out.push(s.border(&format!("╰{}╯", "─".repeat(w - 2))));
    if i.try_box { out.extend(try_box(i, w, &s)); }
    out
}

fn tiny(i: &Info, cols: usize) -> Vec<String> {
    let s = Style { light: i.light };
    vec![s.dim(&clip(&format!("Pulse · {}", short_path(&i.folder, &i.home, cols)), cols.saturating_sub(1).max(1)))]
}

fn try_box(i: &Info, w: usize, s: &Style) -> Vec<String> {
    let inner = w - 4;
    let text = clip(&format!("Try \"{}\"", suggestion(i)), inner - 4);
    vec![
        s.border(&format!("╭{}╮", "─".repeat(w - 2))),
        s.border("│ ") + &s.title(">") + "   " + &s.dim(&text) + &spaces((inner - 4).saturating_sub(text.chars().count())) + &s.border(" │"),
        s.border(&format!("╰{}╯", "─".repeat(w - 2))),
        format!(" {}", s.dim(keys(i).2)),
    ]
}

/// Where the art sits in the full card (1-based row, card starting at row `top`; column).
pub fn art_placement(cols: usize, top: usize) -> Option<(usize, usize)> {
    (cols >= 80).then_some((top + 1 + 7, 3 + (34 - 30) / 2))
}

/// The pulse line drawn in: a bright head sweeps left to right leaving the trace, one beat, then rest. Each frame
/// redraws only the art's rows, the cursor saved and put back.
pub fn frames(i: &Info, cols: usize, top: usize) -> Vec<String> {
    let Some((row, col)) = art_placement(cols, top) else { return vec![] };
    let s = Style { light: i.light };
    let frame = |cell: &dyn Fn(usize, char) -> String| {
        let mut out = String::from("\x1b7");
        for (r, a) in ART.iter().enumerate() {
            out += &format!("\x1b[{};{}H", row + r, col);
            for (x, ch) in format!("{a:<30}").chars().enumerate() { out += &cell(x, ch); }
        }
        out + RESET + "\x1b8"
    };
    let mut v = vec![];
    for head in (0..=34).step_by(2) {
        v.push(frame(&|x, ch| if ch == ' ' || x > head { " ".into() } else if head - x < 3 { s.head(&ch.to_string()) } else { s.art(&ch.to_string()) }));
    }
    v.push(frame(&|_, ch| if ch == ' ' { " ".into() } else { s.head(&ch.to_string()) }));
    v.push(frame(&|_, ch| if ch == ' ' { " ".into() } else { s.art(&ch.to_string()) }));
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    fn info(windows: bool) -> Info {
        Info { folder: "/Users/a/dev/pulse-explorer".into(), home: "/Users/a".into(), items: Some(12), branch: Some("main".into()), changed: 3, ahead: 1,
               commands: vec!["pnpm run dev".into(), "pnpm run build".into()], try_box: true, windows, ..Default::default() }
    }

    #[test]
    fn no_line_is_wider_than_the_pane() {
        for cols in 20..=160 { for l in plain(&info(true), cols) { assert!(l.chars().count() <= cols, "{cols}: {l}"); } }
    }

    #[test]
    fn full_card_is_boxed_and_says_what_matters() {
        let lines = plain(&info(true), 120);
        let card: Vec<&String> = lines.iter().take_while(|l| !l.starts_with('╰')).collect();
        let w = card[0].chars().count();
        assert!(card.iter().all(|l| l.chars().count() == w));
        assert!(lines.iter().any(|l| l.contains("█▀▀▀▄")));
        assert!(lines.iter().any(|l| l.contains("⎇ main ↑1 · 3 changed")));
        assert!(lines.iter().any(|l| l.contains("Ctrl+Shift+D split right")), "Windows keys");
        assert!(plain(&info(false), 120).iter().any(|l| l.contains("⌘D split right")), "Mac keys");
        assert!(lines.iter().any(|l| l.contains("Try \"pnpm run dev\"")));
        assert!(lines.iter().any(|l| l.contains("$#::==!")));
    }

    #[test]
    fn compact_tiny_frames() {
        assert!(!plain(&info(true), 60).iter().any(|l| l.contains("$#::==!")));
        assert_eq!(plain(&info(true), 30).len(), 1);
        let f = frames(&info(true), 120, 1);
        assert!(f.len() > 10 && f.iter().all(|x| x.starts_with("\x1b7") && x.ends_with("\x1b8")));
        assert!(frames(&info(true), 60, 1).is_empty());
        assert_eq!(short_path("C:\\Users\\a\\x", "C:\\Users\\a", 40), "~\\x");
    }
}
