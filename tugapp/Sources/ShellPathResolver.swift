import Foundation

/// Derive the user's fully-configured `PATH` by asking their login shell,
/// with a deadline on every subprocess it runs.
///
/// ## Why this is a bounded wait and not an async hand-off
///
/// The resolve is on the launch's critical path by necessity, not by
/// oversight. `ProcessManager.checkTmux()` reads the resolved PATH, and the
/// tugcast spawn reads it again a few lines later; both need it
/// *synchronously*, and deferring the whole launch behind an async resolve
/// would mean the window sits on the splash until the same shell answers —
/// the identical wait, minus the ability to say what it was waiting on.
/// [B11] says what to do instead in its own words: on timeout the app
/// proceeds with the cached or default PATH and says so in the log. That is
/// a bounded wait with a fallback, which is what this is.
///
/// The remaining exposure is stated rather than hidden: two seconds on the
/// main thread is still two seconds. It is bounded, it is logged, and it is
/// paid only on a cache miss — `ProcessManager.resolveShellPATH` returns
/// from a cached PATH without reaching here at all on the ordinary launch.
///
/// ## Why each subprocess gets its own budget
///
/// There are two — `/usr/bin/dscl` to learn which shell the user has, then
/// that shell in login-interactive mode to print `$PATH` — and the deadline
/// is per-process rather than over the pair. A `dscl` wedged against a slow
/// directory server would otherwise spend the shell's budget as well as its
/// own, and the shell is the one whose answer is actually wanted.
///
/// Foundation-only and free of every other app type, so
/// `tests/shell-path/test-shell-path-timeout.sh` can concatenate this file
/// with its driver and run the pair through `swift -` — the same idiom
/// `BranchSlug` uses, testing the source the app builds against rather than
/// a copy of the algorithm.
enum ShellPathResolver {
    /// How long each subprocess gets. Two seconds is several times the
    /// ~250 ms a real login-interactive `zsh` takes to source a full
    /// `.zshrc`, so a healthy machine never meets it.
    static let shellPathResolveTimeoutMs = 2000

    /// The absolute last resort, when there is no cache and nothing
    /// answered — the minimal PATH a Mac app inherits.
    static let hardcodedFallbackPATH = "/usr/bin:/bin:/usr/sbin:/sbin"

    /// What a resolve did, for the caller that turns it into a log line.
    struct Outcome {
        /// The PATH to use. Always usable — the fallback when nothing else.
        let path: String
        /// The shell that was asked, or would have been.
        let shell: String
        /// `dscl` ran past its deadline, so `shell` is the default rather
        /// than the user's.
        let dsclTimedOut: Bool
        /// The login shell ran past its deadline and was terminated.
        let shellTimedOut: Bool
        /// True when `path` came from the fallback rather than the shell.
        let usedFallback: Bool
    }

    /// The login shell `/etc/passwd` records for this user, bounded.
    ///
    /// A `dscl` that misses its deadline leaves `/bin/zsh` standing, which
    /// is the same default the unbounded version fell back to when `dscl`
    /// failed outright — a wedged directory server is now just another way
    /// of failing, rather than a way of never returning.
    static func loginShell(
        timeoutMs: Int = shellPathResolveTimeoutMs,
        dsclPath: String = "/usr/bin/dscl"
    ) -> (shell: String, timedOut: Bool) {
        let fallbackShell = "/bin/zsh"
        let dscl = Process()
        dscl.executableURL = URL(fileURLWithPath: dsclPath)
        dscl.arguments = [".", "-read", "/Users/\(NSUserName())", "UserShell"]
        let pipe = Pipe()
        dscl.standardOutput = pipe
        dscl.standardError = Pipe()

        let result = runBounded(dscl, reading: pipe, timeoutMs: timeoutMs)
        guard let output = String(data: result.data, encoding: .utf8) else {
            return (fallbackShell, result.timedOut)
        }
        // Output is "UserShell: /bin/zsh\n"
        let parts = output.split(separator: ":", maxSplits: 1)
        guard parts.count == 2 else { return (fallbackShell, result.timedOut) }
        let shell = parts[1].trimmingCharacters(in: .whitespacesAndNewlines)
        guard FileManager.default.isExecutableFile(atPath: shell) else {
            return (fallbackShell, result.timedOut)
        }
        return (shell, result.timedOut)
    }

    /// Ask the login shell for its PATH, falling back on a deadline.
    ///
    /// `-l` reads the profile files, `-i` reads the rc files, `-c` runs the
    /// command — which together is what picks up `/etc/paths.d`,
    /// `path_helper`, homebrew, nix and everything else a user's PATH is
    /// actually assembled from. It is also what makes the call slow enough
    /// to be worth bounding: an rc file that blocks on a network mount, a
    /// version manager that probes a registry, a prompt framework that
    /// updates itself.
    ///
    /// `fallback` is the caller's best PATH if the shell does not answer —
    /// the cached one, then the inherited one. `warn` is called exactly
    /// once per timed-out subprocess, with a message and log fields; a
    /// silent fallback is how this defect would recur, so the caller is not
    /// given the option of not being told.
    static func resolve(
        loginShell explicitShell: String? = nil,
        timeoutMs: Int = shellPathResolveTimeoutMs,
        fallback: String?,
        warn: (String, [String: String]) -> Void
    ) -> Outcome {
        var dsclTimedOut = false
        let shell: String
        if let explicitShell {
            shell = explicitShell
        } else {
            let found = loginShell(timeoutMs: timeoutMs)
            shell = found.shell
            dsclTimedOut = found.timedOut
        }
        if dsclTimedOut {
            warn("could not read the login shell in time; using the default", [
                "dscl_timeout_ms": String(timeoutMs),
                "shell": shell,
            ])
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: shell)
        proc.arguments = ["-lic", "printf '%s' \"$PATH\""]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = Pipe()

        let result = runBounded(proc, reading: pipe, timeoutMs: timeoutMs)
        let answered = String(data: result.data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let answered, !answered.isEmpty, !result.timedOut {
            return Outcome(
                path: answered,
                shell: shell,
                dsclTimedOut: dsclTimedOut,
                shellTimedOut: false,
                usedFallback: false
            )
        }

        let resolvedFallback = fallback
            ?? ProcessInfo.processInfo.environment["PATH"]
            ?? hardcodedFallbackPATH
        if result.timedOut {
            warn("login shell timed out; using fallback", [
                "shell": shell,
                "timeout_ms": String(timeoutMs),
                "fallback": resolvedFallback,
            ])
        }
        return Outcome(
            path: resolvedFallback,
            shell: shell,
            dsclTimedOut: dsclTimedOut,
            shellTimedOut: result.timedOut,
            usedFallback: true
        )
    }

    // MARK: - The bound itself

    /// Run `proc` and collect its stdout, giving it `timeoutMs` to finish.
    ///
    /// `waitUntilExit()` is what this replaces, and the replacement is a
    /// `terminationHandler` signalling a semaphore the caller waits on with
    /// a deadline. On expiry the child is terminated and the caller is told;
    /// nothing here ever returns without an answer.
    ///
    /// The drain runs on its own queue rather than after the wait, because
    /// a child that fills the pipe buffer blocks on its own write until
    /// somebody reads — so a read scheduled after the exit would wait for
    /// an exit that is waiting for the read. Its wait is bounded too: a
    /// child that survives `SIGTERM` must not be able to hold the launch
    /// open through a file handle.
    static func runBounded(
        _ proc: Process,
        reading pipe: Pipe,
        timeoutMs: Int
    ) -> (data: Data, timedOut: Bool) {
        final class Collected {
            var data = Data()
        }
        let collected = Collected()
        let exited = DispatchSemaphore(value: 0)
        let drained = DispatchSemaphore(value: 0)

        proc.terminationHandler = { _ in exited.signal() }

        do {
            try proc.run()
        } catch {
            // Never launched — not a timeout, just nothing to say.
            return (Data(), false)
        }

        // The drain starts only after a successful launch, and that order is
        // load-bearing: the parent's copy of the pipe's write end is closed
        // by `run()`, so a read started before it would have no way to reach
        // EOF if the launch then threw — a thread blocked for the life of
        // the process, on the one path where nothing ran at all.
        DispatchQueue.global(qos: .userInitiated).async {
            collected.data = pipe.fileHandleForReading.readDataToEndOfFile()
            drained.signal()
        }

        let timedOut = exited.wait(timeout: .now() + .milliseconds(timeoutMs)) == .timedOut
        if timedOut {
            proc.terminate()
        }
        let drainedInTime =
            drained.wait(timeout: .now() + .milliseconds(drainGraceMs)) == .success
        return (drainedInTime ? collected.data : Data(), timedOut)
    }

    /// How long the drain may run past the child's exit or termination.
    /// It is over the instant the child's file descriptors are gone, so
    /// this only covers a child that ignored `SIGTERM`.
    private static let drainGraceMs = 250
}
