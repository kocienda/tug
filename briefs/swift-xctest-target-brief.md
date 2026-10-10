<!-- brief-skeleton v1 -->

# An XCTest target for Tug.app's Foundation-only Swift

**Purpose:** `Tug.xcodeproj` has one target, the application, and no test bundle. The five Swift tests that exist run by concatenating one source file with a driver and piping the pair through `swift -`, which works only for files with no app-type imports and gives no assertion vocabulary, no per-test reporting, and no way to test a type that lives in a file with an `import Cocoa`.

---

## Purpose {#purpose}

Item 26 of `briefs/audit-punch-list.md`:

> 26. An XCTest target for the pure-logic Swift. There are zero Swift unit tests today.

"Zero" was wrong by five: the `swift -` scripts are unit tests in every sense but the framework. What is missing is the framework.

---

## Evidence {#evidence}

**[F01] The project** — `tugapp/Tug.xcodeproj/project.pbxproj` (539 lines, hand-maintained with sequential object ids; no `project.yml`, no tuist, no `Package.swift` under `tugapp/`) has one `PBXNativeTarget`, `Tug`, of type application, with Sparkle as its only package. The shared scheme's `<Testables>` is empty. `just build-app` runs `xcodebuild … -scheme Tug -configuration Debug … build` through `tugrust/scripts/xcodebuild-quiet.sh`; `xcodebuild test` is not used anywhere. **(verified)**

**[F02] The existing tests** — `just test-swift` (`justfile:133-139`, part of `just test`) runs five scripts, each `cat SRC DRIVER | swift -`: `BranchSlug.swift`, `ShellPathResolver.swift`, `UpdateState.swift`, `DictationState.swift`, `BridgePathGuard.swift`. Each driver is a hand-rolled `assert` list; a failure is a trap with a line number. The recipe's comment says it needs no XCTest bundle, which was the reason for the idiom. **(verified)**

**[F03] Foundation-only sources** — thirteen files under `tugapp/Sources` import only Foundation (`TugbankClient.swift` adds SQLite3): the five above plus `BuildInfo`, `ControlSocket`, `InstanceConfig`, `TugConfig`, `TugLog`, `TugbankClient`, and two `TestHarness/` files. `MenuState` is still a struct inside `AppDelegate.swift` (:3370), which imports Cocoa; the appdelegate-extraction brief's [B03] expected it in its own file, and the arc that joined did not move it. **(verified)**

**[F04] CI runs no Swift** — `.github/workflows/ci.yml` is `ubuntu-latest` only; `nightly.yml` and `release.yml` build on `macos-26` and run no tests. **(verified)**

---

## Decisions {#decisions}

**[B01] A `TugTests` unit-test bundle target in the hand-maintained project, with no `TEST_HOST`: it compiles the Foundation-only sources in [F03] directly into the bundle rather than importing the app.** No host means no app launch, no bundle signing, and a run measured in seconds; it also means the target cannot see `AppDelegate`, which is the right constraint for a unit layer. The pbxproj edit is done by hand, in the project's sequential-id style, because introducing xcodegen to add one target would be a larger change than the target.

**[B02] The five drivers become five `XCTestCase`s, assertion for assertion, and the scripts and `test-driver.swift` files are deleted.** The idiom's one virtue was needing no bundle; once the bundle exists, two ways to write a Swift test is one too many. `just test-swift` becomes `xcodebuild test -scheme Tug -only-testing:TugTests` through `xcodebuild-quiet.sh`, and stays in `just test`.

**[B03] The scheme's `<Testables>` lists `TugTests`, and `nightly.yml` runs `just test-swift` after its build.** [F04]: `ci.yml` has no macOS runner and the lint-and-ci arc kept it that way on cost grounds; nightly already pays for a Mac and is where a Swift red should show up.

**[B04] `MenuState` moves to `MenuState.swift`, Foundation-only, and gets the test the appdelegate brief promised.** [F03]: the extraction arc left it; this is the arc with a place to test it. It is the one source change outside the test target, and it is a move.

**[B05] The target is for logic, not AppKit.** A test that needs `NSApplication`, a window, or a menu is an app-test and lives in `tests/app-test/`; the bundle's absence of a host is what keeps that line.

---

## Open Questions {#open-questions}

- None. Whether to host the tests in the app was the one judgment call, and [B01] makes it.

---

## Non-goals {#non-goals}

- **A `TEST_HOST` bundle or UI tests.** [B05].
- **Testing any of the eight other Foundation-only files in this arc.** The target makes them testable; writing their tests is each later change's job.
- **Adding a macOS runner to `ci.yml`.** [B03].
- **xcodegen or SwiftPM for the app.** [B01].

---

## Exit {#exit}

An arc. Steps: the target and scheme with one trivial test, proven by `xcodebuild test` green and `just build-app` unchanged; the five conversions with the scripts removed; `MenuState.swift` with its test; the nightly step. `just test-swift` and `just build-app` are each step's verdicts; the `@covers`-derived app-test selection for `AppDelegate.swift` runs once after the `MenuState` move.
