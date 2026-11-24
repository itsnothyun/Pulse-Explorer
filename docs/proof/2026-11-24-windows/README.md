# Windows terminal tab: proof run (2026-11-24)

The Windows terminal tab's **page** (`crates/rf-app/assets/terminal/index.html`, xterm.js) and its **start-up script**
(`rf_pulse::term::powershell_init`, the welcome card from `rf_pulse::welcome`), run on a Mac against real PowerShell 7.7
in a pty. A small test server stood in for `rf-app/src/terminal.rs` and the WebView2 bridge, using the same title rules as `pump()`.
ConPTY, WebView2 and the GPUI side were checked only by compiling in CI (windows-latest). They were not run on a Windows PC.

| shot | what it shows |
| --- | --- |
| 1-welcome-card.png | The PULSE card (Windows keys), then the box prompt with the folder and git branch |
| 2-commands.png | Typed commands and their colored output under the card |
| 3-agent-clean-screen.png | `claude` typed: the screen clears, and Claude Code starts on a clean screen |

The tab title (document.title, which becomes the tab's name) during the agent run:
`Pulse-Explorer` → `◌ Claude Code` (working, 4.2 s) → `◐ Claude Code` (waiting for you, after 3 s of quiet).

Fixed during the run: PSReadLine's `ClearScreen()` redraws the prompt, and the prompt set the title back to idle, so an
agent read as idle while it ran. The run title is now set after the clear.
