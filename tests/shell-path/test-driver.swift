// Test driver for ShellPathResolver. Run via
// tests/shell-path/test-shell-path-timeout.sh, which concatenates this file
// with tugapp/Sources/ShellPathResolver.swift and pipes the pair to
// `swift -`. The driver runs against the source the app builds against —
// no duplicated algorithm, and no XCTest bundle in the Xcode project.
//
// The claim, in four cases: a shell that never answers costs the launch its
// bound and no more, hands back the fallback, and says so; a shell that
// answers costs nothing and says nothing; a shell that answers with nothing
// falls back silently; and a shell that ignores SIGTERM still cannot hold
// the launch, because the drain is bounded too.

import Foundation

var failures = 0

func check(_ label: String, _ condition: Bool, _ detail: @autoclosure () -> String = "") {
    if condition {
        print("  ok    \(label)")
    } else {
        failures += 1
        let extra = detail()
        print("  FAIL  \(label)\(extra.isEmpty ? "" : " — \(extra)")")
    }
}

/// Write an executable fake shell that answers the resolver's
/// `-lic "printf '%s' \"$PATH\""` however this test needs it to.
func fakeShell(named name: String, body: String) -> String {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("tug-shell-path-test-\(ProcessInfo.processInfo.processIdentifier)")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let url = dir.appendingPathComponent(name)
    try? Data("#!/bin/bash\n\(body)\n".utf8).write(to: url, options: .atomic)
    try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
    return url.path
}

// ── Case 1: a shell that sleeps past the deadline ────────────────────────
//
// 300 ms budget against a shell that sleeps a minute. What is asserted is
// the *gap*: an unbounded `waitUntilExit()` would sit here for the whole
// minute, which is the defect this step closes, so the assertion is a wide
// ten seconds rather than a tight one. A tight bound would only be
// measuring how quickly this machine can fork `bash` today, and the answer
// under a parallel build is not a fact about the resolver.
//
// `exec` so the shell *becomes* the sleep: terminating it then closes the
// pipe, which is what a real login shell blocked in an rc file does.
print("a login shell that never answers")
do {
    let slow = fakeShell(named: "slow-shell", body: "exec sleep 60")
    var warnings: [(String, [String: String])] = []
    let started = Date()
    let outcome = ShellPathResolver.resolve(
        loginShell: slow,
        timeoutMs: 300,
        fallback: "/fallback/bin:/usr/bin",
        warn: { message, fields in warnings.append((message, fields)) }
    )
    let elapsed = Date().timeIntervalSince(started)

    check("returns inside the bound", elapsed < 10.0, "took \(String(format: "%.2f", elapsed))s")
    check("reports the timeout", outcome.shellTimedOut)
    check("uses the fallback", outcome.usedFallback)
    check("hands back the caller's fallback",
          outcome.path == "/fallback/bin:/usr/bin", "got \(outcome.path)")
    check("names the shell it gave up on", outcome.shell == slow, "got \(outcome.shell)")
    check("warns exactly once", warnings.count == 1, "got \(warnings.count)")
    if let first = warnings.first {
        check("the warning says what happened",
              first.0 == "login shell timed out; using fallback", "got \(first.0)")
        check("the warning carries the shell",
              first.1["shell"] == slow, "got \(first.1["shell"] ?? "nil")")
        check("the warning carries the bound",
              first.1["timeout_ms"] == "300", "got \(first.1["timeout_ms"] ?? "nil")")
        check("the warning carries the fallback it used",
              first.1["fallback"] == "/fallback/bin:/usr/bin",
              "got \(first.1["fallback"] ?? "nil")")
    }
}

// ── Case 2: a shell that answers ─────────────────────────────────────────
//
// The ordinary path, which the bound must leave alone: the shell's own PATH
// comes back, nothing is logged, and no fallback is reached for.
//
// The budget here is twenty seconds, not the shipped two. The claim is that
// a shell which answers is never mistaken for one that did not, and a
// two-second budget would put that claim at the mercy of how long this
// machine takes to spawn a process — which is exactly how this case was
// observed to go red once, under a loaded machine, while the resolver did
// nothing wrong.
print("a login shell that answers")
do {
    let fast = fakeShell(named: "fast-shell", body: "printf '%s' /opt/fast/bin:/usr/bin")
    var warnings: [(String, [String: String])] = []
    let outcome = ShellPathResolver.resolve(
        loginShell: fast,
        timeoutMs: 20_000,
        fallback: "/fallback/bin:/usr/bin",
        warn: { message, fields in warnings.append((message, fields)) }
    )

    check("returns the shell's PATH",
          outcome.path == "/opt/fast/bin:/usr/bin", "got \(outcome.path)")
    check("reports no timeout", !outcome.shellTimedOut)
    check("reaches for no fallback", !outcome.usedFallback)
    check("writes no warning", warnings.isEmpty, "got \(warnings.map { $0.0 })")
}

// ── Case 3: a shell that answers nothing at all ──────────────────────────
//
// Not a timeout — it exits immediately — but the fallback is still what the
// caller gets, and it is deliberately silent: there is nothing slow to
// report, and a warning here would cry wolf on every misconfigured shell.
print("a login shell that answers with nothing")
do {
    let empty = fakeShell(named: "empty-shell", body: "exit 0")
    var warnings: [(String, [String: String])] = []
    let outcome = ShellPathResolver.resolve(
        loginShell: empty,
        timeoutMs: 20_000,
        fallback: "/fallback/bin:/usr/bin",
        warn: { message, fields in warnings.append((message, fields)) }
    )

    check("uses the fallback", outcome.usedFallback)
    check("hands back the caller's fallback",
          outcome.path == "/fallback/bin:/usr/bin", "got \(outcome.path)")
    check("reports no timeout", !outcome.shellTimedOut)
    check("writes no warning", warnings.isEmpty, "got \(warnings.map { $0.0 })")
}

// ── Case 4: a shell that ignores the terminate ───────────────────────────
//
// The reason the drain has a deadline of its own. This shell traps SIGTERM
// and keeps running, so the pipe's write end never closes and the read
// never reaches EOF — and `runBounded` must still come back, because a
// child that will not die must not be able to hold the launch open through
// a file handle. Last, deliberately: it leaves a blocked reader behind, and
// nothing should run after it.
print("a login shell that ignores the terminate")
do {
    let stubborn = fakeShell(
        named: "stubborn-shell",
        body: "trap '' TERM\nsleep 60"
    )
    var warnings: [(String, [String: String])] = []
    let started = Date()
    let outcome = ShellPathResolver.resolve(
        loginShell: stubborn,
        timeoutMs: 300,
        fallback: "/fallback/bin:/usr/bin",
        warn: { message, fields in warnings.append((message, fields)) }
    )
    let elapsed = Date().timeIntervalSince(started)

    check("returns anyway", elapsed < 10.0, "took \(String(format: "%.2f", elapsed))s")
    check("reports the timeout", outcome.shellTimedOut)
    check("hands back the caller's fallback",
          outcome.path == "/fallback/bin:/usr/bin", "got \(outcome.path)")
    check("warns exactly once", warnings.count == 1, "got \(warnings.count)")
}

if failures == 0 {
    print("PASS — ShellPathResolver")
    exit(0)
}
print("FAIL — \(failures) assertion(s)")
exit(1)
