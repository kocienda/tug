// Test driver for UpdateStateMachine and UpdateSnapshot. Run via
// tests/update/test-update-state.sh, which concatenates this file with
// tugapp/Sources/UpdateState.swift and pipes the pair to `swift -`. The
// driver runs against the source the app builds against — no duplicated
// reducer, and no XCTest bundle in the Xcode project.
//
// Tug presents every update state itself now, so the flow is Tug's to get
// right. The claims tested here are the ones the presentation rests on:
// each Sparkle callback lands the flow in the state the user is shown; a
// download reports whole percents and reports nothing at all until its
// total is known; progress that does not move a whole percent publishes
// nothing, which is the whole of [B05]; a terminal state clears what came
// before it; and the app-menu item's title and command track the flow, so
// the menu is a complete second door and not just a way to start one [B07].

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

/// A machine driven to the point where an update has been found, which is
/// where most of the interesting cases start.
func machineWithUpdateFound(userInitiated: Bool = true) -> UpdateStateMachine {
    var machine = UpdateStateMachine()
    machine.apply(.checkStarted(userInitiated: userInitiated))
    machine.apply(
        .updateFound(version: "0.9.0", build: "412", notes: nil, userInitiated: userInitiated)
    )
    return machine
}

// ── The happy path, callback by callback ─────────────────────────────────
//
// One assertion per state the user can be shown, in the order Sparkle calls
// them, because an out-of-order transition is exactly the defect that would
// show the wrong thing in the pill.
do {
    print("the flow from check to install")

    var machine = UpdateStateMachine()
    check("starts idle", machine.snapshot.stage == .idle)

    machine.apply(.checkStarted(userInitiated: true))
    check("a check is checking", machine.snapshot.stage == .checking)
    check("a check is cancellable", machine.snapshot.isCancellable)
    check("carries the user's hand", machine.snapshot.userInitiated)

    machine.apply(
        .updateFound(version: "0.9.0", build: "412", notes: "<p>notes</p>", userInitiated: true)
    )
    check("a find is available", machine.snapshot.stage == .available)
    check("carries the display version", machine.snapshot.version == "0.9.0")
    check("carries the build", machine.snapshot.build == "412")
    check("carries inline notes", machine.snapshot.releaseNotes == "<p>notes</p>")
    check("an available update is not cancellable", !machine.snapshot.isCancellable)

    machine.apply(.downloadStarted)
    check("a download is downloading", machine.snapshot.stage == .downloading)
    check("a download is cancellable", machine.snapshot.isCancellable)
    check("keeps the version through the download", machine.snapshot.version == "0.9.0")

    machine.apply(.extractionStarted)
    check("extraction is extracting", machine.snapshot.stage == .extracting)
    check("extraction is past cancelling", !machine.snapshot.isCancellable)

    machine.apply(.readyToInstall)
    check("ready is readyToInstall", machine.snapshot.stage == .readyToInstall)
    check("ready has no progress", machine.snapshot.percent == nil)

    machine.apply(.installing(applicationTerminated: false))
    check("installing is installing", machine.snapshot.stage == .installing)
}

// ── Download progress ────────────────────────────────────────────────────
//
// Sparkle reports increments, not totals, and may report bytes before it
// reports the expected length. A bar that sits at 0% because nobody has
// said how long the file is says something false, so progress stays nil
// until the total is known.
do {
    print("download progress")

    var machine = machineWithUpdateFound()
    machine.apply(.downloadStarted)
    check("no progress before the total is known", machine.snapshot.percent == nil)

    machine.apply(.downloadReceived(500))
    check("still no progress with bytes but no total", machine.snapshot.percent == nil)

    machine.apply(.downloadExpectedLength(1000))
    check("the total arriving late reports what was already received",
          machine.snapshot.percent == 50, "got \(String(describing: machine.snapshot.percent))")

    machine.apply(.downloadReceived(250))
    check("increments accumulate rather than replace",
          machine.snapshot.percent == 75, "got \(String(describing: machine.snapshot.percent))")

    machine.apply(.downloadReceived(500))
    check("an over-long download clamps at 100",
          machine.snapshot.percent == 100, "got \(String(describing: machine.snapshot.percent))")
}

// ── The publish gate [B05] ───────────────────────────────────────────────
//
// `apply` returns nil when the snapshot did not change, and the whole
// percent is the only progress the snapshot carries — so the "publish only
// on a whole-percent change" rule is equality, not a throttle anybody has
// to maintain. A 10 MB download over the bridge is about a hundred
// snapshots, not a hundred thousand.
do {
    print("progress publishes only on a whole-percent change")

    var machine = machineWithUpdateFound()
    machine.apply(.downloadStarted)
    machine.apply(.downloadExpectedLength(10_000))

    var published = 0
    for _ in 0..<10_000 where machine.apply(.downloadReceived(1)) != nil {
        published += 1
    }

    check("one publish per percent, not per byte",
          published == 100, "got \(published) publishes for 10,000 byte events")
    check("and it ends at 100", machine.snapshot.percent == 100)

    // Extraction is a fraction rather than a byte count, but the same gate
    // applies to it.
    var extracting = machineWithUpdateFound()
    extracting.apply(.extractionStarted)
    check("extraction starts at zero", extracting.snapshot.percent == 0)
    check("a sub-percent extraction step publishes nothing",
          extracting.apply(.extractionProgress(0.004)) == nil)
    check("crossing a percent publishes",
          extracting.apply(.extractionProgress(0.015)) != nil)
    check("and reports the whole percent", extracting.snapshot.percent == 1)
}

// ── Release notes never block an update [B11] ────────────────────────────
do {
    print("release notes")

    var machine = machineWithUpdateFound()
    check("an update with no inline notes still has a version",
          machine.snapshot.releaseNotes == nil && machine.snapshot.version == "0.9.0")

    machine.apply(.releaseNotesLoaded("# 0.9.0"))
    check("linked notes arrive without moving the stage",
          machine.snapshot.stage == .available && machine.snapshot.releaseNotes == "# 0.9.0")

    // Notes can land after the user has already started the download.
    machine.apply(.downloadStarted)
    machine.apply(.releaseNotesLoaded("# 0.9.0 (revised)"))
    check("notes landing mid-download do not rewind the flow",
          machine.snapshot.stage == .downloading)

    var failed = machineWithUpdateFound()
    failed.apply(.releaseNotesFailed)
    check("failed notes leave the update available", failed.snapshot.stage == .available)
    check("failed notes leave the version in hand", failed.snapshot.version == "0.9.0")
    check("failed notes are distinguishable from notes never offered",
          failed.snapshot.releaseNotes == nil && failed.snapshot.releaseNotesFailed)
}

// ── Terminal states ──────────────────────────────────────────────────────
do {
    print("terminal states")

    var notFound = UpdateStateMachine()
    notFound.apply(.checkStarted(userInitiated: true))
    notFound.apply(.updateNotFound)
    check("a fruitless check is upToDate", notFound.snapshot.stage == .upToDate)
    check("upToDate remembers the user asked", notFound.snapshot.userInitiated)
    check("upToDate carries no version", notFound.snapshot.version.isEmpty)

    var failed = machineWithUpdateFound()
    failed.apply(.downloadStarted)
    failed.apply(.failed("the archive could not be verified"))
    check("a failure is an error", failed.snapshot.stage == .error)
    check("an error says what happened",
          failed.snapshot.message == "the archive could not be verified")
    check("an error keeps the version it was working on", failed.snapshot.version == "0.9.0")
    check("an error carries no stale progress", failed.snapshot.percent == nil)

    var dismissed = machineWithUpdateFound()
    dismissed.apply(.downloadStarted)
    dismissed.apply(.downloadExpectedLength(100))
    dismissed.apply(.downloadReceived(50))
    dismissed.apply(.dismissed)
    check("a dismissal is idle", dismissed.snapshot.stage == .idle)
    check("a dismissal clears the version", dismissed.snapshot.version.isEmpty)
    check("a dismissal clears progress", dismissed.snapshot.percent == nil)

    // A second download in the same process must not inherit the first
    // one's byte counters, which live outside the snapshot and so are not
    // covered by clearing it.
    var reused = dismissed
    reused.apply(.checkStarted(userInitiated: true))
    reused.apply(.updateFound(version: "0.9.1", build: "413", notes: nil, userInitiated: true))
    reused.apply(.downloadStarted)
    reused.apply(.downloadExpectedLength(100))
    check("a second download starts from zero bytes", reused.snapshot.percent == 0)

    var installed = machineWithUpdateFound()
    installed.apply(.readyToInstall)
    installed.apply(.installing(applicationTerminated: true))
    installed.apply(.installedAndRelaunched(true))
    check("a finished install is idle", installed.snapshot.stage == .idle)
}

// ── The menu door [B07] ──────────────────────────────────────────────────
//
// The app-menu item is the update's second door, and a release that ships a
// broken deck must not also break the only way past it. So every state has
// a title and either a command or a reason to be dark.
do {
    print("the app-menu door")

    func title(_ snapshot: UpdateSnapshot) -> String { snapshot.menuTitle(appName: "Tug") }

    var machine = UpdateStateMachine()
    check("idle offers a check", title(machine.snapshot) == "Check for Updates...")
    check("idle's command is check", machine.snapshot.menuCommand == .check)

    machine.apply(.checkStarted(userInitiated: true))
    check("checking says so", title(machine.snapshot) == "Checking for Updates...")
    check("checking has nothing to decide", machine.snapshot.menuCommand == nil)

    machine.apply(.updateFound(version: "0.9.0", build: "412", notes: nil, userInitiated: true))
    check("an available update names its version",
          title(machine.snapshot) == "Update to Tug 0.9.0...", "got \(title(machine.snapshot))")
    check("an available update installs", machine.snapshot.menuCommand == .install)

    machine.apply(.downloadStarted)
    check("downloading names the version too",
          title(machine.snapshot) == "Downloading Tug 0.9.0...", "got \(title(machine.snapshot))")
    check("downloading has nothing to decide", machine.snapshot.menuCommand == nil)

    machine.apply(.extractionStarted)
    check("extracting reads as downloading", title(machine.snapshot) == "Downloading Tug 0.9.0...")
    check("extracting has nothing to decide", machine.snapshot.menuCommand == nil)

    machine.apply(.readyToInstall)
    check("ready offers the relaunch", title(machine.snapshot) == "Install and Relaunch")
    check("ready's command is install", machine.snapshot.menuCommand == .install)

    machine.apply(.installing(applicationTerminated: false))
    check("installing names the version",
          title(machine.snapshot) == "Installing Tug 0.9.0...", "got \(title(machine.snapshot))")
    check("installing has nothing to decide", machine.snapshot.menuCommand == nil)

    var upToDate = UpdateStateMachine()
    upToDate.apply(.updateNotFound)
    check("upToDate offers another check", title(upToDate.snapshot) == "Check for Updates...")
    check("upToDate's command is check", upToDate.snapshot.menuCommand == .check)

    var failed = UpdateStateMachine()
    failed.apply(.failed("nope"))
    check("an error offers another check", title(failed.snapshot) == "Check for Updates...")
    check("an error's command is check", failed.snapshot.menuCommand == .check)

    check("the app name is the caller's",
          upToDate.snapshot.menuTitle(appName: "Tug-nightly") == "Check for Updates...")
}

// ── The wire form [B03] ──────────────────────────────────────────────────
//
// The snapshot crosses to the deck as JSON, and a payload
// `JSONSerialization` refuses is not a malformed pill — it is no pill at
// all, because the whole `evaluateJavaScript` call is skipped. Every state
// the flow can reach is checked for that, plus the two fields that have a
// null to get wrong.
do {
    print("the snapshot's wire form")

    func payload(_ snapshot: UpdateSnapshot) -> [String: Any] { snapshot.jsonObject }

    var machine = UpdateStateMachine()
    check("idle serializes", JSONSerialization.isValidJSONObject(payload(machine.snapshot)))
    check("idle's notes are null", payload(machine.snapshot)["releaseNotes"] is NSNull)
    check("idle's percent is null", payload(machine.snapshot)["percent"] is NSNull)
    check("idle's stage is a string", payload(machine.snapshot)["stage"] as? String == "idle")

    machine.apply(.checkStarted(userInitiated: true))
    machine.apply(
        .updateFound(version: "0.9.0", build: "412", notes: "<p>a & b</p>", userInitiated: true)
    )
    check("available serializes", JSONSerialization.isValidJSONObject(payload(machine.snapshot)))
    check("carries the version", payload(machine.snapshot)["version"] as? String == "0.9.0")
    check("carries the build", payload(machine.snapshot)["build"] as? String == "412")
    check("carries the notes", payload(machine.snapshot)["releaseNotes"] as? String == "<p>a & b</p>")
    check("carries userInitiated", payload(machine.snapshot)["userInitiated"] as? Bool == true)
    check("carries cancellable", payload(machine.snapshot)["cancellable"] as? Bool == false)

    machine.apply(.downloadStarted)
    machine.apply(.downloadExpectedLength(200))
    machine.apply(.downloadReceived(50))
    check("downloading serializes", JSONSerialization.isValidJSONObject(payload(machine.snapshot)))
    check("carries the whole percent", payload(machine.snapshot)["percent"] as? Int == 25)
    check("downloading is cancellable", payload(machine.snapshot)["cancellable"] as? Bool == true)

    // Release notes are arbitrary HTML or Markdown, which is why the host
    // serializes rather than interpolating. A payload carrying quotes,
    // backslashes and newlines has to survive the round trip intact.
    var awkward = UpdateStateMachine()
    let notes = "# 0.9.0\n\n- \"quoted\", 'single', back\\slash\n- </script><script>\n"
    awkward.apply(.updateFound(version: "0.9.0", build: "412", notes: notes, userInitiated: false))
    let encoded = try? JSONSerialization.data(withJSONObject: payload(awkward.snapshot))
    check("awkward notes encode", encoded != nil)
    if let encoded,
       let decoded = try? JSONSerialization.jsonObject(with: encoded) as? [String: Any] {
        check("awkward notes survive the round trip",
              decoded["releaseNotes"] as? String == notes)
    } else {
        check("awkward notes survive the round trip", false, "could not decode")
    }

    var failed = UpdateStateMachine()
    failed.apply(.failed("could not reach the feed"))
    check("error serializes", JSONSerialization.isValidJSONObject(payload(failed.snapshot)))
    check("an error carries its message",
          payload(failed.snapshot)["message"] as? String == "could not reach the feed")
}

if failures == 0 {
    print("PASS — UpdateStateMachine")
    exit(0)
}
print("FAIL — \(failures) assertion(s)")
exit(1)
