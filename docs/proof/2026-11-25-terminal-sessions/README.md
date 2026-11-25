# Terminal sessions that outlive Pulse, auto-refresh, crash fix (2026-11-25)

The Mac build, tested in the app (window captures by window id; tmux checked with `tmux -L pulse-explorer`).

## Terminals keep running when Pulse quits or crashes

Each terminal pane runs in a tmux session of its own, on Pulse's own tmux server (`-L pulse-explorer`, its own config;
the user's tmux is not touched). It is invisible: no status line, no prefix key, titles, bells, links, clipboard and
extended keys passed through, and drawn on the main screen so Pulse's scrollback, selection and find keep working.

| Step | Result |
|---|---|
| Open a terminal tab, run `echo PULSE_ALIVE_…; sleep 600` in it | session `64E8…` attached=1 |
| `kill -9` the app (a crash) | app gone; session still there, attached=0, `sleep` running |
| Start Pulse again (startup: Home) | the session comes back as a tab in front, attached=1, the output still on screen (1-…png) |
| Run `sleep 120` in it | the tab reads "sleep — watch": the program inside tmux is seen (2-…png), so agent marks work |
| File › Close Tab | the session ends (the tmux server exits with it), and so does what ran in it |

Closing a window, or quitting, keeps the sessions; closing a tab or a pane ends its own. Sessions no tab shows are opened
as tabs at the next start, whatever *When Pulse starts* says. Settings › Terminal › *Keep terminals running when Pulse
closes* turns it off; without tmux (`brew install tmux`) terminals work as before.

Bugs found while testing and fixed: a tmux pane target needs `=name:` (not `=name`); `tcgetpgrp` on another terminal
answers nothing on macOS, so the program in front is read from the kernel (`kinfo_proc.e_tpgid`, new
`ProcessInspect.terminalForeground`, tested); tmux's default title (the host name) is not used as the tab's name.

## The list follows changes without ⌘R

The folder watcher was the folder's own vnode: files added, removed or renamed were seen, a file saved or grown in place
was not (b.txt grown from 2 bytes to 488 KB still showed 2 bytes), and only the tab in front was watched. Now one FSEvents
stream per window watches every folder tab: the tab in front lists again 0.15 s after a change, a tab behind it when it
comes back to the front (3-…png: 488 KB and the new c.txt, nobody pressing ⌘R). Found on the way: URL's
`resolvingSymlinksInPath` drops `/private`, so folders under /private/tmp never matched; `realpath` is used.

## Crash: "Pulse Explorer quit unexpectedly"

Four crash reports (2026-11-24 21:53 to 2026-11-25 11:34): EXC_BAD_ACCESS in the stack guard of `swiftterm-io-reader`, 49
frames deep, in the Swift runtime under the output tap. Threads get 512 KB stacks; the terminal's gather and parse threads
now get 8 MB (vendored SwiftTerm, listed in VENDORED.md).
