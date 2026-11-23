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

    /// The short name of `pid`'s program ("zsh", "node", "claude"), or nil.
    public static func name(of pid: pid_t) -> String? {
        guard pid > 0 else { return nil }
        var buf = [CChar](repeating: 0, count: Int(MAXCOMLEN) * 4 + 1)
        guard proc_name(pid, &buf, UInt32(buf.count)) > 0 else { return nil }
        let n = String(cString: buf)
        return n.isEmpty ? nil : n
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
