# Folder performance and permission prompts: audit and stress test (2026-11-24/25)

The Mac app, home folder `~` (30 items) with the preview pane on, driven with real key events. Every run started from a clean
permission state for the test build (`tccutil reset All com.rustyfiles.mac`), and the macOS privacy log (TCC) was recorded.

## What was wrong

1. **Permission prompts came back after every install.** Builds were signed ad hoc, so each reinstall was a new app to
   macOS. The TCC log showed `Failed to match existing code requirement for subject app.pulse.explorer` for Desktop,
   Documents, Downloads, the Music library and Full Disk Access, then a new prompt. A stale grant can also keep a folder
   from opening without a visible prompt.
2. **Selecting a folder added up its whole size,** recursively, on every core (rayon's global pool), and nothing stopped it
   when the selection moved on. Arrowing through `~` peaked at **351% CPU** and ran several walks at once. Because folder
   listing shares that pool, opening a folder could wait behind them.
3. **The app read protected folders on its own**, so the selection alone set off prompts for Desktop, Documents, Downloads,
   the Music library and Google Drive (`~/Google Drive` is a link into `~/Library/CloudStorage`). The Home page's Recent list
   checked each recent file on disk, which asked for the Photo Library at launch.

## What changed

- `build.sh`, `stage-mac-files.sh` and `install-mac.sh` sign with the first Apple Development / Developer ID certificate in the
  keychain (or `PULSE_SIGN_ID`), and fall back to ad hoc only when none exists. The app's identity is then stable, and macOS
  keeps its answers across rebuilds.
- Rust core (`rf-mac`): `folder_size_limited(path, budget_ms, skip)` with `cancel_folder_sizes()`, on a 2-thread pool of its
  own. Tests: `sizes_skip_guarded_folders_and_stop_when_told`; 8/8 pass.
- Preview pane: waits 0.45 s for the selection to rest, cancels on every move, and stops after 4 s ("at least 13.0 GB").
- `PrivacyGuard`: the folders macOS protects (Desktop, Documents, Downloads, iCloud and cloud drives, other apps' data, Mail,
  Messages, Pictures, Music, Movies, other volumes). The app reads them on its own only after you have opened them once.
  Links are followed one folder at a time and the walk stops at a protected one, so nothing inside is touched. Applies to
  the preview pane, automatic folder sizes, and the Home page's Recent list.

## Results

| Test | Before | After |
|---|---|---|
| Arrow through all 30 items in `~`, peak CPU | 351% | 98–128% (only while `orca`, 13+ GB, is counted for 4 s) |
| Permission requests during that walk | Desktop, Documents, Downloads, Music library, Google Drive | none (checked in every frame) |
| Home page at launch | Photo Library prompt | none |
| Rest on `orca` (13+ GB) | full walk on all cores | ~100–116% for 4 s, then "at least 13.0 GB" |
| Move away mid-count | walk kept going | 104% → 26% within ~0.6 s |
| `node_modules` (615 items) | – | 199 MB, exact |
| List `~` / `node_modules` | 87 ms / 12 ms | unchanged |
| 50,300-item folder | – | listed in 769 ms, 108 MB, CPU back to 0 in ~1.5 s |

A protected folder you open yourself still asks once (that question is macOS's own), and with stable signing the answer now
sticks.
