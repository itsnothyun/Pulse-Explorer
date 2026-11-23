import Darwin
import Foundation

/// What a terminal tab shows about its shell without the shell's help: the folder it is in and what runs in the
/// foreground (the program in front of the prompt, or nothing). Read from the kernel (proc_pidinfo, tcgetpgrp), so it
/// works with any shell and any prompt.
public enum ProcessInspect {
    /// The working directory of `pid`, or nil.
    public static func cwd(of pid: pid_t) -> String? {
        guard pid > 0 else { return nil }
        var info = proc_vnodepathinfo()
        let size = Int32(MemoryLayout<proc_vnodepathinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &info, size) == size else { return nil }
        let path = withUnsafeBytes(of: info.pvi_cdir.vip_path) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
        return path.isEmpty ? nil : path
    }

    /// The short name of `pid`'s program ("zsh", "node", "claude"), or nil. A program installed as a versioned file
    /// behind a link (Claude Code: ~/.local/bin/claude → …/versions/2.1.330) is named as it was started ("claude"),
    /// not by its version.
    public static func name(of pid: pid_t) -> String? {
        guard pid > 0 else { return nil }
        var buf = [CChar](repeating: 0, count: Int(MAXCOMLEN) * 4 + 1)
        guard proc_name(pid, &buf, UInt32(buf.count)) > 0 else { return nil }
        let n = String(cString: buf)
        if looksLikeVersion(n), let a = argv0(of: pid) {
            let started = (a as NSString).lastPathComponent
            if !started.isEmpty, !looksLikeVersion(started) { return started }
        }
        return n.isEmpty ? nil : n
    }

    /// "2.1.330", "1.4", "20": a name made of digits and dots only.
    static func looksLikeVersion(_ s: String) -> Bool {
        !s.isEmpty && s.first!.isNumber && s.allSatisfy { $0.isNumber || $0 == "." }
    }

    /// The first argument `pid` was started with (KERN_PROCARGS2), or nil.
    public static func argv0(of pid: pid_t) -> String? {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return nil }
        var buf = [UInt8](repeating: 0, count: size)
        guard sysctl(&mib, 3, &buf, &size, nil, 0) == 0 else { return nil }
        // argc, then the executable's path, NULs, then argv[0]
        var i = MemoryLayout<Int32>.size
        while i < size, buf[i] != 0 { i += 1 }
        while i < size, buf[i] == 0 { i += 1 }
        let start = i
        while i < size, buf[i] != 0 { i += 1 }
        guard i > start else { return nil }
        return String(decoding: buf[start..<i], as: UTF8.self)
    }

    /// The foreground process group of the terminal `fd` (the program in front), or nil.
    public static func foreground(ofTerminal fd: Int32) -> pid_t? {
        guard fd >= 0 else { return nil }
        let pg = tcgetpgrp(fd)
        return pg > 0 ? pg : nil
    }

    /// What a terminal is doing, from its shell and its foreground group.
    public struct Activity: Equatable, Sendable {
        /// The program in front when it isn't the shell ("npm", "claude"); nil at the prompt.
        public let program: String?
        public let directory: String?
        public var isBusy: Bool { program != nil }
        public init(program: String?, directory: String?) {
            self.program = program
            self.directory = directory
        }
    }

    public static func activity(shell: pid_t, terminal fd: Int32) -> Activity {
        let fg = foreground(ofTerminal: fd)
        let program = fg.flatMap { $0 == shell ? nil : name(of: $0) }
        return Activity(program: program, directory: cwd(of: shell))
    }

    /// A tab's title: the program running, else the folder ("~" for home), as Ghostty and herdr show it.
    public static func title(_ a: Activity, home: String = NSHomeDirectory()) -> String {
        let place: String = {
            guard let d = a.directory else { return "Terminal" }
            if d == home { return "~" }
            return (d as NSString).lastPathComponent
        }()
        if let p = a.program { return "\(p) — \(place)" }
        return place
    }
}
