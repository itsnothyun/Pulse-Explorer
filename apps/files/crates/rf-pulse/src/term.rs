//! The Windows terminal tab's plumbing that does not need Windows: what the shell says through the window title, the
//! bytes for the page, and the PowerShell start-up script (the box prompt, the clean screen for agents).
//!
//! The shell tells the tab what is in front through the title (ConPTY passes OSC 0/2 titles through reliably):
//! "pulse:idle" at the prompt, "pulse:run:<program>" when Enter starts a command. Any other title is the program's own
//! (Claude Code's "✳ Claude Code") and is shown as the tab's name.

use crate::agents::{AGENT_NAMES, base_name};

/// What a title says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Title {
    /// Back at the prompt.
    Idle,
    /// A command started: its program's name (lowercase, no .exe).
    Run(String),
    /// The program named itself.
    Own(String),
}

pub fn title(t: &str) -> Title {
    if t == "pulse:idle" {
        Title::Idle
    } else if let Some(p) = t.strip_prefix("pulse:run:") {
        Title::Run(base_name(p.trim()))
    } else {
        Title::Own(t.to_string())
    }
}

/// Finds OSC 0 and OSC 2 titles in output (ended by BEL or ESC \), across chunk boundaries.
#[derive(Default)]
pub struct TitleScanner {
    state: u8,
    buf: Vec<u8>,
}

impl TitleScanner {
    pub fn scan(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        for &b in bytes {
            match self.state {
                // ground
                0 => {
                    if b == 0x1b {
                        self.state = 1
                    }
                }
                // ESC seen
                1 => self.state = if b == b']' { 2 } else if b == 0x1b { 1 } else { 0 },
                // OSC: the number
                2 => {
                    if b == b'0' || b == b'2' {
                        self.state = 3
                    } else {
                        self.state = 0
                    }
                }
                3 => {
                    if b == b';' {
                        self.state = 4;
                        self.buf.clear();
                    } else {
                        self.state = 0
                    }
                }
                // the title, up to BEL or ST
                4 => match b {
                    0x07 => {
                        out.push(String::from_utf8_lossy(&self.buf).into_owned());
                        self.state = 0;
                    }
                    0x1b => self.state = 5,
                    _ if self.buf.len() < 512 => self.buf.push(b),
                    _ => {}
                },
                5 => {
                    if b == b'\\' {
                        out.push(String::from_utf8_lossy(&self.buf).into_owned());
                    }
                    self.state = if b == b']' { 2 } else { 0 };
                }
                _ => self.state = 0,
            }
        }
        out
    }
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64(data: &[u8]) -> String {
    let mut s = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= c.len() {
                s.push(B64[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                s.push('=');
            }
        }
    }
    s
}

/// UTF-16LE base64, what `powershell -EncodedCommand` takes (no quoting, no execution policy in the way).
pub fn encoded_command(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    base64(&bytes)
}

fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// The start-up script: UTF-8, the welcome card from `card` (a file it deletes), the box prompt, and the titles above. With
/// PSReadLine, Enter on a line that starts a coding agent clears the screen first (the agent gets a clean screen).
pub fn powershell_init(card: Option<&str>, extra_agents: &[String]) -> String {
    let mut agents: Vec<String> = AGENT_NAMES.iter().map(|s| s.to_string()).collect();
    agents.extend(extra_agents.iter().map(|s| s.to_lowercase()));
    let list = agents.iter().map(|a| ps_quote(a)).collect::<Vec<_>>().join(",");
    let card = card
        .map(|c| format!("try {{ [Console]::Write([IO.File]::ReadAllText({q})) }} catch {{}}\nRemove-Item -LiteralPath {q} -ErrorAction SilentlyContinue\n", q = ps_quote(c)))
        .unwrap_or_default();
    format!(
        r#"$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
{card}$global:__pulseAgents = @({list})
function global:__pulseProgram([string]$line) {{
  $w = @($line.Trim() -split '\s+' | Where-Object {{ $_ }})
  $i = 0
  while ($i -lt $w.Count) {{
    $x = $w[$i]
    if ($x.Contains('=') -or $x.StartsWith('-') -or $x -eq '&') {{ $i++ }}
    elseif (@('npx','bunx','pnpx','uvx','pipx') -contains $x) {{ $i++; if ($w[$i] -eq 'run') {{ $i++ }} }}
    elseif ((@('pnpm','yarn','bun','npm') -contains $x) -and (@('dlx','x','exec') -contains $w[$i + 1])) {{ $i += 2 }}
    else {{ break }}
  }}
  if ($i -ge $w.Count) {{ return '' }}
  $p = $w[$i].TrimStart('&').Trim('"', "'")
  $p = ($p -split '[\\/]')[-1]
  $p = @($p -split '@' | Where-Object {{ $_ }})[0]
  return "$p"
}}
function global:prompt {{
  $e = [char]27
  $here = $ExecutionContext.SessionState.Path.CurrentLocation.ProviderPath
  if ($here.StartsWith($HOME, [StringComparison]::OrdinalIgnoreCase)) {{ $here = '~' + $here.Substring($HOME.Length) }}
  $branch = ''
  if (Get-Command git -ErrorAction SilentlyContinue) {{ $b = git branch --show-current 2>$null; if ($b) {{ $branch = " $e[38;2;167;139;250m $b$e[0m" }} }}
  $Host.UI.RawUI.WindowTitle = 'pulse:idle'
  "$e[38;2;82;82;96m╭─$e[0m $e[38;2;125;211;252m$here$e[0m$branch`n$e[38;2;82;82;96m╰─$e[38;2;167;139;250m❯$e[0m "
}}
if (Get-Module PSReadLine) {{
  Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {{
    $line = $null; $cursor = $null
    [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
    $p = __pulseProgram $line
    if ($p) {{
      # (ClearScreen draws the prompt again, and the prompt says idle: the title comes after it)
      $b = $p.ToLower() -replace '\.(exe|cmd)$','' -replace '-cli$',''
      if ($global:__pulseAgents -contains $b) {{ [Microsoft.PowerShell.PSConsoleReadLine]::ClearScreen() }}
      $Host.UI.RawUI.WindowTitle = "pulse:run:$p"
    }}
    [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
  }}
}}
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_are_found_across_chunks() {
        let mut s = TitleScanner::default();
        assert_eq!(s.scan(b"hello\x1b]0;pulse:ru"), Vec::<String>::new());
        assert_eq!(s.scan(b"n:claude.exe\x07rest"), vec!["pulse:run:claude.exe".to_string()]);
        assert_eq!(s.scan(b"\x1b]2;\xe2\x9c\xb3 Claude Code\x1b\\"), vec!["✳ Claude Code".to_string()]);
        // other OSCs (a hyperlink, the cwd) are not titles
        assert!(s.scan(b"\x1b]8;;https://x\x07link\x1b]8;;\x07\x1b]7;file://h/p\x07").is_empty());
        assert_eq!(title("pulse:run:Codex.exe"), Title::Run("codex".into()));
        assert_eq!(title("pulse:idle"), Title::Idle);
        assert_eq!(title("vim"), Title::Own("vim".into()));
    }

    #[test]
    fn base64_matches_the_standard() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(encoded_command("ls"), "bABzAA==");
    }

    #[test]
    fn the_init_script_knows_the_agents_and_the_card() {
        let s = powershell_init(Some(r"C:\Temp\it's.txt"), &["Kiro".into()]);
        assert!(s.contains("'claude','claude-code'"));
        assert!(s.contains("'kiro'"));
        assert!(s.contains(r"'C:\Temp\it''s.txt'"), "quoted for PowerShell");
        assert!(s.contains("pulse:idle") && s.contains("pulse:run:$p"));
        assert!(!powershell_init(None, &[]).contains("ReadAllText"));
    }
}
