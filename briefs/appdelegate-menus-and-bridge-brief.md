<!-- brief-skeleton v1 -->

# Extract the menu bar, the dynamic menus, and the bridge handling from `AppDelegate.swift`

**Purpose:** The arc briefed in `appdelegate-extraction-brief.md` never ran. `AppDelegate.swift` is 3,379 lines: lifecycle, preferences, 700 lines of menu construction, 1,000 lines of actions, the bridge delegate, and the dynamic menu rebuilds, in one class. Only `MenuState` has left it, moved by the XCTest arc. This brief supersedes the earlier one with the tree as it stands and a test layer the earlier brief did not have.

---

## Purpose {#purpose}

The audit of 2026-10-11 found that item 31's Swift half was indexed as done but has no commit. The problem is unchanged from the first brief:

> Extract `MenuBuilder` and `BridgeHandler` from `AppDelegate.swift`.

Menu structure, chords, validation, and bridge behaviour are held fixed.

---

## Evidence {#evidence}

**[F01] The file's map today** — `// MARK:` sections: app lifecycle (717), preferences (916), menu bar (957 to 1659), actions (1659 to 2672, 96 `@objc` selectors), UDS control commands (2672), the `BridgeDelegate` extension (2681 to 2936), the `NSMenuDelegate` extension for the dynamic View, Theme, and Open Recent menus (2938 to 3354), and an AppKit-drawing section for `MenuState` (3354). `buildMenuBar()` is at 982, `rebuildViewMenu(_:)` at 3063, `rebuildOpenRecentMenu(_:)` at 3238. Four menu handles are implicitly-unwrapped properties. **(verified)**

**[F02] What already moved** — `MenuState.swift` (300 lines, Foundation-only) exists with `MenuStateTests.swift` in the `TugTests` bundle. Nothing else from the first brief's [B01] exists: no `MenuBarBuilder`, `MenuStateSync`, or `BridgeHandler` under `tugapp/Sources`. **(verified)**

**[F03] The bridge protocol is unchanged** — `BridgeDelegate` (`MainWindow.swift:61`) has eleven requirements, and `AppDelegate` is its only conformer. **(verified)**

**[F04] A host-less XCTest bundle now exists** — `tugapp/TugTests/` holds seven test files compiled against the Foundation-only sources without a `TEST_HOST`. A bundle with no host can still link AppKit and construct an `NSMenu` tree without `NSApplication` running, which the first brief did not have available and which changes how the menu builder is verified. **(verified for the bundle; the AppKit-without-host claim is inferred from how XCTest logic bundles work and is confirmed by the arc's first step)**

---

## Decisions {#decisions}

**[B01] Three types leave the delegate: `MenuBarBuilder`, `MenuStateSync`, and `BridgeHandler`.** `MenuBarBuilder` builds the bar and returns a `MenuHandles` struct, replacing the four implicitly-unwrapped properties. `MenuStateSync` takes the `NSMenuDelegate` conformance and the three rebuild functions, with a weak reference to the delegate for the facts it reads. `BridgeHandler` takes the `BridgeDelegate` conformance with weak references to the window and the process manager. `MenuState` is already out ([F02]).

**[B02] The 96 `@objc` actions stay on `AppDelegate` as one-line forwarders.** AppKit owns the selector and validation wiring; moving bodies while leaving selectors costs nothing and changes no responder path. Bodies move to the type that owns the state they touch.

**[B03] `MenuBarBuilder` gets an XCTest that builds the bar and walks it.** [F04]: the test asserts every top-level menu title, every item's title and key equivalent, and the selector each item targets, as a table. This replaces the first brief's hand-walk of the debug app as the primary verdict, and it is the test that catches a chord moved by accident. The hand-walk stays as the one-time confirmation after the last step.

**[B04] `MenuBarBuilder` is added to the `TugTests` target's compile sources alongside the Foundation-only files, and the bundle links AppKit.** If the first step shows an `NSMenu` cannot be built without a host, the test target gains the app as its host and the brief's [B03] still holds; the arc records which.

**[B05] Order: `BridgeHandler`, then `MenuBarBuilder` with its test, then `MenuStateSync`.** The bridge handler is a protocol with eleven methods and no AppKit, so it is the smallest proof the extraction shape works; the builder is the largest and brings the test; the dynamic rebuilds go last because they consume the handles the builder returns.

---

## Open Questions {#open-questions}

- None. The one unknown, whether the host-less bundle can build menus, is settled in the first step rather than guessed here ([B04]).

---

## Non-goals {#non-goals}

- **Touching `MainWindow.swift`.** Its path handlers were done by the loopback arc; the rest is its own arc.
- **Changing any menu, chord, or validation rule.**
- **Moving the `@objc` selectors.** [B02].

---

## Exit {#exit}

An arc. Steps as ordered in [B05], each ending with `just build-app` and `just test-swift` green. After the last step, the `@covers`-derived app-test selection for `AppDelegate.swift` and the three new files runs once, and the debug app's menu bar is walked by hand once. The earlier `appdelegate-extraction-brief.md` is superseded by this one and should not be opened.
