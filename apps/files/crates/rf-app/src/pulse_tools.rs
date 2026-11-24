//! Pulse tools on Windows, the Mac's PulseFeatures.swift ported to the right-click menu: Copy text (OCR), Paste as
//! file, image tools, folder notes, Run script, Changed today and What's taking space. The logic lives in rf-pulse
//! (tested on both systems); this file is the menu items, the dialogs and the threads.

use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, SystemTime};

use futures::channel::oneshot;
use gpui_kit::assets::IconName as L;
use gpui_kit::*;
use rf_core::Location;

use crate::fluent_menu::{Item, MenuIcon};
use crate::folder_view::FolderView;
use crate::i18n::tx;
use crate::prompt::{self, Button, Kind};

type Me = WeakEntity<FolderView>;

fn icon(l: L) -> MenuIcon {
    MenuIcon::Lucide(l)
}

/// Runs `job` on its own thread, then `done` on the UI with the window the menu was in.
fn work<T: Send + 'static>(window: &Window, cx: &mut App, job: impl FnOnce() -> T + Send + 'static, done: impl FnOnce(T, &mut Window, &mut App) + 'static) {
    let (tx, rx) = oneshot::channel();
    std::thread::spawn(move || {
        let _ = tx.send(job());
    });
    finish(window, cx, rx, done);
}

fn finish<T: 'static>(window: &Window, cx: &mut App, rx: oneshot::Receiver<T>, done: impl FnOnce(T, &mut Window, &mut App) + 'static) {
    let handle = window.window_handle();
    cx.spawn(async move |cx| {
        let Ok(r) = rx.await else { return };
        let _ = cx.update_window(handle, move |_, window, cx| done(r, window, cx));
    })
    .detach();
}

fn reload(me: &Me, cx: &mut App) {
    let _ = me.update(cx, |v, cx| v.soft_reload(cx));
}

fn ok() -> Button {
    Button::new(tx("Tamam", "OK"), Kind::Primary, |_, _, _| Ok(()))
}

fn size(b: u64) -> String {
    let f = b as f64;
    match b {
        0..=1023 => format!("{b} B"),
        1024..=1_048_575 => format!("{:.0} KB", f / 1024.0),
        1_048_576..=1_073_741_823 => format!("{:.1} MB", f / 1_048_576.0),
        _ => format!("{:.2} GB", f / 1_073_741_824.0),
    }
}

fn name_of(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.display().to_string())
}

fn is_image(p: &Path) -> bool {
    p.is_file() && rf_win::ocr::can_read(p)
}

// ---------------------------------------------------------------------------------------------------------------
// the menus

/// Pulse's items for the selected files and folders.
pub fn selection_items(me: &Me, items: &[PathBuf]) -> Vec<Item> {
    let mut v = Vec::new();
    if items.len() == 1 && is_image(&items[0]) {
        let p = items[0].clone();
        v.push(Item::action(tx("Metni kopyala", "Copy text"), icon(L::ScanText), move |w, cx| copy_text(p.clone(), w, cx)));
    }
    if !items.is_empty() && items.iter().all(|p| is_image(p)) {
        let job = |label: &'static str, ic: L, kind: ImageJob| {
            let (me, list) = (me.clone(), items.to_vec());
            Item::action(label, icon(ic), move |w, cx| image_tool(me.clone(), list.clone(), kind, w, cx))
        };
        v.push(Item::sub(
            tx("Görüntü araçları", "Image tools"),
            icon(L::Image),
            vec![
                job(tx("JPEG'e dönüştür", "Convert to JPEG"), L::FileImage, ImageJob::Jpeg),
                job(tx("PNG'ye dönüştür", "Convert to PNG"), L::FileImage, ImageJob::Png),
                Item::Separator,
                job(tx("%50 küçült", "Resize to 50%"), L::Scaling, ImageJob::Scale(50)),
                job(tx("%25 küçült", "Resize to 25%"), L::Scaling, ImageJob::Scale(25)),
                job(tx("E-posta için sıkıştır", "Compress for email"), L::Mail, ImageJob::Email),
            ],
        ));
    }
    if items.len() == 1 && items[0].is_file() && rf_pulse::scripts::handles(&items[0]) {
        if let Some(sub) = script_menu(&items[0]) {
            v.push(sub);
        }
    }
    if items.len() == 1 && items[0].is_dir() {
        let d = items[0].clone();
        v.push(Item::action(note_label(&d), icon(L::StickyNote), move |w, cx| edit_note(d.clone(), w, cx)));
    }
    v
}

/// Pulse's items for the folder background.
pub fn background_items(me: &Me, dir: &Path) -> Vec<Item> {
    let mut v = Vec::new();
    {
        let (me, d) = (me.clone(), dir.to_path_buf());
        v.push(Item::action(tx("Dosya olarak yapıştır", "Paste as file"), icon(L::ClipboardPaste), move |w, cx| paste_as_file(me.clone(), d.clone(), w, cx)));
    }
    {
        let d = dir.to_path_buf();
        v.push(Item::action(note_label(dir), icon(L::StickyNote), move |w, cx| edit_note(d.clone(), w, cx)));
    }
    if let Some(sub) = rf_pulse::scripts::FILES.iter().map(|f| dir.join(f)).find(|f| f.is_file()).and_then(|f| script_menu(&f)) {
        v.push(sub);
    }
    {
        let (me, d) = (me.clone(), dir.to_path_buf());
        v.push(Item::action(tx("Bugün değişenler", "Changed today"), icon(L::CalendarClock), move |_, cx| {
            let d = d.clone();
            let _ = me.update(cx, |v, cx| v.navigate(Location::Search { root: d, query: "datemodified:today".into() }, cx));
        }));
    }
    {
        let (me, d) = (me.clone(), dir.to_path_buf());
        v.push(Item::action(tx("Yeri ne kaplıyor?", "What's taking space?"), icon(L::HardDrive), move |w, cx| find_space(me.clone(), d.clone(), w, cx)));
    }
    v
}

// ---------------------------------------------------------------------------------------------------------------
// Copy text (Windows.Media.Ocr)

fn copy_text(path: PathBuf, window: &mut Window, cx: &mut App) {
    work(window, cx, move || rf_win::ocr::text_of(&path).map_err(|e| e.message().to_string()), |r, window, cx| match r {
        Ok(text) if !text.trim().is_empty() => {
            cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
            let lines = text.lines().count();
            let mut preview: String = text.chars().take(400).collect();
            if preview.len() < text.len() {
                preview.push('…');
            }
            prompt::notice(format!("{} ({lines})", tx("Metin kopyalandı", "Text copied")), preview, window, cx);
        }
        Ok(_) => prompt::notice(tx("Metin bulunamadı", "No text found"), tx("Bu resimde okunabilir metin yok.", "Windows found no readable text in this picture.").into(), window, cx),
        Err(e) => prompt::notice(tx("Metin okunamadı", "Couldn't read the text"), e, window, cx),
    });
}

// ---------------------------------------------------------------------------------------------------------------
// Paste as file

fn paste_as_file(me: Me, dir: PathBuf, window: &mut Window, cx: &mut App) {
    let (tx_, rx) = oneshot::channel();
    // the clipboard is read on the shell's thread (it owns a window, as OpenClipboard wants)
    rf_win::sta::run(move |owner| {
        let png = rf_win::clipboard::get_png(owner);
        let text = rf_win::clipboard::get_text(owner);
        let r = match rf_pulse::clipboard::choose(png, text, None) {
            None => Ok(None),
            Some(content) => {
                let existing: std::collections::HashSet<String> = std::fs::read_dir(&dir)
                    .map(|r| r.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_lowercase()).collect())
                    .unwrap_or_default();
                let (name, bytes) = rf_pulse::clipboard::output(&content, chrono::Local::now(), true, |n| existing.contains(&n.to_lowercase()));
                let dest = dir.join(&name);
                std::fs::write(&dest, bytes).map(|_| Some(name)).map_err(|e| e.to_string())
            }
        };
        let _ = tx_.send(r);
    });
    finish(window, cx, rx, move |r, window, cx| match r {
        Ok(Some(_)) => reload(&me, cx),
        Ok(None) => prompt::notice(tx("Pano boş", "Nothing to paste"), tx("Panoda resim, bağlantı ya da metin yok.", "The clipboard has no picture, link or text.").into(), window, cx),
        Err(e) => prompt::notice(tx("Yapıştırılamadı", "Couldn't paste"), e, window, cx),
    });
}

// ---------------------------------------------------------------------------------------------------------------
// Image tools (the image crate; the result goes next to the picture, the original stays)

#[derive(Clone, Copy)]
enum ImageJob {
    Jpeg,
    Png,
    Scale(u32),
    Email,
}

fn image_tool(me: Me, paths: Vec<PathBuf>, job: ImageJob, window: &mut Window, cx: &mut App) {
    work(window, cx, move || paths.iter().filter_map(|p| convert(p, job).err().map(|e| format!("{}: {e}", name_of(p)))).collect::<Vec<_>>(), move |errors, window, cx| {
        reload(&me, cx);
        if !errors.is_empty() {
            prompt::show(tx("Bazı resimler yapılamadı", "Some pictures failed"), Some(errors.join("\n")), None, vec![ok()], window, cx);
        }
    });
}

fn convert(path: &Path, job: ImageJob) -> Result<PathBuf, String> {
    use image::imageops::FilterType;
    let img = image::ImageReader::open(path).map_err(|e| e.to_string())?.with_guessed_format().map_err(|e| e.to_string())?.decode().map_err(|e| e.to_string())?;
    let dir = path.parent().ok_or("no folder")?;
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Picture".into());
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let jpeg_like = matches!(ext.as_str(), "jpg" | "jpeg");
    let (img, base, out_ext, quality) = match job {
        ImageJob::Jpeg => (img, stem, "jpg", 90),
        ImageJob::Png => (img, stem, "png", 0),
        ImageJob::Scale(pct) => {
            let (w, h) = ((img.width() * pct / 100).max(1), (img.height() * pct / 100).max(1));
            (img.resize_exact(w, h, FilterType::Lanczos3), format!("{stem} ({pct}%)"), if jpeg_like { "jpg" } else { "png" }, 90)
        }
        ImageJob::Email => {
            let img = if img.width().max(img.height()) > 1600 { img.resize(1600, 1600, FilterType::Lanczos3) } else { img };
            (img, format!("{stem} (email)"), "jpg", 78)
        }
    };
    let name = rf_pulse::naming::unique_in(&base, out_ext, dir);
    let dest = dir.join(name);
    if out_ext == "jpg" {
        let mut f = std::io::BufWriter::new(std::fs::File::create(&dest).map_err(|e| e.to_string())?);
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut f, quality).encode_image(&img.to_rgb8()).map_err(|e| e.to_string())?;
    } else {
        img.save_with_format(&dest, image::ImageFormat::Png).map_err(|e| e.to_string())?;
    }
    Ok(dest)
}

// ---------------------------------------------------------------------------------------------------------------
// Folder notes (an NTFS stream on the folder, so the note moves and copies with it)

fn note_label(dir: &Path) -> &'static str {
    if rf_pulse::notes::read(dir).is_some() { tx("Klasör notunu düzenle…", "Edit folder note…") } else { tx("Klasör notu ekle…", "Add folder note…") }
}

pub fn edit_note(dir: PathBuf, window: &mut Window, cx: &mut App) {
    let current = rf_pulse::notes::read(&dir).unwrap_or_default();
    let title = format!("{} · {}", tx("Klasör notu", "Folder note"), name_of(&dir));
    let save_dir = dir.clone();
    let mut buttons = vec![Button::new(tx("Kaydet", "Save"), Kind::Primary, move |input, _, _| rf_pulse::notes::write(&save_dir, input.as_deref().unwrap_or("")))];
    if !current.is_empty() {
        let d = dir.clone();
        buttons.push(Button::new(tx("Notu sil", "Remove note"), Kind::Danger, move |_, _, _| rf_pulse::notes::write(&d, "")));
    }
    buttons.push(Button::new(tx("Vazgeç", "Cancel"), Kind::Normal, |_, _, _| Ok(())));
    prompt::show(title, None, Some((current, tx("Bu klasör hakkında bir not…", "A note about this folder…").into())), buttons, window, cx);
}

// ---------------------------------------------------------------------------------------------------------------
// Run script (package.json, Makefile, justfile, composer.json) in a terminal in the project's folder

fn script_menu(file: &Path) -> Option<Item> {
    let scripts = rf_pulse::scripts::ranked(rf_pulse::scripts::scripts(file));
    if scripts.is_empty() {
        return None;
    }
    let dir = file.parent()?.to_path_buf();
    let items = scripts
        .into_iter()
        .take(24)
        .map(|s| {
            let (d, cmd) = (dir.clone(), s.command.clone());
            Item::action(s.name.clone(), icon(L::Play), move |_, _| run_script(d.clone(), cmd.clone())).hint(s.detail.chars().take(40).collect::<String>())
        })
        .collect();
    Some(Item::sub(tx("Betik çalıştır", "Run script"), icon(L::Play), items))
}

fn run_script(dir: PathBuf, command: String) {
    std::thread::spawn(move || {
        let d = dir.to_string_lossy().to_string();
        // Windows Terminal splits its own commands at ';' (escaped as '\;')
        let wt_cmd = command.replace(';', "\\;");
        let wt = std::process::Command::new("wt.exe").args(["-d", &d, "powershell.exe", "-NoExit", "-Command", &wt_cmd]).spawn();
        if wt.is_err() {
            let _ = std::process::Command::new("powershell.exe").current_dir(&dir).args(["-NoExit", "-Command", &command]).spawn();
        }
    });
}

// ---------------------------------------------------------------------------------------------------------------
// What's taking space: duplicates and big files nobody opened for 90 days, under the folder

struct SpaceReport {
    duplicates: Vec<Vec<rf_pulse::disk::Item>>,
    unused: Vec<rf_pulse::disk::Item>,
    scanned: usize,
}

fn find_space(me: Me, dir: PathBuf, window: &mut Window, cx: &mut App) {
    work(
        window,
        cx,
        move || {
            let all = rf_pulse::disk::scan(&dir, 200_000, &|| false);
            let mut duplicates = rf_pulse::disk::duplicates(&all, 1 << 20, &|| false);
            duplicates.sort_by_key(|g| std::cmp::Reverse(rf_pulse::disk::wasted(g)));
            let mut unused = rf_pulse::disk::big_and_unused(&all, 100 << 20, Duration::from_secs(90 * 86_400), SystemTime::now());
            unused.sort_by_key(|i| std::cmp::Reverse(i.size));
            SpaceReport { duplicates, unused, scanned: all.len() }
        },
        move |r, window, cx| show_space(me, r, window, cx),
    );
}

fn show_space(me: Me, r: SpaceReport, window: &mut Window, cx: &mut App) {
    let wasted: u64 = r.duplicates.iter().map(|g| rf_pulse::disk::wasted(g)).sum();
    let unused_total: u64 = r.unused.iter().map(|i| i.size).sum();
    if r.duplicates.is_empty() && r.unused.is_empty() {
        let msg = format!("{} {}.", r.scanned, tx("dosyaya bakıldı; kopya ya da uzun süredir açılmamış büyük dosya yok", "files checked: no duplicates and no big files left unopened"));
        return prompt::notice(tx("Her şey derli toplu", "Nothing to clean up"), msg, window, cx);
    }
    let mut m = String::new();
    if !r.duplicates.is_empty() {
        m.push_str(&format!("{} · {} {}\n", tx("Kopyalar", "Duplicates"), size(wasted), tx("boşa", "wasted")));
        for g in r.duplicates.iter().take(8) {
            m.push_str(&format!("  {} × {}  ({})\n", g.len(), name_of(&g[0].path), size(g[0].size)));
        }
        if r.duplicates.len() > 8 {
            m.push_str(&format!("  … +{}\n", r.duplicates.len() - 8));
        }
    }
    if !r.unused.is_empty() {
        m.push_str(&format!("\n{} · {}\n", tx("90 gündür açılmamış büyük dosyalar", "Big files unopened for 90 days"), size(unused_total)));
        for i in r.unused.iter().take(8) {
            m.push_str(&format!("  {}  ({})\n", name_of(&i.path), size(i.size)));
        }
        if r.unused.len() > 8 {
            m.push_str(&format!("  … +{}\n", r.unused.len() - 8));
        }
    }
    let mut buttons = Vec::new();
    if !r.duplicates.is_empty() {
        // one copy of each stays (the shortest path: usually the original); the rest go to the Recycle Bin (undoable)
        let extra: Rc<Vec<PathBuf>> = Rc::new(
            r.duplicates
                .iter()
                .flat_map(|g| {
                    let mut paths: Vec<PathBuf> = g.iter().map(|i| i.path.clone()).collect();
                    paths.sort_by_key(|p| (p.as_os_str().len(), p.clone()));
                    paths.into_iter().skip(1)
                })
                .collect(),
        );
        let label = format!("{} ({})", tx("Fazla kopyaları Geri Dönüşüm Kutusu'na taşı", "Move extra copies to the Recycle Bin"), extra.len());
        let me = me.clone();
        buttons.push(Button::new(label, Kind::Danger, move |_, window, cx| {
            let paths = (*extra).clone();
            let me = me.clone();
            work(
                window,
                cx,
                move || {
                    rf_win::shell::ensure_com();
                    rf_win::fileops::delete(&paths, false).map_err(|e| format!("{e:#}"))
                },
                move |r, window, cx| {
                    reload(&me, cx);
                    if let Err(e) = r {
                        prompt::notice(tx("Taşınamadı", "Couldn't move them"), e, window, cx);
                    }
                },
            );
            Ok(())
        }));
    }
    buttons.push(Button::new(tx("Kapat", "Close"), Kind::Normal, |_, _, _| Ok(())));
    prompt::show(tx("Yeri ne kaplıyor?", "What's taking space?"), Some(m.trim_end().to_string()), None, buttons, window, cx);
}
