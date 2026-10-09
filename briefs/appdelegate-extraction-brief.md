<!-- brief-skeleton v1 -->

# Extract the menu bar, menu state, and bridge handling from `AppDelegate.swift`

**Purpose:** `tugapp/Sources/AppDelegate.swift` is 3,652 lines and 158 functions in one class: app lifecycle, preferences, 700 lines of menu construction, 1,000 lines of actions, the bridge delegate, dynamic menu rebuilding, and a `MenuState` value type. The app's Swift tests can only reach Foundation-only sources, and nothing in this file is one.

---

## Purpose {#purpose}

The first half of item 31 of `briefs/audit-punch-list.md`:

> 31. Extract `MenuBuilder` and `BridgeHandler` from `AppDelegate.swift`, …

The tugcast half of that item is `tugcast-boot-builders-brief.md`. Menu structure, chords, validation, and bridge behaviour are held fixed.

---

## Evidence {#evidence}

**[F01] The file's own map** — `// MARK:` sections: app lifecycle (717), preferences (916), menu bar (957 to 1659), actions (1659 to 2672, 96 `@objc` selectors), UDS control commands (2672), then two extensions: `BridgeDelegate` (2681 to 2936) and `NSMenuDelegate` for the dynamic View, Theme, and Open Recent menus (2938 to 3336), and a `MenuState` struct (3354). 223 stored-property declarations across the class. **(verified)**

**[F02] Menu construction is three functions and a field set** — `buildMenuBar()` (982), `rebuildViewMenu(_:)` (3063), `rebuildOpenRecentMenu(_:)` (3238), with the menu items held as implicitly-unwrapped properties on the delegate (`makerMenu` and its siblings). **(verified)**

**[F03] The bridge protocol is small and already defined elsewhere** — `BridgeDelegate` (`MainWindow.swift:61`) has eleven requirements: choose source tree, choose path, get settings, frontend ready, dev-mode error, set theme, dev badge, page did load, HMR update, launch stage name, retry launch stage. `AppDelegate` is its only conformer. **(verified)**

**[F04] The Swift test idiom only reaches Foundation-only files** — `just test-swift` runs four shell scripts that concatenate one source file with a driver and run the pair through `swift -`; `tests/update/test-update-state.sh` explains the rule: "that idiom only works for a source with no app-type dependencies, which is why `UpdateState.swift` is Foundation-only". `MenuState` is a value type that would qualify if it lived in its own file. There is no XCTest target in `Tug.xcodeproj`. **(verified)**

**[F05] Actions are wired by selector and validated by `NSMenuItemValidation`** — the 96 `@objc` methods are the targets of menu items built in [F02], and `AppDelegate` conforms to `NSMenuItemValidation`. Moving an action's body is safe; moving its selector to another object changes the responder-chain target and the validation path. **(verified)**

---

## Decisions {#decisions}

**[B01] Four types leave the delegate: `MenuBarBuilder`, `MenuStateSync`, `MenuState` (to its own file), and `BridgeHandler`.** `MenuBarBuilder` builds the menu bar and returns a struct of the item handles the delegate keeps today, so the IUO properties become one `let menus: MenuHandles`. `MenuStateSync` takes the `NSMenuDelegate` conformance and the three rebuild functions, holding a weak delegate for the facts it reads. `MenuState` moves to `MenuState.swift`, Foundation-only, so the `swift -` idiom can test it. `BridgeHandler` takes the `BridgeDelegate` conformance with weak references to the window and the process manager.

**[B02] The 96 `@objc` actions stay on `AppDelegate` as one-line forwarders.** [F05]: the selector and validation wiring is the one thing in this file that AppKit owns, and the cost of moving bodies while leaving selectors is nothing. The bodies move to the type that owns the state they touch: menu actions to `MenuStateSync` or `MenuBarBuilder`, bridge-shaped ones to `BridgeHandler`, lifecycle ones stay.

**[B03] `MenuState` gets a `swift -` test the day it moves.** It is the one piece of this file that is pure, and the idiom in [F04] exists for exactly this. The driver asserts the three-state marks and the pane rows the memory records as settled.

**[B04] Every other extraction is verified by the app-tests that `@covers` `AppDelegate.swift`, run once at the end, and by a built debug app whose menu bar is walked by hand once.** There is no fast layer for AppKit menus and the brief does not pretend one into existence; the app-tests that drive menus through the harness are the verdict, and the `@covers` lines are retargeted at the new files as each lands.

**[B05] Order: `MenuState` out first, then `BridgeHandler`, then `MenuBarBuilder`, then `MenuStateSync`.** Smallest and purest first; the bridge handler second because its surface is a protocol with eleven methods and nothing else; the menu builder and the dynamic rebuilds last because they share the handle struct and should land on each other.

---

## Open Questions {#open-questions}

- Whether `MainWindow.swift` (2,495 lines, 23 script message handlers) wants the same treatment in this arc or its own. The path handlers are already in `loopback-trust-boundary-brief.md`; the rest is a second arc by default, so this one stays one file.

---

## Non-goals {#non-goals}

- **Adding an XCTest target.** Item 26 of the Medium list; the `swift -` idiom covers what this arc extracts.
- **Changing any menu, chord, or validation rule.** The ⌃⌥⌘ reservation and the Window menu sidebar rows are settled decisions and this arc moves code under them.
- **Touching `ProcessManager.swift`'s teardown or restart loop.** Separate findings, separate arc.

---

## Exit {#exit}

An arc. Steps as ordered in [B05], each ending with `just build-app` green; `MenuState.swift` lands with its driver script added to `just test-swift`. After the last step, the `@covers`-derived app-test selection for `AppDelegate.swift` and the new files runs once, and the debug app's menu bar is walked by hand once to confirm every item is present, enabled where it should be, and reaches its action.
