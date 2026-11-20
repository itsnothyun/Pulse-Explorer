import Foundation

/// Quick image tools (convert, resize, compress), done by macOS's own `sips`: nothing to install, nothing leaves the Mac.
/// The originals are never touched; every result is a new file beside them.
public enum ImageTools {
    public enum Action: Equatable {
        /// To another format: "jpeg", "png", "heic", "tiff".
        case convert(to: String)
        /// The longest side scaled by `percent` (1...99).
        case resize(percent: Int)
        /// JPEG at a quality that keeps photos looking the same and makes them much smaller, at most `maxSide` px.
        case compress(maxSide: Int)
    }

    public static let readable: Set<String> = ["jpg", "jpeg", "png", "heic", "heif", "tif", "tiff", "gif", "bmp", "webp"]

    public static func canProcess(_ url: URL) -> Bool { readable.contains(url.pathExtension.lowercased()) }

    /// What `sips` should do, and the new file's name (free in `taken`), for `source` whose pixel size is `size`.
    /// Nil when the action makes no sense for it (converting a JPEG to JPEG).
    public static func plan(_ action: Action, source: URL, size: (width: Int, height: Int)?, taken: (String) -> Bool) -> (args: [String], name: String)? {
        let base = source.deletingPathExtension().lastPathComponent
        let ext = source.pathExtension.lowercased()
        switch action {
        case .convert(let to):
            let format = to.lowercased() == "jpg" ? "jpeg" : to.lowercased()
            guard ["jpeg", "png", "heic", "tiff"].contains(format) else { return nil }
            let outExt = format == "jpeg" ? "jpg" : format
            if outExt == ext || (outExt == "jpg" && ext == "jpeg") || (outExt == "tiff" && ext == "tif") { return nil }
            let name = Naming.unique(base: base, ext: outExt, taken: taken)
            var args = ["-s", "format", format]
            if format == "jpeg" || format == "heic" { args += ["-s", "formatOptions", "85"] }
            return (args, name)
        case .resize(let percent):
            guard (1...99).contains(percent), let size, size.width > 0, size.height > 0 else { return nil }
            let longest = max(size.width, size.height)
            let target = max(1, longest * percent / 100)
            let name = Naming.unique(base: "\(base) \(percent)%", ext: ext.isEmpty ? "png" : ext, taken: taken)
            return (["-Z", String(target)], name)
        case .compress(let maxSide):
            guard maxSide >= 64 else { return nil }
            var args = ["-s", "format", "jpeg", "-s", "formatOptions", "72"]
            if let size, max(size.width, size.height) > maxSide { args += ["-Z", String(maxSide)] }
            let name = Naming.unique(base: "\(base) (compressed)", ext: "jpg", taken: taken)
            return (args, name)
        }
    }

    /// Runs `sips` with `args` on `source`, writing `output`. Returns an error message, or nil when it worked.
    @discardableResult
    public static func run(args: [String], source: URL, output: URL) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/sips")
        p.arguments = args + [source.path, "--out", output.path]
        let err = Pipe()
        p.standardOutput = FileHandle.nullDevice
        p.standardError = err
        do { try p.run() } catch { return error.localizedDescription }
        let data = err.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        if p.terminationStatus != 0 || !FileManager.default.fileExists(atPath: output.path) {
            let msg = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            return msg.isEmpty ? "sips failed (\(p.terminationStatus))" : msg
        }
        return nil
    }

    /// Pixel size of an image, read from its header (no decoding).
    public static func pixelSize(_ url: URL) -> (width: Int, height: Int)? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
            let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
            let w = props[kCGImagePropertyPixelWidth] as? Int, let h = props[kCGImagePropertyPixelHeight] as? Int
        else { return nil }
        return (w, h)
    }
}

import ImageIO
