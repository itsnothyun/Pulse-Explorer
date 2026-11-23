import AppKit
import XCTest
@testable import PulseKit

/// A fresh folder per test, removed after it.
class TempDirTestCase: XCTestCase {
    var dir: URL!
    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("pulsekit-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    @discardableResult
    func write(_ name: String, _ data: Data) throws -> URL {
        let u = dir.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: u)
        return u
    }
}

// MARK: - naming

final class NamingTests: XCTestCase {
    func testSanitizeRemovesSeparatorsControlAndLeadingDots() {
        XCTAssertEqual(Naming.sanitize("a/b:c"), "a-b-c")
        XCTAssertEqual(Naming.sanitize("..hidden"), "hidden")
        XCTAssertEqual(Naming.sanitize("  \n "), "Untitled")
        XCTAssertEqual(Naming.sanitize("tab\there"), "tabhere")
        XCTAssertLessThanOrEqual(Naming.sanitize(String(repeating: "é", count: 300)).utf8.count, 240)
    }

    func testUniqueSkipsTakenNamesIgnoringCase() {
        let taken: Set<String> = ["report.pdf", "report 2.pdf"]
        XCTAssertEqual(Naming.unique(base: "Report", ext: "PDF") { taken.contains($0.lowercased()) }, "Report 3.pdf")
        XCTAssertEqual(Naming.unique(base: "notes", ext: "") { _ in false }, "notes")
    }

    func testUniqueWithoutSanitizingKeepsDotfiles() {
        XCTAssertEqual(Naming.unique(base: ".env", ext: "", sanitizing: false) { _ in false }, ".env")
        XCTAssertEqual(Naming.unique(base: ".env", ext: "", sanitizing: false) { $0 == ".env" }, ".env 2")
    }

    func testStampHasNoColons() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let d = Date(timeIntervalSince1970: 1_795_000_000)
        let s = Naming.stamp(d, calendar: cal)
        XCTAssertFalse(s.contains(":"))
        XCTAssertTrue(s.hasPrefix("2026-11-18 at "), s)
    }
}

// MARK: - paste as file

final class ClipboardFileTests: XCTestCase {
    let none: (String) -> Bool = { _ in false }
    let now = Date(timeIntervalSince1970: 1_795_000_000)

    func testPreferenceOrder() {
        XCTAssertEqual(ClipboardFile.choose(image: Data([1]), pdf: Data([2]), string: "x"), .png(Data([1])))
        XCTAssertEqual(ClipboardFile.choose(image: nil, pdf: Data([2]), string: "x"), .pdf(Data([2])))
        XCTAssertEqual(ClipboardFile.choose(image: nil, pdf: nil, string: "https://example.com/a"), .link(URL(string: "https://example.com/a")!, title: nil))
        XCTAssertEqual(ClipboardFile.choose(image: nil, pdf: nil, string: "hello world"), .text("hello world"))
        XCTAssertNil(ClipboardFile.choose(image: Data(), pdf: nil, string: "   "))
    }

    func testTextWithAnURLInsideStaysText() {
        XCTAssertEqual(ClipboardFile.choose(image: nil, pdf: nil, string: "see https://example.com"), .text("see https://example.com"))
        XCTAssertEqual(ClipboardFile.choose(image: nil, pdf: nil, string: "ftp://x.y"), .text("ftp://x.y"))
    }

    func testTextIsNamedByItsFirstLineAndMarkdownIsDetected() {
        let md = ClipboardFile.output(for: .text("# Plan\n- one\n- two"), now: now, taken: none)
        XCTAssertEqual(md.name, "Plan.md")
        let txt = ClipboardFile.output(for: .text("Dear team, the numbers are in"), now: now, taken: none)
        XCTAssertEqual(txt.name, "Dear team, the numbers are in.txt")
        let long = ClipboardFile.output(for: .text(String(repeating: "word ", count: 30)), now: now, taken: none)
        XCTAssertTrue(long.name.hasSuffix("….txt"), long.name)
    }

    func testWeblocIsAPropertyListWithTheURL() throws {
        let out = ClipboardFile.output(for: .link(URL(string: "https://pulse.app/x")!, title: "Pulse: home"), now: now, taken: none)
        XCTAssertEqual(out.name, "Pulse- home.webloc")
        let plist = try PropertyListSerialization.propertyList(from: out.data, format: nil) as? [String: String]
        XCTAssertEqual(plist?["URL"], "https://pulse.app/x")
    }

    func testPicturesNeverReplaceAFile() {
        let first = ClipboardFile.output(for: .png(Data([1])), now: now, taken: none)
        let second = ClipboardFile.output(for: .png(Data([1])), now: now) { $0 == first.name }
        XCTAssertNotEqual(first.name, second.name)
        XCTAssertTrue(second.name.hasSuffix(" 2.png"), second.name)
    }
}

// MARK: - image tools

final class ImageToolsTests: TempDirTestCase {
    func testPlans() {
        let src = URL(fileURLWithPath: "/x/photo.heic")
        let conv = ImageTools.plan(.convert(to: "jpg"), source: src, size: (4000, 3000)) { _ in false }
        XCTAssertEqual(conv?.name, "photo.jpg")
        XCTAssertEqual(conv?.args, ["-s", "format", "jpeg", "-s", "formatOptions", "85"])
        XCTAssertNil(ImageTools.plan(.convert(to: "jpeg"), source: URL(fileURLWithPath: "/x/a.jpg"), size: nil) { _ in false })
        XCTAssertNil(ImageTools.plan(.convert(to: "exe"), source: src, size: nil) { _ in false })
        let half = ImageTools.plan(.resize(percent: 50), source: src, size: (4000, 3000)) { _ in false }
        XCTAssertEqual(half?.args, ["-Z", "2000"])
        XCTAssertEqual(half?.name, "photo 50%.heic")
        XCTAssertNil(ImageTools.plan(.resize(percent: 0), source: src, size: (10, 10)) { _ in false })
        XCTAssertNil(ImageTools.plan(.resize(percent: 50), source: src, size: nil) { _ in false })
        let small = ImageTools.plan(.compress(maxSide: 2048), source: src, size: (1000, 800)) { _ in false }
        XCTAssertEqual(small?.args, ["-s", "format", "jpeg", "-s", "formatOptions", "72"], "no resize when already small")
        let big = ImageTools.plan(.compress(maxSide: 2048), source: src, size: (6000, 4000)) { _ in false }
        XCTAssertEqual(big?.args.suffix(2), ["-Z", "2048"])
        XCTAssertEqual(big?.name, "photo (compressed).jpg")
    }

    /// The real thing: a PNG converted to JPEG and halved by sips, the original left as it was.
    func testSipsConvertsAndResizes() throws {
        let png = try write("pic.png", Self.png(width: 400, height: 200))
        let before = try Data(contentsOf: png)
        let plan = try XCTUnwrap(ImageTools.plan(.convert(to: "jpeg"), source: png, size: ImageTools.pixelSize(png)) { _ in false })
        XCTAssertNil(ImageTools.run(args: plan.args, source: png, output: dir.appendingPathComponent(plan.name)))
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.appendingPathComponent("pic.jpg").path))
        let r = try XCTUnwrap(ImageTools.plan(.resize(percent: 50), source: png, size: ImageTools.pixelSize(png)) { _ in false })
        XCTAssertNil(ImageTools.run(args: r.args, source: png, output: dir.appendingPathComponent(r.name)))
        let out = try XCTUnwrap(ImageTools.pixelSize(dir.appendingPathComponent(r.name)))
        XCTAssertEqual(out.width, 200)
        XCTAssertEqual(out.height, 100)
        XCTAssertEqual(try Data(contentsOf: png), before, "the original is untouched")
    }

    func testSipsReportsFailure() throws {
        let junk = try write("broken.png", Data("not a picture".utf8))
        XCTAssertNotNil(ImageTools.run(args: ["-s", "format", "jpeg"], source: junk, output: dir.appendingPathComponent("o.jpg")))
    }

    static func png(width: Int, height: Int, text: String? = nil) -> Data {
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4,
            hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        NSColor.white.setFill()
        NSRect(x: 0, y: 0, width: width, height: height).fill()
        if let text {
            (text as NSString).draw(at: NSPoint(x: 20, y: height / 2 - 20), withAttributes: [.font: NSFont.systemFont(ofSize: 48, weight: .bold), .foregroundColor: NSColor.black])
        }
        NSGraphicsContext.restoreGraphicsState()
        return rep.representation(using: .png, properties: [:])!
    }
}

// MARK: - text recognition

final class TextRecognitionTests: TempDirTestCase {
    func testReadsTextFromAPicture() throws {
        let png = try write("sign.png", ImageToolsTests.png(width: 900, height: 160, text: "Pulse Explorer 2026"))
        let text = try TextRecognition.text(of: png)
        XCTAssertTrue(text.contains("Pulse Explorer"), "got: \(text)")
        XCTAssertTrue(text.contains("2026"), "got: \(text)")
    }

    func testPDFWithItsOwnTextGivesThatText() throws {
        let pdfURL = dir.appendingPathComponent("doc.pdf")
        var box = CGRect(x: 0, y: 0, width: 400, height: 200)
        let ctx = CGContext(pdfURL as CFURL, mediaBox: &box, nil)!
        ctx.beginPDFPage(nil)
        let g = NSGraphicsContext(cgContext: ctx, flipped: false)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = g
        ("Quarterly invoice" as NSString).draw(at: NSPoint(x: 20, y: 100), withAttributes: [.font: NSFont.systemFont(ofSize: 24)])
        NSGraphicsContext.restoreGraphicsState()
        ctx.endPDFPage()
        ctx.closePDF()
        XCTAssertTrue(try TextRecognition.text(of: pdfURL).contains("Quarterly invoice"))
    }

    func testBlankPictureGivesNothingAndJunkThrows() throws {
        let blank = try write("blank.png", ImageToolsTests.png(width: 200, height: 200))
        XCTAssertEqual(try TextRecognition.text(of: blank), "")
        let junk = try write("junk.png", Data("x".utf8))
        XCTAssertThrowsError(try TextRecognition.text(of: junk))
        XCTAssertTrue(TextRecognition.canRead(URL(fileURLWithPath: "/a/b.HEIC")))
        XCTAssertFalse(TextRecognition.canRead(URL(fileURLWithPath: "/a/b.txt")))
    }
}

// MARK: - disk lens

final class DiskLensTests: TempDirTestCase {
    func testBigAndUnusedFilter() {
        let now = Date()
        var o = DiskLens.Options()
        o.minSize = 100
        o.unusedFor = 86_400
        let items = [
            DiskLens.Item(url: URL(fileURLWithPath: "/a"), size: 500, lastUsed: now.addingTimeInterval(-2 * 86_400)),
            DiskLens.Item(url: URL(fileURLWithPath: "/b"), size: 50, lastUsed: now.addingTimeInterval(-9 * 86_400)),
            DiskLens.Item(url: URL(fileURLWithPath: "/c"), size: 900, lastUsed: now),
            DiskLens.Item(url: URL(fileURLWithPath: "/d"), size: 700, lastUsed: now.addingTimeInterval(-3 * 86_400)),
        ]
        XCTAssertEqual(DiskLens.bigAndUnused(items, options: o, now: now).map(\.url.path), ["/d", "/a"])
    }

    func testDuplicatesNeedSameContentNotJustSameSize() throws {
        let mb = 1024 * 1024
        var a = Data(repeating: 7, count: 2 * mb)
        try write("one/a.bin", a)
        try write("two/a copy.bin", a)
        a[a.count / 2] = 8  // same size, same head and tail, different middle
        try write("three/almost.bin", a)
        try write("small1.txt", Data("same".utf8))
        try write("small2.txt", Data("same".utf8))
        let items = DiskLens.scan(dir)
        XCTAssertEqual(items.count, 5)
        let groups = DiskLens.duplicates(items, minSize: Int64(mb))
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(Set(groups[0].map(\.url.lastPathComponent)), ["a.bin", "a copy.bin"])
        XCTAssertGreaterThan(DiskLens.wasted(groups[0]), 0)
    }

    func testScanSkipsHiddenAndStopsWhenCancelled() throws {
        try write(".hidden/x.bin", Data([1]))
        try write("seen.bin", Data([1]))
        XCTAssertEqual(DiskLens.scan(dir).map(\.url.lastPathComponent), ["seen.bin"])
        XCTAssertTrue(DiskLens.scan(dir, cancelled: { true }).isEmpty)
    }
}

// MARK: - folder notes

final class FolderNotesTests: TempDirTestCase {
    func testWriteReadReplaceRemove() throws {
        XCTAssertNil(FolderNotes.read(dir))
        try FolderNotes.write("Invoices 2026 — send to the accountant", to: dir)
        XCTAssertEqual(FolderNotes.read(dir), "Invoices 2026 — send to the accountant")
        try FolderNotes.write("  second\n", to: dir)
        XCTAssertEqual(FolderNotes.read(dir), "second")
        try FolderNotes.write("   ", to: dir)
        XCTAssertNil(FolderNotes.read(dir))
        try FolderNotes.write("", to: dir)  // removing what isn't there is fine
    }

    func testTooLongIsRefusedAndMissingFolderThrows() {
        XCTAssertThrowsError(try FolderNotes.write(String(repeating: "x", count: FolderNotes.maxBytes + 1), to: dir)) {
            XCTAssertEqual($0 as? FolderNotes.Failure, .tooLong)
        }
        XCTAssertThrowsError(try FolderNotes.write("x", to: dir.appendingPathComponent("nope")))
    }

    func testTheNoteTravelsWithACopy() throws {
        try FolderNotes.write("keep me", to: dir)
        let copy = dir.deletingLastPathComponent().appendingPathComponent("pulsekit-copy-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: copy) }
        try FileManager.default.copyItem(at: dir, to: copy)
        XCTAssertEqual(FolderNotes.read(copy), "keep me")
    }
}

// MARK: - workspaces

final class WorkspaceTests: XCTestCase {
    func testSaveReplaceRemoveAndValidate() throws {
        let d = try XCTUnwrap(UserDefaults(suiteName: "pulsekit-tests-\(UUID().uuidString)"))
        let store = WorkspaceStore(defaults: d)
        XCTAssertFalse(store.save(Workspace(name: "  ", tabs: ["/a"], active: 0)))
        XCTAssertFalse(store.save(Workspace(name: "Empty", tabs: [], active: 0)))
        XCTAssertTrue(store.save(Workspace(name: " Film ", tabs: ["/a", "/b"], active: 9)))
        XCTAssertEqual(store.named("film")?.active, 1, "the active tab is clamped")
        XCTAssertEqual(store.named("FILM")?.name, "Film")
        XCTAssertTrue(store.save(Workspace(name: "film", tabs: ["/c"], active: 0)))
        XCTAssertEqual(store.all.count, 1, "same name replaces")
        XCTAssertTrue(store.save(Workspace(name: "Alpha", tabs: ["/x"], active: 0)))
        XCTAssertEqual(store.all.map(\.name), ["Alpha", "film"])
        store.remove(named: "ALPHA")
        XCTAssertEqual(store.all.map(\.name), ["film"])
    }
}

// MARK: - project scripts

final class ProjectScriptsTests: TempDirTestCase {
    func testPackageJsonKeepsOrderAndUsesTheProjectsManager() throws {
        let json = """
            { "name": "x", "scripts": { "dev": "vite", "build": "tsc && vite build", "test:unit": "vitest run", "a b": "echo" },
              "dependencies": { "dev": "1" } }
            """
        let pkg = try write("app/package.json", Data(json.utf8))
        try write("pnpm-lock.yaml", Data())  // the workspace root's lock, a level up
        let s = ProjectScripts.scripts(in: pkg)
        XCTAssertEqual(s.map(\.name), ["dev", "build", "test:unit", "a b"])
        XCTAssertEqual(s[2].command, "pnpm run test:unit")
        XCTAssertEqual(s[3].command, "pnpm run 'a b'")
        XCTAssertEqual(s[1].detail, "tsc && vite build")
        XCTAssertEqual(ProjectScripts.npm(json).first?.command, "npm run dev")
    }

    func testBrokenOrScriptlessJsonGivesNothing() {
        XCTAssertTrue(ProjectScripts.npm("{ not json").isEmpty)
        XCTAssertTrue(ProjectScripts.npm(#"{"name":"x"}"#).isEmpty)
    }

    func testMakefileTargets() {
        let mk = """
            CC := clang
            .PHONY: all test
            all: build test
            \tswift build
            build:
            \tcargo build --release
            %.o: %.c
            \t$(CC) -c $<
            test lint: build
            \tcargo test
            VAR = 1
            """
        let s = ProjectScripts.make(mk)
        XCTAssertEqual(s.map(\.name), ["all", "build", "test", "lint"])
        XCTAssertEqual(s[1].detail, "cargo build --release")
        XCTAssertEqual(s[0].command, "make all")
    }

    func testComposerAndQuoting() {
        let s = ProjectScripts.composer(#"{"scripts":{"test":"phpunit","post-install-cmd":["@php artisan key:generate","npm i"]}}"#)
        XCTAssertEqual(s.map(\.name), ["test", "post-install-cmd"])
        XCTAssertEqual(s[1].detail, "@php artisan key:generate && npm i")
        XCTAssertEqual(ProjectScripts.quoteArg("it's"), #"'it'\''s'"#)
        XCTAssertEqual(ProjectScripts.quoteArg("build:web"), "build:web")
        XCTAssertTrue(ProjectScripts.handles(URL(fileURLWithPath: "/p/Makefile")))
        XCTAssertFalse(ProjectScripts.handles(URL(fileURLWithPath: "/p/main.swift")))
    }
}

// MARK: - changed today

final class ChangedTodayTests: TempDirTestCase {
    func testGroupsByHourNewestFirstAndDropsYesterday() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let now = cal.date(from: DateComponents(year: 2026, month: 11, day: 21, hour: 15, minute: 30))!
        func at(_ h: Int, _ m: Int, day: Int = 21) -> Date { cal.date(from: DateComponents(year: 2026, month: 11, day: day, hour: h, minute: m))! }
        let items: [(url: URL, modified: Date)] = [
            (URL(fileURLWithPath: "/a"), at(9, 10)), (URL(fileURLWithPath: "/b"), at(15, 5)),
            (URL(fileURLWithPath: "/c"), at(9, 50)), (URL(fileURLWithPath: "/old"), at(23, 0, day: 20)),
        ]
        let g = ChangedToday.group(items, now: now, calendar: cal)
        XCTAssertEqual(g.count, 2)
        XCTAssertEqual(g[0].files.map(\.path), ["/b"])
        XCTAssertEqual(g[1].files.map(\.path), ["/c", "/a"])
    }

    func testScanFindsTodaysFilesAndSkipsBuildFolders() throws {
        try write("notes.txt", Data([1]))
        try write("node_modules/dep/index.js", Data([1]))
        let old = try write("old.txt", Data([1]))
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -3 * 86_400)], ofItemAtPath: old.path)
        XCTAssertEqual(ChangedToday.scan(dir).map(\.url.lastPathComponent), ["notes.txt"])
    }
}

// MARK: - shelf

final class ShelfTests: TempDirTestCase {
    func testAddDedupeForgetMissing() throws {
        let d = try XCTUnwrap(UserDefaults(suiteName: "pulsekit-shelf-\(UUID().uuidString)"))
        let shelf = ShelfStore(defaults: d)
        let a = try write("a.txt", Data([1]))
        let b = try write("b.txt", Data([1]))
        XCTAssertEqual(shelf.add([a, b, a]), 2)
        XCTAssertEqual(shelf.add([a]), 0)
        XCTAssertEqual(shelf.add([dir.appendingPathComponent("ghost")]), 0)
        try FileManager.default.removeItem(at: b)
        XCTAssertEqual(shelf.items.map(\.lastPathComponent), ["a.txt"])
        shelf.remove([a])
        XCTAssertTrue(shelf.items.isEmpty)
    }

    func testDestinationsAvoidClashesIncludingEachOther() {
        let folder = URL(fileURLWithPath: "/dest")
        let items = [URL(fileURLWithPath: "/x/report.pdf"), URL(fileURLWithPath: "/y/report.pdf"), URL(fileURLWithPath: "/z/.env"),
                     URL(fileURLWithPath: "/dest/already.txt")]
        let plan = ShelfStore.destinations(for: items, in: folder) { $0 == "report.pdf" }
        XCTAssertEqual(plan.map(\.to.lastPathComponent), ["report 2.pdf", "report 3.pdf", ".env"])
    }
}

// MARK: - terminal process inspection

final class ProcessInspectTests: TempDirTestCase {
    func testOwnProcess() {
        let me = getpid()
        XCTAssertEqual(ProcessInspect.cwd(of: me).map { URL(fileURLWithPath: $0).standardizedFileURL.path },
                       URL(fileURLWithPath: FileManager.default.currentDirectoryPath).standardizedFileURL.path)
        XCTAssertNotNil(ProcessInspect.name(of: me))
        XCTAssertNil(ProcessInspect.cwd(of: -1))
        XCTAssertNil(ProcessInspect.name(of: 0))
        XCTAssertNil(ProcessInspect.foreground(ofTerminal: -1))
    }

    func testAChildsDirectoryAndName() throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sleep")
        p.arguments = ["5"]
        p.currentDirectoryURL = dir
        try p.run()
        defer { p.terminate() }
        Thread.sleep(forTimeInterval: 0.2)
        let cwd = try XCTUnwrap(ProcessInspect.cwd(of: p.processIdentifier))
        XCTAssertEqual(URL(fileURLWithPath: cwd).resolvingSymlinksInPath().path, dir.resolvingSymlinksInPath().path)
        XCTAssertEqual(ProcessInspect.name(of: p.processIdentifier), "sleep")
    }

    func testForegroundOfARealPseudoTerminal() throws {
        // a shell on a pty running `sleep`: the foreground group is sleep's, not the shell's
        var master: Int32 = -1
        // the arguments are made before the fork: the child only execs
        let words: [String] = ["/bin/sh", "-c", "sleep 3"]
        let owned: [UnsafeMutablePointer<CChar>?] = words.map { (w: String) -> UnsafeMutablePointer<CChar>? in strdup(w) }
        defer { owned.forEach { free($0) } }
        let args: [UnsafeMutablePointer<CChar>?] = owned + [nil]
        let pid = forkpty(&master, nil, nil, nil)
        if pid == 0 {
            execv("/bin/sh", args)
            _exit(1)
        }
        XCTAssertGreaterThan(pid, 0)
        defer { kill(pid, SIGKILL); close(master) }
        Thread.sleep(forTimeInterval: 0.3)
        let fg = try XCTUnwrap(ProcessInspect.foreground(ofTerminal: master))
        XCTAssertNotNil(ProcessInspect.name(of: fg))
    }

    func testTitles() {
        XCTAssertEqual(ProcessInspect.title(.init(program: nil, directory: "/Users/a/dev/pulse"), home: "/Users/a"), "pulse")
        XCTAssertEqual(ProcessInspect.title(.init(program: nil, directory: "/Users/a"), home: "/Users/a"), "~")
        XCTAssertEqual(ProcessInspect.title(.init(program: "claude", directory: "/Users/a/dev/pulse"), home: "/Users/a"), "claude — pulse")
        XCTAssertEqual(ProcessInspect.title(.init(program: nil, directory: nil)), "Terminal")
        XCTAssertTrue(ProcessInspect.Activity(program: "npm", directory: nil).isBusy)
    }
}

// MARK: - terminal welcome card

final class TerminalWelcomeTests: XCTestCase {
    let info = TerminalWelcome.Info(folder: "/Users/a/dev/pulse-explorer", items: 12, branch: "feat/macos-desktop", changed: 3, ahead: 1,
                                    commands: ["pnpm run dev", "pnpm run build"], home: "/Users/a")

    func testNoLineIsWiderThanThePaneAtAnyWidth() {
        for cols in 20...160 {
            for line in TerminalWelcome.plain(info, cols: cols) {
                XCTAssertLessThanOrEqual(line.count, cols, "cols \(cols): \(line)")
            }
        }
    }

    func testFullCardRowsAreAllTheSameWidthAndBoxed() {
        let lines = TerminalWelcome.plain(info, cols: 120)
        let card = lines.prefix { !$0.hasPrefix("╰") } + [lines.first { $0.hasPrefix("╰") }!]
        let widths = Set(card.map(\.count))
        XCTAssertEqual(widths.count, 1, "every row of the card is as wide as its top: \(widths)")
        XCTAssertTrue(lines[0].hasPrefix("╭─ Pulse "))
        XCTAssertTrue(lines.contains { $0.contains("Pulse Explorer") })
        XCTAssertTrue(lines.contains { $0.contains("~/dev/pulse-explorer") })
        XCTAssertTrue(lines.contains { $0.contains("⎇ feat/macos-desktop ↑1 · 3 changed") })
        XCTAssertTrue(lines.contains { $0.contains("pnpm run build") })
        XCTAssertTrue(lines.contains { $0.contains("Try \"pnpm run dev\"") })
        XCTAssertTrue(lines.contains { $0.contains("$#::==!") }, "the pulse line is drawn")
    }

    func testCompactAndTinyAndFallbacks() {
        let compact = TerminalWelcome.plain(info, cols: 60)
        XCTAssertFalse(compact.contains { $0.contains("$#::==!") }, "no art when compact")
        XCTAssertTrue(compact.contains { $0.contains("Pulse Explorer") })
        XCTAssertEqual(TerminalWelcome.plain(info, cols: 30).count, 1)
        // no repository, no scripts: a plain suggestion and Pulse's own keys
        let bare = TerminalWelcome.plain(.init(folder: "/tmp/x", home: "/Users/a"), cols: 100)
        XCTAssertTrue(bare.contains { $0.contains("Try \"ls -la\"") })
        XCTAssertTrue(bare.contains { $0.contains("⌘K commands") })
        XCTAssertFalse(bare.contains { $0.contains("⎇") })
    }

    func testPathsAndColours() {
        XCTAssertEqual(TerminalWelcome.shortPath("/Users/a", home: "/Users/a", max: 20), "~")
        XCTAssertEqual(TerminalWelcome.shortPath("/Users/a/x/y/zzzzzzzz", home: "/Users/a", max: 8), "…zzzzzzz")
        let raw = TerminalWelcome.render(info, cols: 120)
        XCTAssertTrue(raw.contains("\u{1B}[38;2;"), "24-bit colour")
        XCTAssertTrue(raw.hasSuffix("\r\n"))
        var light = info
        light.dark = false
        XCTAssertNotEqual(TerminalWelcome.render(light, cols: 120), raw, "the light theme has its own colours")
    }
}
