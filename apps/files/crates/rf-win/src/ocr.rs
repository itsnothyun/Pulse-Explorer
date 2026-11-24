//! Text in a picture with Windows' own OCR (Windows.Media.Ocr), in the user's languages: Pulse's "Copy text". On the Mac
//! the same is Vision (PulseKit TextRecognition).

use std::path::Path;

use windows::Graphics::Imaging::BitmapDecoder;
use windows::Media::Ocr::OcrEngine;
use windows::Storage::{FileAccessMode, StorageFile};
use windows::core::HSTRING;

/// The text of a picture file, lines in reading order; empty when there is none. Blocks: run it off the UI thread.
pub fn text_of(path: &Path) -> windows::core::Result<String> {
    // WinRT on this thread: join the process's multithreaded apartment (S_FALSE when already in it)
    unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED);
    }
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path.as_os_str()))?.join()?;
    let stream = file.OpenAsync(FileAccessMode::Read)?.join()?;
    let decoder = BitmapDecoder::CreateAsync(&stream)?.join()?;
    let bitmap = decoder.GetSoftwareBitmapAsync()?.join()?;
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()?;
    let result = engine.RecognizeAsync(&bitmap)?.join()?;
    let mut lines = Vec::new();
    for line in result.Lines()? {
        lines.push(line.Text()?.to_string());
    }
    Ok(lines.join("\n"))
}

/// The picture types Windows' decoder reads.
pub fn can_read(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| ["png", "jpg", "jpeg", "bmp", "gif", "tif", "tiff", "jxr", "heic", "webp", "ico"].contains(&e.to_lowercase().as_str()))
}
