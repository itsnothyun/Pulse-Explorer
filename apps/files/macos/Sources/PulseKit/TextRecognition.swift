import Foundation
import PDFKit
import Vision

/// "Copy text" from a picture or a scanned PDF: Apple's on-device text recognition (Vision), the same that powers Live Text.
/// A PDF that already has text gives that text; only scanned pages are read as pictures.
public enum TextRecognition {
    public static let imageTypes: Set<String> = ["png", "jpg", "jpeg", "heic", "heif", "tif", "tiff", "gif", "bmp", "webp"]

    public static func canRead(_ url: URL) -> Bool {
        let e = url.pathExtension.lowercased()
        return imageTypes.contains(e) || e == "pdf"
    }

    /// The text of `url`, lines in reading order; empty when there is none. Pages of a PDF are separated by a blank line.
    /// Off the main thread: it can take a second per page.
    public static func text(of url: URL, maxPages: Int = 50) throws -> String {
        if url.pathExtension.lowercased() == "pdf" {
            guard let doc = PDFDocument(url: url) else { throw Failure("This PDF can't be opened.") }
            var pages: [String] = []
            for i in 0..<min(doc.pageCount, maxPages) {
                guard let page = doc.page(at: i) else { continue }
                let own = page.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if !own.isEmpty {
                    pages.append(own)
                } else if let image = render(page) {
                    pages.append(try recognize(image))
                }
            }
            return pages.filter { !$0.isEmpty }.joined(separator: "\n\n")
        }
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
            throw Failure("This picture can't be read.")
        }
        return try recognize(image)
    }

    /// Text in a picture.
    public static func recognize(_ image: CGImage, languages: [String]? = nil) throws -> String {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        request.automaticallyDetectsLanguage = true
        if let languages { request.recognitionLanguages = languages }
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
        return lines.joined(separator: "\n")
    }

    /// A PDF page as a picture at 2× (enough for small print to be read).
    static func render(_ page: PDFPage) -> CGImage? {
        let box = page.bounds(for: .mediaBox)
        let scale: CGFloat = 2
        let w = Int(box.width * scale), h = Int(box.height * scale)
        guard w > 0, h > 0, let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.setFillColor(CGColor(gray: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.scaleBy(x: scale, y: scale)
        page.draw(with: .mediaBox, to: ctx)
        return ctx.makeImage()
    }

    public struct Failure: LocalizedError {
        public let message: String
        init(_ m: String) { message = m }
        public var errorDescription: String? { message }
    }
}

import ImageIO
