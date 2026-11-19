//! rustyfiles palette, in Pulse Explorer's colours: Pulse's warm grey line from #090909 to #f2f2ed
//! (apps/web/src/styles/index.css). Strictly achromatic: the accent is Phosphor White on dark and
//! Ground on light, and state reads as brightness.

use gpui_kit::*;

#[derive(Clone, Copy)]
#[allow(dead_code)]
pub struct Palette {
    pub dark: bool,
    /// Window background drawn over Mica (semi-transparent so the backdrop shows through).
    pub window_bg: Hsla,
    pub titlebar_bg: Hsla,
    pub sidebar_bg: Hsla,
    pub content_bg: Hsla,
    /// Opaque surface for menus, dialogs and inputs that float over other content.
    pub card_bg: Hsla,
    /// A bar of our own with controls and text in it that no other layer backs (the Open / Save window's name row). Clear on every
    /// backdrop but glass, where it is a wash of its own: the text must not sit straight on the live screen.
    pub bar_bg: Hsla,
    /// Cards that sit on the content layer (Home tiles, preview boxes): Fluent's translucent
    /// CardBackgroundFillColorDefault, so the backdrop tint shows through like in Explorer.
    pub tile_bg: Hsla,
    pub tile_hover: Hsla,
    pub border: Hsla,
    pub divider: Hsla,
    pub text: Hsla,
    pub text_secondary: Hsla,
    pub text_tertiary: Hsla,
    pub accent: Hsla,
    pub accent_text: Hsla,
    pub hover: Hsla,
    pub pressed: Hsla,
    pub selection: Hsla,
    pub selection_border: Hsla,
    pub tab_active: Hsla,
    pub danger: Hsla,
    /// The controls of this window are drawn the liquid way (the window shows glass, or it is a popup opened from one): see `liquid`.
    /// Set by `for_window`; `light()` and `dark()` are the classic look.
    pub liquid: bool,
}

fn hex(c: u32) -> Hsla {
    rgb(c).into()
}

fn hexa(c: u32, a: f32) -> Hsla {
    let mut h: Hsla = rgb(c).into();
    h.a = a;
    h
}

/// Pulse's grey line (apps/web/src/styles/index.css).
pub const PULSE_GROUND: u32 = 0x090909;
pub const PULSE_RAISED: u32 = 0x0E0E0E;
pub const PULSE_WELL: u32 = 0x0F0F0E;
pub const PULSE_MENU: u32 = 0x181817;
pub const PULSE_EDGE: u32 = 0x2A2A28;
pub const PULSE_RULE: u32 = 0x303030;
pub const PULSE_DIM: u32 = 0x757573;
pub const PULSE_MID: u32 = 0xB3B3AD;
pub const PULSE_ON: u32 = 0xF2F2ED;
pub const PULSE_PAPER: u32 = 0xE6E6E0;

/// The accent palette the app wears: the colour the user chose for rustyfiles (Settings > Appearance), else none and the palette
/// keeps Pulse's achromatic accent (Windows' accent colour is not used: Pulse has no hue).
fn system_accent() -> Option<rf_win::accent::AccentPalette> {
    rf_win::accent::override_color().map(rf_win::accent::from_color)
}

impl Palette {
    // Fluent (Windows 11) values: chrome is Mica, content sits on one translucent layer,
    // selection is a quiet neutral fill plus an accent pill (see `selection_pill`), and the
    // accent is the user's own Windows accent color.
    pub fn light() -> Self {
        let accent = system_accent().map(|a| a.dark1()).unwrap_or(PULSE_GROUND);
        Self {
            dark: false,
            window_bg: hexa(PULSE_PAPER, 0.55),
            titlebar_bg: hexa(PULSE_PAPER, 0.0),
            sidebar_bg: hexa(PULSE_ON, 0.0),
            content_bg: hexa(PULSE_ON, 0.60),
            card_bg: hex(PULSE_ON),
            bar_bg: hexa(PULSE_ON, 0.0),
            tile_bg: hexa(PULSE_ON, 0.75),
            tile_hover: hexa(PULSE_ON, 0.55),
            border: hexa(PULSE_GROUND, 0.10),
            divider: hexa(PULSE_GROUND, 0.08),
            text: hex(PULSE_GROUND),
            text_secondary: hexa(PULSE_GROUND, 0.64),
            text_tertiary: hexa(PULSE_GROUND, 0.46),
            accent: hex(accent),
            accent_text: hex(PULSE_ON),
            hover: hexa(PULSE_GROUND, 0.05),
            pressed: hexa(PULSE_GROUND, 0.09),
            selection: hexa(PULSE_GROUND, 0.08),
            selection_border: hexa(accent, 0.55),
            tab_active: hexa(PULSE_ON, 0.80),
            // (Pulse's lit-or-not rule: danger is full-strength ink, not a hue)
            danger: hex(PULSE_GROUND),
            liquid: false,
        }
    }

    /// Pure black for OLED screens (issue 45): the dark palette with every surface black and opaque, the text white, and the lines
    /// and fills just bright enough to be seen on black.
    pub fn black() -> Self {
        Self {
            window_bg: hex(0x000000),
            titlebar_bg: hexa(0x000000, 0.0),
            sidebar_bg: hexa(0x000000, 0.0),
            content_bg: hex(0x000000),
            card_bg: hex(PULSE_GROUND),
            bar_bg: hexa(0x000000, 0.0),
            tile_bg: hexa(PULSE_ON, 0.04),
            tile_hover: hexa(PULSE_ON, 0.08),
            border: hexa(PULSE_ON, 0.14),
            divider: hexa(PULSE_ON, 0.12),
            text: hex(PULSE_ON),
            text_secondary: hexa(PULSE_ON, 0.72),
            text_tertiary: hexa(PULSE_ON, 0.50),
            hover: hexa(PULSE_ON, 0.08),
            pressed: hexa(PULSE_ON, 0.12),
            selection: hexa(PULSE_ON, 0.11),
            tab_active: hexa(PULSE_ON, 0.08),
            ..Self::dark()
        }
    }

    pub fn dark() -> Self {
        let accent = system_accent().map(|a| a.light2()).unwrap_or(PULSE_ON);
        Self {
            dark: true,
            // Pulse's ground as a heavy wash: over Mica the desktop barely tints it, and the Solid material paints it opaque
            window_bg: hexa(PULSE_GROUND, 0.82),
            titlebar_bg: hexa(PULSE_GROUND, 0.0),
            sidebar_bg: hexa(PULSE_GROUND, 0.0),
            content_bg: hexa(PULSE_RAISED, 0.70),
            card_bg: hex(PULSE_MENU),
            bar_bg: hexa(PULSE_MENU, 0.0),
            tile_bg: hexa(PULSE_WELL, 0.90),
            tile_hover: hexa(PULSE_EDGE, 0.60),
            border: hex(PULSE_EDGE),
            divider: hex(PULSE_RULE),
            text: hex(PULSE_ON),
            text_secondary: hex(PULSE_MID),
            text_tertiary: hex(PULSE_DIM),
            accent: hex(accent),
            // text on Phosphor White is Ground
            accent_text: hex(PULSE_GROUND),
            hover: hexa(PULSE_ON, 0.05),
            pressed: hexa(PULSE_ON, 0.09),
            selection: hexa(PULSE_ON, 0.08),
            selection_border: hexa(accent, 0.55),
            tab_active: hexa(PULSE_ON, 0.06),
            // (Pulse's lit-or-not rule: danger is full brightness, not a hue)
            danger: hex(PULSE_ON),
            liquid: false,
        }
    }

    pub fn for_window(window: &Window) -> Self {
        let mut p = match crate::settings::theme_override() {
            crate::settings::ThemePref::Light => Self::light(),
            crate::settings::ThemePref::Dark => Self::dark(),
            crate::settings::ThemePref::Black => Self::black(),
            crate::settings::ThemePref::System => match window.appearance() {
                WindowAppearance::Dark | WindowAppearance::VibrantDark => Self::dark(),
                _ => Self::light(),
            },
        };
        if crate::settings::solid_backdrop() {
            // "Solid" material: Windows 11's plain window color instead of Mica
            p.window_bg = if p.dark { hex(PULSE_GROUND) } else { hex(PULSE_PAPER) };
        }
        if crate::settings::theme_override() == crate::settings::ThemePref::Black {
            // (opaque black whatever the material: no glass, no washes)
            return p;
        }
        let hwnd = crate::look::window::hwnd_of(window);
        // one place decides the look of the controls: every control asks the palette
        p.liquid = crate::glass::liquid(hwnd);
        if crate::glass::shown(hwnd) {
            // Over the glass the two washes are the veil: Mica is already a quiet, nearly opaque tone, the glass is the live screen.
            // At the strength made for Mica they hid two thirds of it in the dark theme (the user: too black), so the default is half
            // of that; the HyperGlass "surface wash" setting moves it either way.
            let (w, c) = glass_washes(p.dark, crate::settings::hg_surface());
            // Pulse Explorer's build: the glass is a subtle frost under a heavy wash of Pulse's ground, never the bare screen
            let (fw, fc) = if p.dark { (0.62, 0.55) } else { (0.55, 0.50) };
            (p.window_bg.a, p.content_bg.a) = (w.max(fw), c.max(fc));
            p.bar_bg = Hsla { a: glass_bar_wash(crate::settings::hg_surface()), ..p.card_bg };
        }
        p
    }
}

impl Palette {
    /// The palette of a window that is MATTE whatever material the user chose: its own plain colour as the window's surface, the
    /// one the "Solid" material has. For the Open / Save window (the user, with a picture of it over a busy desktop: "aç
    /// penceresinde ... arkaplanı da mat"): it opens over another program's window, and a see-through material showed that program
    /// and the desktop through the file list.
    pub fn matte(mut self) -> Self {
        self.window_bg = if self.dark { hex(PULSE_GROUND) } else { hex(PULSE_PAPER) };
        self
    }
}

/// The material a window asks Windows for: the wanted one where Windows has materials, none where it has not (`rf_win::osver`,
/// issue 24). There the palette paints the window itself (`settings::solid_backdrop`), and asking for "none" also switches off a
/// blur-behind that an earlier choice may have left on the window. A see-through window (glass, an overlay) stays what it is.
pub fn window_material(wanted: WindowBackgroundAppearance) -> WindowBackgroundAppearance {
    match wanted {
        WindowBackgroundAppearance::Transparent | WindowBackgroundAppearance::Opaque => wanted,
        _ if crate::settings::materials_available() => wanted,
        _ => WindowBackgroundAppearance::Opaque,
    }
}

/// [`window_material`] for a MAIN window: on a Windows without materials it may still have Acrylic, the old blur behind it, when that
/// is the chosen material (`settings::main_window_only`, issue 78). Popups never ask this.
pub fn main_window_material(wanted: WindowBackgroundAppearance) -> WindowBackgroundAppearance {
    match wanted {
        WindowBackgroundAppearance::Blurred if !crate::settings::materials_available() => WindowBackgroundAppearance::Blurred,
        _ => window_material(wanted),
    }
}

/// The material of a popup (a menu, a flyout, a drop-down list): real glass when it was opened from a window that shows glass,
/// else Windows' Acrylic, else none (and then [`popup_fill`] is its surface).
pub fn popup_material(liquid: bool) -> WindowBackgroundAppearance {
    if liquid { WindowBackgroundAppearance::Transparent } else { window_material(WindowBackgroundAppearance::Blurred) }
}

/// What a popup paints behind its content on a Windows that gives it no Acrylic: the plain colour Windows 11 itself uses for a
/// flyout without transparency. `None` where the Acrylic is the surface and the popup paints nothing.
pub fn popup_fill(p: &Palette) -> Option<Hsla> {
    (!crate::settings::materials_available()).then(|| if p.dark { hex(PULSE_MENU) } else { hex(PULSE_ON) })
}

/// The alpha of `window_bg` and `content_bg` over a window that shows glass, for the surface value (0..=100) of the HyperGlass
/// settings. 50 is the veil the app shipped with (dark 0.18 / 0.22, light 0.20 / 0.35), 0 is no veil at all and 100 is the strength made
/// for Mica (dark 0.40 / 0.45, light 0.30 / 0.50: the values in `Palette::dark` and `light`); each side of 50 is a straight line. A
/// value above 100 counts as 100.
pub fn glass_washes(dark: bool, surface: u8) -> (f32, f32) {
    let ((w50, c50), (w100, c100)) = if dark { ((0.18, 0.22), (0.40, 0.45)) } else { ((0.20, 0.35), (0.30, 0.50)) };
    let v = f32::from(surface.min(100));
    let lerp = |a: f32, b: f32, t: f32| a * (1.0 - t) + b * t;
    if v <= 50.0 {
        let t = v / 50.0;
        (lerp(0.0, w50, t), lerp(0.0, c50, t))
    } else {
        let t = (v - 50.0) / 50.0;
        (lerp(w50, w100, t), lerp(c50, c100, t))
    }
}

/// The alpha of `Palette::bar_bg` over glass. It follows the surface value too, but never gets thin: 0.40 at 0, 0.55 at the default 50
/// and 0.70 at 100, so a bar's text is readable whatever the picture behind the glass is.
pub fn glass_bar_wash(surface: u8) -> f32 {
    0.40 + 0.30 * f32::from(surface.min(100)) / 100.0
}

/// Icon tint per file category: steps on Pulse's grey line, brightest for folders (no hues, as in Pulse).
pub fn kind_color(cat: crate::icons::Category, dark: bool) -> Hsla {
    use crate::icons::Category::*;
    let (on_dark, on_light) = match cat {
        Folder => (0xF2F2ED, 0x181817),
        Image | Video | Audio => (0xD6D6D0, 0x3A3A37),
        Document | Spreadsheet | Pdf | Code => (0xB3B3AD, 0x4A4A47),
        Archive | Executable | Text | Other => (0x8C8C88, 0x757573),
    };
    hex(if dark { on_dark } else { on_light })
}

/// The selection marker shared by every list (sidebar, details, columns, menus): a short
/// rounded accent bar on the left edge of a selected row. The row must be `relative()`.
pub fn selection_pill(p: &Palette) -> Div {
    div().absolute().left(px(0.)).top(px(8.)).bottom(px(8.)).w(px(3.)).rounded_full().bg(p.accent)
}

/// Pulse's 5x7 dot font (assets/fonts/PulsePixel.ttf, made by tools/pulse-pixel/build_font.py) for headings, as the PixelText
/// headings of Pulse Explorer's web app. Letters it has no dot for fall back to the system font.
pub const HEADING_FONT: &str = "Pulse Pixel";

/// Makes [`HEADING_FONT`] known to this process's text system. Once per process.
pub fn register_fonts(cx: &mut App) {
    static DONE: std::sync::Once = std::sync::Once::new();
    DONE.call_once(|| {
        let ttf: &'static [u8] = include_bytes!("../assets/fonts/PulsePixel.ttf");
        if let Err(e) = cx.text_system().add_fonts(vec![std::borrow::Cow::Borrowed(ttf)]) {
            log::warn!("Pulse Pixel font: {e}");
        }
    });
}

/// A title (a page, a dialog) in [`HEADING_FONT`]: 20 px, so a dot is 2 whole pixels, and no synthetic bold.
pub fn heading(el: Div) -> Div {
    el.font_family(HEADING_FONT).font_weight(FontWeight::NORMAL).text_size(px(20.))
}

/// A section heading in [`HEADING_FONT`]: 15 px (1.5 px dots), next to body text.
pub fn subheading(el: Div) -> Div {
    el.font_family(HEADING_FONT).font_weight(FontWeight::NORMAL).text_size(px(15.))
}

/// Puts a popup back to the size it was opened at. On a monitor whose scaling differs from the one the app started on, Windows
/// scales a new popup a second time as it moves there (seen at 150 %: a menu 2.25 times its size, the rows at 1.5 times and the
/// rest an empty panel). Called from the popup's render: a size that is right does nothing.
pub fn hold_popup_size(window: &mut Window, want: Size<Pixels>) {
    let vp = window.viewport_size();
    let off = |a: Pixels, b: Pixels| (f32::from(a) - f32::from(b)).abs() > 1.;
    if off(vp.width, want.width) || off(vp.height, want.height) {
        window.on_next_frame(move |w, _| w.resize(want));
    }
}

pub const RADIUS: Pixels = px(8.);
pub const RADIUS_SM: Pixels = px(6.);
pub const ROW_H: Pixels = px(30.);
pub const TITLEBAR_H: Pixels = px(40.);

#[cfg(test)]
mod tests {
    use super::{glass_bar_wash, glass_washes};

    #[test]
    fn a_bar_over_glass_always_keeps_a_wash_of_its_own() {
        assert!((glass_bar_wash(0) - 0.40).abs() < 1e-6);
        assert!((glass_bar_wash(50) - 0.55).abs() < 1e-6);
        assert!((glass_bar_wash(100) - 0.70).abs() < 1e-6);
        assert_eq!(glass_bar_wash(200), glass_bar_wash(100));
        assert!((0..=100u8).all(|v| glass_bar_wash(v) >= 0.40), "readable at every setting");
    }

    #[test]
    fn the_default_surface_is_the_shipped_veil_exactly() {
        assert_eq!(glass_washes(true, 50), (0.18, 0.22));
        assert_eq!(glass_washes(false, 50), (0.20, 0.35));
        assert_eq!(glass_washes(true, crate::settings::HG_DEFAULT[4]), (0.18, 0.22), "and 50 is what the settings default to");
    }

    #[test]
    fn the_ends_are_no_veil_and_the_mica_strength() {
        assert_eq!(glass_washes(true, 0), (0.0, 0.0));
        assert_eq!(glass_washes(false, 0), (0.0, 0.0));
        assert_eq!(glass_washes(true, 100), (0.40, 0.45));
        assert_eq!(glass_washes(false, 100), (0.30, 0.50));
        assert_eq!(glass_washes(true, 255), glass_washes(true, 100), "a value out of range counts as the end");
    }

    #[test]
    fn the_veil_only_grows_with_the_value_and_stays_a_valid_alpha() {
        for dark in [true, false] {
            let mut last = (-1.0f32, -1.0f32);
            for v in 0..=100u8 {
                let (w, c) = glass_washes(dark, v);
                assert!(w >= last.0 && c >= last.1, "dark={dark} v={v}: {w} {c} after {last:?}");
                assert!((0.0..=1.0).contains(&w) && (0.0..=1.0).contains(&c));
                last = (w, c);
            }
        }
        // a quarter of the way is half of the shipped veil, three quarters is halfway to the Mica strength
        let (w, c) = glass_washes(true, 25);
        assert!((w - 0.09).abs() < 1e-6 && (c - 0.11).abs() < 1e-6, "{w} {c}");
        let (w, c) = glass_washes(false, 75);
        assert!((w - 0.25).abs() < 1e-6 && (c - 0.425).abs() < 1e-6, "{w} {c}");
    }
}

/// The display a popup of `owner` (a menu level, a flyout, a dropdown) is opened on: the owner's own.
///
/// WHY IT IS NAMED (issue 47, a 1920x1080 monitor at 100% beside a 3440x1440 one at 125%): positions are logical pixels, and on
/// Windows a monitor's logical pixels are its device pixels divided by its own scale, so the two monitors' logical ranges overlap. A
/// popup that names no display is put on the first display whose scale makes its position land on it, and a submenu meant for the
/// 100% monitor landed on the 125% one, a screen away and a quarter larger ("the menu breaks and shifts down"). The owner's
/// coordinates are its display's, so that display is the one that reads them right.
pub fn popup_display(owner: &Window, cx: &App) -> Option<DisplayId> {
    owner.display(cx).map(|d| d.id())
}
