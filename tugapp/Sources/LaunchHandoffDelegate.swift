import Cocoa

extension LaunchHandoff {
    /// The decision for this process, from its own identity and the live
    /// registry.
    static func decideForThisLaunch() -> Decision {
        let isAppTest = InstanceConfig.isAppTest
        let optedIn = !(ProcessInfo.processInfo.environment[envOptIn] ?? "").isEmpty
        if isAppTest && !optedIn { return .proceed }
        guard let data = try? Data(contentsOf: registryURL) else { return .proceed }
        return decide(
            entry: entry(in: data, instanceId: InstanceConfig.instanceId),
            ownPid: getpid(),
            isAppTest: isAppTest,
            optedIn: optedIn,
            isAlive: processIsAlive,
            executablePath: executablePath(of:),
            canonical: { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path }
        )
    }
}

/// The whole life of a copy of Tug that found its instance already running.
///
/// It replaces `AppDelegate` for this launch, so it builds no window, opens
/// no tugbank, starts no updater, purges no cache and spawns no tugcast. It
/// stays a regular app; its life is about a tenth of a second.
///
/// Files the launch carried arrive through `application(_:open:)` before
/// `applicationDidFinishLaunching`, and are handed to the running copy
/// through LaunchServices at the running copy's own bundle path, which
/// delivers them to its `application(_:open:)` and fronts it — whatever
/// version that copy is, and whether or not its deck has loaded. A launch
/// with no files yields activation to the running copy and activates it;
/// `openApplication(at:)` is not used, because on the running copy's path
/// it resolves to the caller. Activation leaves a minimised window
/// minimised, so a launch with no files then posts a `raise` tell to the
/// running copy's tugcast, which relays it to that copy's host to restore
/// its window; an older running copy that does not know `raise` forwards it
/// to its page and nothing happens, which leaves it as the activation did.
///
/// A failed hand-off logs one line, still tries to front the running copy,
/// and quits: the copy has already decided it is a duplicate, and a second
/// alert would help nobody.
///
/// Under the app-test harness's pid mode nothing is activated: the harness
/// drives its apps without ever taking the user's focus, and a hand-off that
/// activated the running copy would leave a harness app frontmost for every
/// launch after it. The files still travel and the `raise` still restores
/// the window.
final class LaunchHandoffDelegate: NSObject, NSApplicationDelegate {
    private let entry: LaunchHandoff.Entry
    private var urls: [URL] = []
    private var finished = false

    init(entry: LaunchHandoff.Entry) {
        self.entry = entry
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        self.urls.append(contentsOf: urls)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSLog("LaunchHandoff: instance '%@' is running at pid %d from %@; handing off %d file(s)",
              entry.instanceId, entry.hostPid, entry.bundlePath, urls.count)
        guard !urls.isEmpty else {
            frontRunningCopy()
            postRaise { [weak self] in self?.finish() }
            return
        }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = !AppDelegate.harnessPidMode
        NSWorkspace.shared.open(
            urls,
            withApplicationAt: URL(fileURLWithPath: entry.bundlePath, isDirectory: true),
            configuration: config
        ) { [weak self] _, error in
            DispatchQueue.main.async {
                guard let self else { return }
                if let error {
                    NSLog("LaunchHandoff: open on the running copy failed: %@",
                          error.localizedDescription)
                    self.frontRunningCopy()
                }
                self.finish()
            }
        }
    }

    /// Yield activation to the running copy and activate it.
    private func frontRunningCopy() {
        guard !AppDelegate.harnessPidMode else { return }
        guard let running = NSRunningApplication(processIdentifier: entry.hostPid) else {
            NSLog("LaunchHandoff: pid %d is gone; nothing to front", entry.hostPid)
            return
        }
        NSApp.yieldActivation(to: running)
        if !running.activate() {
            NSLog("LaunchHandoff: activating pid %d was refused", entry.hostPid)
        }
    }

    /// Ask the running copy to restore its window, through its tugcast's
    /// loopback tell, then call `done` on the main queue — on an answer, a
    /// failure, or the short deadline alike. Every failure is ignored: the
    /// running copy has already been fronted, and this only un-minimises it.
    private func postRaise(_ done: @escaping () -> Void) {
        guard entry.tugcastPort > 0,
              let url = URL(string: "http://127.0.0.1:\(entry.tugcastPort)/api/tell") else {
            done()
            return
        }
        var request = URLRequest(url: url, timeoutInterval: 1.0)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(#"{"action":"raise"}"#.utf8)
        URLSession.shared.dataTask(with: request) { _, _, error in
            if let error {
                NSLog("LaunchHandoff: raise tell failed: %@", error.localizedDescription)
            }
            DispatchQueue.main.async(execute: done)
        }.resume()
    }

    private func finish() {
        guard !finished else { return }
        finished = true
        NSApp.terminate(nil)
    }
}
