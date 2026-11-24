//! Pulse Explorer's browser tabs: a tab whose location is `Location::Web` shows a page in Edge's WebView2, a child window of the
//! file manager's window laid over the tab's content area.
//!
//! One WebView2 per tab, created on the UI thread (WebView2 wants the thread that owns its parent window) and kept while the tab
//! lives: switching tabs hides it, closing the tab closes it. The folder view says where the content area is every frame
//! ([`place`]); the workspace hides the pages of the tabs it does not show ([`show_only`]). What the page does (its address, its
//! title, a link that asks for a new window) comes back over a channel the folder view listens on.
//!
//! WHY A POPUP AND NOT A CHILD WINDOW: the window's DirectComposition target is topmost (gpui_windows `CreateTargetForHwnd(hwnd,
//! true)`), so everything the app paints, the window's wash and the glass included, lies OVER a child window: a page as a child
//! came out dimmed under the content pane's fill. Each page lives in a small borderless window OWNED by ours instead (always above
//! its owner, minimised and restored with it, never in the taskbar), moved over the tab's content area in screen coordinates. Our
//! own popups (menus, flyouts) open later and stand above it; something drawn inside our window (a dialog painted in the window)
//! is under it.

use std::cell::RefCell;
use std::collections::HashMap;

use futures::channel::mpsc::UnboundedSender;
use gpui_kit::EntityId;
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::*;
use windows::Win32::Foundation::{HWND, RECT};
use windows::core::{HSTRING, Interface, PWSTR};

/// What a page did.
#[derive(Debug, Clone)]
pub enum WebEvent {
    /// The page's address changed (a link, a redirect, back in the page).
    Url(String),
    Title(String),
    /// A link asked for a new window: it opens as a new tab.
    NewTab(String),
    /// A terminal tab's page asked for something its keys mean (`terminal::Command`).
    Terminal(crate::terminal::Command),
}

#[derive(Default)]
struct Tab {
    /// Our window (the owner) and the page's own window owned by it.
    hwnd: isize,
    host: isize,
    controller: Option<ICoreWebView2Controller>,
    webview: Option<ICoreWebView2>,
    creating: bool,
    /// The address the tab's location asks for; the page goes there when it differs from `current`.
    want: String,
    current: String,
    title: String,
    bounds: RECT,
    visible: bool,
    tx: Option<UnboundedSender<WebEvent>>,
}

enum Env {
    None,
    Pending(Vec<EntityId>),
    Ready(ICoreWebView2Environment),
    Failed,
}

thread_local! {
    static ENV: RefCell<Env> = const { RefCell::new(Env::None) };
    static TABS: RefCell<HashMap<EntityId, Tab>> = RefCell::new(HashMap::new());
    static STARTED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Where WebView2 keeps the browsing data (cookies, cache): next to the app's settings.
fn data_dir() -> std::path::PathBuf {
    crate::settings::app_dir().unwrap_or_else(std::env::temp_dir).join("WebView2")
}

/// Turns what was typed into an address: a URL stays, `example.com` gets https, a local file gets file:///.
pub fn normalize(text: &str) -> String {
    let t = text.trim();
    let lower = t.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("file://") || lower.starts_with("about:") {
        return t.to_string();
    }
    let p = std::path::Path::new(t);
    if p.is_absolute() {
        return file_url(p);
    }
    format!("https://{t}")
}

/// `C:\a b\x.html` → `file:///C:/a%20b/x.html`.
pub fn file_url(p: &std::path::Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    let mut out = String::from("file:///");
    for ch in s.chars() {
        match ch {
            ' ' => out.push_str("%20"),
            '#' => out.push_str("%23"),
            '%' => out.push_str("%25"),
            '?' => out.push_str("%3F"),
            c => out.push(c),
        }
    }
    out
}

/// Whether the address bar's text is a web address rather than a place on disk: a scheme, `www.`, or a host name with a dot
/// and no path separators or spaces (`example.com/docs`).
pub fn looks_like_url(text: &str) -> bool {
    let t = text.trim();
    let lower = t.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("www.") || lower.starts_with("about:") {
        return true;
    }
    if t.contains(' ') || t.contains('\\') || t.contains(':') || t.starts_with('.') || t.starts_with('@') || t.starts_with('%') {
        return false;
    }
    // (a known domain ending only: `notes.txt` or `photo.jpg` typed in a folder is a file, not a site)
    const TLDS: &[&str] = &[
        "com", "org", "net", "io", "dev", "app", "ai", "co", "edu", "gov", "info", "me", "tv", "xyz", "site", "tech", "page", "rs",
        "us", "uk", "ca", "au", "de", "fr", "jp", "ph", "in", "eu", "nl", "se", "no", "es", "it", "br", "kr", "cn", "tr", "ru", "gg", "so",
    ];
    let host = t.split('/').next().unwrap_or("");
    let tld = host.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    host.contains('.') && TLDS.contains(&tld.as_str())
}

/// A page's own window: borderless, owned by our window `owner`, hidden until placed.
fn create_host(owner: isize) -> isize {
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::*;
    use windows::core::w;
    static REGISTERED: std::sync::Once = std::sync::Once::new();
    unsafe extern "system" fn proc(h: HWND, m: u32, w: windows::Win32::Foundation::WPARAM, l: windows::Win32::Foundation::LPARAM) -> windows::Win32::Foundation::LRESULT {
        // a terminal tab's shell has output for its page
        if m == crate::terminal::WAKE {
            crate::terminal::pump(h.0 as isize);
            return windows::Win32::Foundation::LRESULT(0);
        }
        unsafe { DefWindowProcW(h, m, w, l) }
    }
    let Ok(module) = (unsafe { GetModuleHandleW(None) }) else { return 0 };
    REGISTERED.call_once(|| {
        let class = WNDCLASSW { lpfnWndProc: Some(proc), hInstance: module.into(), lpszClassName: w!("PulseExplorerWebPage"), ..Default::default() };
        unsafe { RegisterClassW(&class) };
    });
    let made = unsafe {
        CreateWindowExW(
            WS_EX_TOOLWINDOW,
            w!("PulseExplorerWebPage"),
            w!(""),
            WS_POPUP | WS_CLIPCHILDREN,
            0,
            0,
            0,
            0,
            Some(HWND(owner as *mut _)),
            None,
            Some(module.into()),
            None,
        )
    };
    made.map_or(0, |h| h.0 as isize)
}

/// Moves page window `host` over `client` (device pixels in the owner's client area) and shows it without taking the focus.
fn set_host(host: isize, owner: isize, client: RECT, show: bool) {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::ClientToScreen;
    use windows::Win32::UI::WindowsAndMessaging::*;
    let mut at = POINT { x: client.left, y: client.top };
    unsafe {
        let _ = ClientToScreen(HWND(owner as *mut _), &mut at);
        let flags = SWP_NOACTIVATE | SWP_NOOWNERZORDER | if show { SWP_SHOWWINDOW } else { SWP_HIDEWINDOW };
        let _ = SetWindowPos(HWND(host as *mut _), None, at.x, at.y, client.right - client.left, client.bottom - client.top, flags | SWP_NOZORDER);
    }
}

fn hide_host(host: isize) {
    use windows::Win32::UI::WindowsAndMessaging::{SW_HIDE, ShowWindow};
    if host != 0 {
        let _ = unsafe { ShowWindow(HWND(host as *mut _), SW_HIDE) };
    }
}

/// The tab's page, created when it does not exist yet, sent to `url` when it is somewhere else.
pub fn ensure(id: EntityId, hwnd: isize, url: &str, tx: UnboundedSender<WebEvent>) {
    let start = TABS.with_borrow_mut(|tabs| {
        let t = tabs.entry(id).or_default();
        t.hwnd = hwnd;
        if t.host == 0 {
            t.host = create_host(hwnd);
        }
        t.tx = Some(tx);
        t.want = url.to_string();
        if t.webview.is_some() {
            Next::Go(go_if_elsewhere(t))
        } else if t.creating {
            Next::Wait
        } else {
            t.creating = true;
            Next::Create
        }
    });
    // (WebView2 may answer inside a call, events and all: it is never called while the tabs are borrowed)
    match start {
        Next::Go(Some((w, url))) => navigate(&w, &url),
        Next::Create => with_env(id),
        _ => {}
    }
}

enum Next {
    Go(Option<(ICoreWebView2, String)>),
    Create,
    Wait,
}

/// Where the page has to go when the tab wants it somewhere else: the page and the address, sent off once the borrow is over.
fn go_if_elsewhere(t: &mut Tab) -> Option<(ICoreWebView2, String)> {
    if t.want.is_empty() || t.want == t.current {
        return None;
    }
    let w = t.webview.clone()?;
    t.current = t.want.clone();
    Some((w, t.want.clone()))
}

fn navigate(w: &ICoreWebView2, url: &str) {
    let wide = CoTaskMemPWSTR::from(url);
    if let Err(e) = unsafe { w.Navigate(*wide.as_ref().as_pcwstr()) } {
        log::warn!("web: navigate {url}: {e}");
    }
}

/// Puts the tab's page over `bounds` (device pixels in the window's client area) and shows it.
pub fn place(id: EntityId, bounds: RECT) {
    let todo = TABS.with_borrow_mut(|tabs| {
        let t = tabs.get_mut(&id)?;
        let resized = (t.bounds.right - t.bounds.left, t.bounds.bottom - t.bounds.top) != (bounds.right - bounds.left, bounds.bottom - bounds.top);
        let show = !t.visible;
        t.bounds = bounds;
        t.visible = true;
        Some((t.host, t.hwnd, t.controller.clone(), resized, show))
    });
    let Some((host, owner, controller, resized, show)) = todo else { return };
    // (every call: the owner may have moved on the screen, which leaves the client coordinates as they were)
    set_host(host, owner, bounds, true);
    if let Some(c) = controller {
        unsafe {
            if resized || show {
                let _ = c.SetBounds(RECT { left: 0, top: 0, right: bounds.right - bounds.left, bottom: bounds.bottom - bounds.top });
                let _ = c.NotifyParentWindowPositionChanged();
            }
            if show {
                let _ = c.SetIsVisible(true);
            }
        }
    }
}

/// Hides every page of window `hwnd` but the one of tab `keep` (the workspace calls it each frame with its active tab).
pub fn show_only(hwnd: isize, keep: Option<EntityId>) {
    let hide: Vec<(isize, Option<ICoreWebView2Controller>)> = TABS.with_borrow_mut(|tabs| {
        let mut v = Vec::new();
        for (id, t) in tabs.iter_mut() {
            if t.hwnd == hwnd && Some(*id) != keep && t.visible {
                t.visible = false;
                v.push((t.host, t.controller.clone()));
            }
        }
        v
    });
    for (host, c) in hide {
        hide_host(host);
        if let Some(c) = c {
            let _ = unsafe { c.SetIsVisible(false) };
        }
    }
}

pub fn reload(id: EntityId) {
    if let Some(w) = TABS.with_borrow(|tabs| tabs.get(&id).and_then(|t| t.webview.clone())) {
        let _ = unsafe { w.Reload() };
    }
}

/// The keyboard goes to the page (a click on the tab, Ctrl+L away from the address bar).
pub fn focus(id: EntityId) {
    if let Some(c) = TABS.with_borrow(|tabs| tabs.get(&id).and_then(|t| t.controller.clone())) {
        let _ = unsafe { c.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC) };
    }
}

pub fn title(id: EntityId) -> Option<String> {
    TABS.with_borrow(|tabs| tabs.get(&id).map(|t| t.title.clone()).filter(|t| !t.is_empty()))
}

/// The tab is gone: its page closes and its browser process lets go of it.
pub fn close(id: EntityId) {
    crate::terminal::close(id);
    if let Some(t) = TABS.with_borrow_mut(|tabs| tabs.remove(&id)) {
        if let Some(c) = t.controller {
            let _ = unsafe { c.Close() };
        }
        if t.host != 0 {
            let _ = unsafe { windows::Win32::UI::WindowsAndMessaging::DestroyWindow(HWND(t.host as *mut _)) };
        }
    }
}

/// Runs the creation of tab `id`'s page once the environment is there (creating the environment first if need be).
fn with_env(id: EntityId) {
    let ready = ENV.with_borrow_mut(|env| match env {
        Env::Ready(e) => Some(e.clone()),
        Env::Pending(waiting) => {
            waiting.push(id);
            None
        }
        Env::Failed => None,
        Env::None => {
            *env = Env::Pending(vec![id]);
            None
        }
    });
    if let Some(e) = ready {
        create_controller(id, &e);
    } else if !STARTED.replace(true) {
        // (outside the borrow: the environment may be made, and the waiting pages created, inside this call)
        start_env();
    }
}

fn start_env() {
    let dir = data_dir();
    let _ = std::fs::create_dir_all(&dir);
    let handler = CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(move |hr, env| {
        let waiting = ENV.with_borrow_mut(|state| {
            let waiting = match std::mem::replace(state, Env::Failed) {
                Env::Pending(w) => w,
                _ => Vec::new(),
            };
            match (hr, env) {
                (Ok(()), Some(e)) => *state = Env::Ready(e),
                (r, _) => log::warn!("web: no WebView2 environment: {r:?}"),
            }
            waiting
        });
        if let Some(e) = ENV.with_borrow(|s| if let Env::Ready(e) = s { Some(e.clone()) } else { None }) {
            for id in waiting {
                create_controller(id, &e);
            }
        }
        Ok(())
    }));
    let dir = HSTRING::from(dir.as_os_str());
    if let Err(e) = unsafe { CreateCoreWebView2EnvironmentWithOptions(None, &dir, None, &handler) } {
        log::warn!("web: WebView2 runtime missing? {e}");
        ENV.with_borrow_mut(|s| *s = Env::Failed);
    }
}

fn create_controller(id: EntityId, env: &ICoreWebView2Environment) {
    // (the page's own window is its parent: see the module's note)
    let Some(hwnd) = TABS.with_borrow(|tabs| tabs.get(&id).map(|t| t.host).filter(|h| *h != 0)) else { return };
    let handler = CreateCoreWebView2ControllerCompletedHandler::create(Box::new(move |hr, controller| {
        let Some(controller) = controller.filter(|_| hr.is_ok()) else {
            log::warn!("web: no WebView2 controller: {hr:?}");
            return Ok(());
        };
        // the tab was closed while its page was being made
        if !TABS.with_borrow(|tabs| tabs.contains_key(&id)) {
            let _ = unsafe { controller.Close() };
            return Ok(());
        }
        let webview = unsafe { controller.CoreWebView2()? };
        unsafe {
            // Pulse's ground behind a page that has not painted yet (no white flash on the dark window)
            if let Ok(c2) = controller.cast::<ICoreWebView2Controller2>() {
                let _ = c2.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR { A: 255, R: 9, G: 9, B: 9 });
            }
            let mut token = 0i64;
            webview.add_SourceChanged(
                &SourceChangedEventHandler::create(Box::new(move |sender, _| {
                    if let Some(w) = sender {
                        let mut s = PWSTR::null();
                        if w.Source(&mut s).is_ok() {
                            let url = take_pwstr(s);
                            send(id, |t| {
                                t.current = url.clone();
                                t.want = url.clone();
                                WebEvent::Url(url)
                            });
                        }
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            webview.add_DocumentTitleChanged(
                &DocumentTitleChangedEventHandler::create(Box::new(move |sender, _| {
                    if let Some(w) = sender {
                        let mut s = PWSTR::null();
                        if w.DocumentTitle(&mut s).is_ok() {
                            let title = take_pwstr(s);
                            send(id, |t| {
                                t.title = title.clone();
                                WebEvent::Title(title)
                            });
                        }
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            // terminal tabs: our page from the app's files, and its messages to the shell behind it (only from that page)
            if let (Some(dir), Ok(w3)) = (crate::terminal::page_dir(), webview.cast::<ICoreWebView2_3>()) {
                let (host, folder) = (HSTRING::from(crate::terminal::HOST), HSTRING::from(dir.as_os_str()));
                let _ = w3.SetVirtualHostNameToFolderMapping(windows::core::PCWSTR(host.as_ptr()), windows::core::PCWSTR(folder.as_ptr()), COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY_CORS);
            }
            webview.add_WebMessageReceived(
                &WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut src = PWSTR::null();
                    args.Source(&mut src)?;
                    if !crate::terminal::is_terminal(&take_pwstr(src)) {
                        return Ok(());
                    }
                    let mut s = PWSTR::null();
                    if args.TryGetWebMessageAsString(&mut s).is_err() {
                        return Ok(());
                    }
                    let text = take_pwstr(s);
                    let Some((host, owner)) = TABS.with_borrow(|tabs| tabs.get(&id).map(|t| (t.host, t.hwnd))) else { return Ok(()) };
                    if let Some(cmd) = crate::terminal::on_message(id, host, owner, &text) {
                        send(id, |_| WebEvent::Terminal(cmd));
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            webview.add_NewWindowRequested(
                &NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        let mut s = PWSTR::null();
                        if args.Uri(&mut s).is_ok() {
                            let url = take_pwstr(s);
                            args.SetHandled(true)?;
                            send(id, |_| WebEvent::NewTab(url));
                        }
                    }
                    Ok(())
                })),
                &mut token,
            )?;
        }
        let state = TABS.with_borrow_mut(|tabs| {
            let t = tabs.get_mut(&id)?;
            t.creating = false;
            t.controller = Some(controller.clone());
            t.webview = Some(webview.clone());
            Some((t.bounds, t.visible, go_if_elsewhere(t)))
        });
        if let Some((bounds, visible, go)) = state {
            unsafe {
                let _ = controller.SetBounds(RECT { left: 0, top: 0, right: bounds.right - bounds.left, bottom: bounds.bottom - bounds.top });
                let _ = controller.SetIsVisible(visible);
            }
            if let Some((w, url)) = go {
                navigate(&w, &url);
            }
        }
        Ok(())
    }));
    if let Err(e) = unsafe { env.CreateCoreWebView2Controller(HWND(hwnd as *mut _), &handler) } {
        log::warn!("web: create controller: {e}");
    }
}

/// Sends a message to tab `id`'s page (a terminal tab's output and names).
pub fn post(id: EntityId, json: &str) {
    let Some(w) = TABS.with(|tabs| tabs.try_borrow().ok().and_then(|t| t.get(&id).and_then(|t| t.webview.clone()))) else { return };
    let text = HSTRING::from(json);
    if let Err(e) = unsafe { w.PostWebMessageAsString(windows::core::PCWSTR(text.as_ptr())) } {
        log::debug!("terminal: post: {e}");
    }
}

/// Updates tab `id` and sends what `f` makes of it to the tab's folder view.
fn send(id: EntityId, f: impl FnOnce(&mut Tab) -> WebEvent) {
    TABS.with(|tabs| {
        // (should an event ever come inside one of our own calls, it is dropped rather than a panic: a page raises its address and
        // title again as it loads)
        let Ok(mut tabs) = tabs.try_borrow_mut() else { return };
        if let Some(t) = tabs.get_mut(&id) {
            let ev = f(t);
            if let Some(tx) = &t.tx {
                let _ = tx.unbounded_send(ev);
            }
        }
    });
}

// ---------------------------------------------------------------- tabs asked for from outside a window

/// Pages to open as new tabs, asked for where no window is at hand (an `.html` file opened from the list): the next window that
/// draws takes them.
#[derive(Default)]
pub struct PendingTabs(pub Vec<String>);
impl gpui_kit::Global for PendingTabs {}

pub fn request_tab(url: String, cx: &mut gpui_kit::App) {
    cx.default_global::<PendingTabs>().0.push(url);
    cx.refresh_windows();
}

/// Files a browser tab shows instead of their program.
pub fn is_web_file(path: &std::path::Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "html" | "htm" | "xhtml" | "mht" | "mhtml"))
}

#[cfg(test)]
mod tests {
    use super::{file_url, looks_like_url, normalize};

    #[test]
    fn web_addresses_are_told_from_places() {
        for t in ["https://example.com", "www.rust-lang.org", "example.com", "docs.rs/gpui", "about:blank"] {
            assert!(looks_like_url(t), "{t}");
        }
        for t in [r"C:\Users", "Downloads", "..", "@work", "%USERPROFILE%", "notes.txt", "photo.jpg",r"\\server\share", "report.pdf2"] {
            assert!(!looks_like_url(t), "{t}");
        }
    }

    #[test]
    fn addresses_get_a_scheme() {
        assert_eq!(normalize("example.com"), "https://example.com");
        assert_eq!(normalize("http://a.b/c"), "http://a.b/c");
        assert_eq!(normalize(r"C:\a b\x.html"), "file:///C:/a%20b/x.html");
        assert_eq!(file_url(std::path::Path::new(r"D:\#1\x.htm")), "file:///D:/%231/x.htm");
    }
}
