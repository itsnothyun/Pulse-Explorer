# Rename tabs: proof run (2026-11-24)

The Mac build of this branch, driven with real mouse and key events (cliclick, System Events), in its own development settings
(`com.rustyfiles.mac`, deleted afterwards).

| shot | what it shows |
| --- | --- |
| 1-double-click-opens-rename.png | Double-clicking the `docs` tab: the Rename tab box, its current name selected |
| 2-tab-renamed.png | Typed "Proof screenshots" + Return: the tab shows the new name; the folder is still `docs` |
| 3-name-kept-after-restart.png | Quit and relaunched with *Continue where you left off*: the name came back |
| 4-tab-menu.png | The tab's right-click menu with *Rename tab…* (also File › Rename Tab…) |

Checked in the saved session after each step:

- rename: `"names":["","Proof screenshots"]`
- rename from the tab menu: `"names":["","Via menu"]`
- name cleared + Return: `"names":["",""]`, and the tab reads `docs` again

An agent's working/waiting mark (◌ ◐) stays in front of a renamed terminal tab.

Windows (`workspace.rs`): double-click a tab, the tab menu's *Rename tab…*, or the command palette. Names are kept with the
session and with saved sessions. This was compile-checked in CI only.
