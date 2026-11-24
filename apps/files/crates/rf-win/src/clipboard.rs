//! Explorer-compatible file clipboard: CF_HDROP + "Preferred DropEffect".

use std::path::PathBuf;

use windows::Win32::Foundation::{HANDLE, HGLOBAL, HWND, POINT};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber, IsClipboardFormatAvailable,
    OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::System::Ole::CF_HDROP;
use windows::Win32::UI::Shell::{DROPFILES, DragQueryFileW, HDROP};
use windows::core::w;

use crate::fileops::Transfer;
use crate::wide::wide;

const DROPEFFECT_COPY: u32 = 1;
const DROPEFFECT_MOVE: u32 = 2;

struct Guard;
impl Drop for Guard {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseClipboard();
        }
    }
}

fn open(owner: HWND) -> anyhow::Result<Guard> {
    // The clipboard can be briefly locked by another app; retry a few times.
    for _ in 0..10 {
        if unsafe { OpenClipboard(Some(owner)) }.is_ok() {
            return Ok(Guard);
        }
        std::thread::sleep(std::time::Duration::from_millis(15));
    }
    anyhow::bail!("pano açılamadı")
}

unsafe fn alloc(bytes: &[u8]) -> anyhow::Result<HGLOBAL> {
    unsafe {
        let h = GlobalAlloc(GMEM_MOVEABLE, bytes.len())?;
        let p = GlobalLock(h) as *mut u8;
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
        let _ = GlobalUnlock(h);
        Ok(h)
    }
}

/// Empties the clipboard (so a paste can't pick up what was there before).
pub fn clear(owner: HWND) -> anyhow::Result<()> {
    let _g = open(owner)?;
    unsafe { EmptyClipboard()? };
    Ok(())
}

/// Changes every time the clipboard's content changes.
pub fn sequence() -> u32 {
    unsafe { GetClipboardSequenceNumber() }
}

/// Puts files on the clipboard for copy or cut. `owner` must be a real window (any thread).
pub fn set_files(owner: HWND, paths: &[PathBuf], kind: Transfer) -> anyhow::Result<()> {
    let header = DROPFILES {
        pFiles: std::mem::size_of::<DROPFILES>() as u32,
        pt: POINT::default(),
        fNC: false.into(),
        fWide: true.into(),
    };
    let mut bytes = Vec::new();
    bytes.extend_from_slice(unsafe {
        std::slice::from_raw_parts(&header as *const _ as *const u8, std::mem::size_of::<DROPFILES>())
    });
    for p in paths {
        for c in wide(p) {
            bytes.extend_from_slice(&c.to_le_bytes());
        }
    }
    bytes.extend_from_slice(&[0, 0]);
    let effect = match kind {
        Transfer::Copy => DROPEFFECT_COPY,
        Transfer::Move => DROPEFFECT_MOVE,
    };
    let _g = open(owner)?;
    unsafe {
        EmptyClipboard()?;
        let h = alloc(&bytes)?;
        SetClipboardData(CF_HDROP.0 as u32, Some(HANDLE(h.0)))?;
        let fmt = RegisterClipboardFormatW(w!("Preferred DropEffect"));
        let h2 = alloc(&effect.to_le_bytes())?;
        SetClipboardData(fmt, Some(HANDLE(h2.0)))?;
    }
    Ok(())
}

pub fn has_files() -> bool {
    unsafe { IsClipboardFormatAvailable(CF_HDROP.0 as u32).is_ok() }
}

/// Is there something Paste can bring into a folder: files with paths, or files that live only in another program (a remote
/// desktop session, a tool that carries the clipboard between PCs: `crate::vfiles`)?
pub fn can_paste() -> bool {
    has_files() || crate::vfiles::clipboard_has()
}

/// Reads files + intended operation (cut → Move) from the clipboard.
pub fn get_files(owner: HWND) -> anyhow::Result<Option<(Vec<PathBuf>, Transfer)>> {
    if !has_files() {
        return Ok(None);
    }
    let _g = open(owner)?;
    unsafe {
        let h = GetClipboardData(CF_HDROP.0 as u32)?;
        let hdrop = HDROP(h.0);
        let n = DragQueryFileW(hdrop, u32::MAX, None);
        let mut out = Vec::with_capacity(n as usize);
        for i in 0..n {
            let len = DragQueryFileW(hdrop, i, None) as usize;
            let mut buf = vec![0u16; len + 1];
            DragQueryFileW(hdrop, i, Some(&mut buf));
            out.push(PathBuf::from(String::from_utf16_lossy(&buf[..len])));
        }
        let fmt = RegisterClipboardFormatW(w!("Preferred DropEffect"));
        let mut kind = Transfer::Copy;
        if let Ok(he) = GetClipboardData(fmt) {
            let hg = HGLOBAL(he.0);
            if GlobalSize(hg) >= 4 {
                let p = GlobalLock(hg) as *const u32;
                if !p.is_null() {
                    if *p & DROPEFFECT_MOVE != 0 {
                        kind = Transfer::Move;
                    }
                    let _ = GlobalUnlock(hg);
                }
            }
        }
        Ok(Some((out, kind)))
    }
}

/// Puts a picture on the clipboard: as a bitmap (CF_DIB, every app) and as PNG (the format
/// Discord, browsers and Office paste with transparency). `rgba` is `w * h * 4` bytes, top row
/// first; `png` is the same picture encoded.
pub fn set_image(owner: HWND, w: u32, h: u32, rgba: &[u8], png: &[u8]) -> anyhow::Result<()> {
    use windows::Win32::Graphics::Gdi::{BI_RGB, BITMAPINFOHEADER};
    use windows::Win32::System::Ole::CF_DIB;
    anyhow::ensure!(rgba.len() == (w * h * 4) as usize, "picture size");
    let header = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: w as i32,
        // positive height: rows bottom-up, what every reader of CF_DIB expects
        biHeight: h as i32,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        biSizeImage: w * h * 4,
        ..Default::default()
    };
    let mut dib = Vec::with_capacity(std::mem::size_of::<BITMAPINFOHEADER>() + rgba.len());
    dib.extend_from_slice(unsafe { std::slice::from_raw_parts(&header as *const _ as *const u8, std::mem::size_of::<BITMAPINFOHEADER>()) });
    for row in (0..h as usize).rev() {
        for px in rgba[row * w as usize * 4..(row + 1) * w as usize * 4].chunks_exact(4) {
            dib.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
        }
    }
    let _g = open(owner)?;
    unsafe {
        EmptyClipboard()?;
        SetClipboardData(CF_DIB.0 as u32, Some(HANDLE(alloc(&dib)?.0)))?;
        let fmt = RegisterClipboardFormatW(w!("PNG"));
        SetClipboardData(fmt, Some(HANDLE(alloc(png)?.0)))?;
    }
    Ok(())
}

/// The clipboard's raw bytes in `format` (a copy), or None.
unsafe fn bytes_of(format: u32) -> Option<Vec<u8>> {
    unsafe {
        let h = GetClipboardData(format).ok()?;
        let hg = HGLOBAL(h.0);
        let size = GlobalSize(hg);
        let p = GlobalLock(hg) as *const u8;
        if p.is_null() || size == 0 {
            return None;
        }
        let out = std::slice::from_raw_parts(p, size).to_vec();
        let _ = GlobalUnlock(hg);
        Some(out)
    }
}

/// Text on the clipboard (CF_UNICODETEXT), for Pulse's "Paste as file".
pub fn get_text(owner: HWND) -> Option<String> {
    const CF_UNICODETEXT: u32 = 13;
    if unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT) }.is_err() {
        return None;
    }
    let _g = open(owner).ok()?;
    let raw = unsafe { bytes_of(CF_UNICODETEXT) }?;
    let units: Vec<u16> = raw.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).take_while(|&u| u != 0).collect();
    Some(String::from_utf16_lossy(&units))
}

/// A picture on the clipboard as PNG: the "PNG" format when an app put one there, else the bitmap (CF_DIB, 24 or 32 bit)
/// encoded. For Pulse's "Paste as file".
pub fn get_png(owner: HWND) -> Option<Vec<u8>> {
    use windows::Win32::System::Ole::CF_DIB;
    let png_fmt = unsafe { RegisterClipboardFormatW(w!("PNG")) };
    let has_png = unsafe { IsClipboardFormatAvailable(png_fmt) }.is_ok();
    let has_dib = unsafe { IsClipboardFormatAvailable(CF_DIB.0 as u32) }.is_ok();
    if !has_png && !has_dib {
        return None;
    }
    let _g = open(owner).ok()?;
    if has_png {
        if let Some(b) = unsafe { bytes_of(png_fmt) }.filter(|b| b.starts_with(b"\x89PNG")) {
            return Some(b);
        }
    }
    let dib = unsafe { bytes_of(CF_DIB.0 as u32) }?;
    dib_to_png(&dib)
}

/// A packed DIB (BITMAPINFOHEADER + pixels, 24/32 bit, uncompressed or BI_BITFIELDS) as PNG.
pub fn dib_to_png(dib: &[u8]) -> Option<Vec<u8>> {
    let rd32 = |o: usize| dib.get(o..o + 4).map(|b| i32::from_le_bytes([b[0], b[1], b[2], b[3]]));
    let header = rd32(0)? as usize;
    let w = rd32(4)?;
    let h = rd32(8)?;
    let bits = u16::from_le_bytes([*dib.get(14)?, *dib.get(15)?]) as usize;
    let compression = rd32(16)?;
    if w <= 0 || h == 0 || !(bits == 24 || bits == 32) || !(compression == 0 || compression == 3) {
        return None;
    }
    let (w, top_down) = (w as usize, h < 0);
    let h = h.unsigned_abs() as usize;
    // BI_BITFIELDS with a plain header: three masks follow it
    let offset = header + if compression == 3 && header == 40 { 12 } else { 0 };
    let stride = (w * bits / 8 + 3) & !3;
    let pixels = dib.get(offset..offset + stride * h)?;
    let mut rgba = vec![0u8; w * h * 4];
    let mut any_alpha = false;
    for y in 0..h {
        let src = &pixels[(if top_down { y } else { h - 1 - y }) * stride..];
        for x in 0..w {
            let p = &src[x * bits / 8..];
            let d = &mut rgba[(y * w + x) * 4..(y * w + x) * 4 + 4];
            d[0] = p[2];
            d[1] = p[1];
            d[2] = p[0];
            d[3] = if bits == 32 { p[3] } else { 255 };
            any_alpha |= bits == 32 && p[3] != 0;
        }
    }
    // many apps leave the 32-bit alpha at 0: an all-transparent picture is really an opaque one
    if bits == 32 && !any_alpha {
        rgba.chunks_exact_mut(4).for_each(|p| p[3] = 255);
    }
    let img = image::RgbaImage::from_raw(w as u32, h as u32, rgba)?;
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).ok()?;
    Some(out.into_inner())
}
