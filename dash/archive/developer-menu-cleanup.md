# Developer Menu Cleanup

Clean up the Developer menu: rename items, remove items, and clean up all associated middleware and backend code so nothing dangles.

## Target Menu Layout

```
Reload                          Cmd+R
-----
Show JavaScript Console         Opt+Cmd+C
-----
Show Component Gallery          Opt+Cmd+G
Show Test Card                  Opt+Cmd+T
Add Tab To Active Card
-----
Source Tree...
```

## Changes

### Renames (menu title + action name + handler name — everywhere)

1. **"Reload Frontend" → "Reload"**
   - Action: `reload_frontend` → `reload`
   - Swift handler: `reloadFrontend(_:)` → `reload(_:)`
   - Wire: `sendControl("reload_frontend")` → `sendControl("reload")`
   - Frontend: `registerAction("reload_frontend", ...)` → `registerAction("reload", ...)`
   - Tests: update action strings in `action-dispatch.test.ts` and `integration_tests.rs`
   - Rust: update `server.rs` assertion that references `reload_frontend`, update `cli.rs` doc comment

2. **"Add Tab" → "Add Tab To Active Card"**
   - Action: `add-tab` → `add-tab-to-active-card`
   - Swift handler: `addTab(_:)` → `addTabToActiveCard(_:)`
   - Wire: `sendControl("add-tab")` → `sendControl("add-tab-to-active-card")`
   - Frontend: `registerAction("add-tab", ...)` → `registerAction("add-tab-to-active-card", ...)`
   - Responder chain action: `"addTab"` → `"addTabToActiveCard"` (in `action-dispatch.ts`, `deck-canvas.tsx`, `responder-chain-provider.tsx`, and associated tests)
   - Note: `store.addTab()` method on DeckManager stays — it's a generic store API, not an action name

3. **"Choose Source Tree..." → "Source Tree..."**
   - Action: `choose-source-tree` → `source-tree`
   - Swift handler: `chooseSourceTree(_:)` → `sourceTree(_:)`
   - Wire: no wire action (menu directly opens file picker, no `sendControl` call)
   - Frontend: `registerAction("choose-source-tree", ...)` → `registerAction("source-tree", ...)`
   - WKScriptMessageHandler bridge name: `chooseSourceTree` → `sourceTree` (in `MainWindow.swift` and `action-dispatch.ts`)
   - Tests: update action strings in `action-dispatch.test.ts`

4. **"Show JavaScript Console" — no menu rename, but rename the handler**
   - Swift handler: `openWebInspector(_:)` → `showJavaScriptConsole(_:)`
   - Note: this item has no wire action — it directly calls `window.openWebInspector()` which stays (that's the WKWebView API)

### Removals (menu items + all supporting code)

5. **"Restart Server"** — remove menu item, `restartServer(_:)` handler, `restartMenuItem` property, and the `restart` action branch in `actions.rs` (exit code 42). Remove the `restart` shutdown reason handling and `copyBinaryFromSourceTree()` in `ProcessManager.swift` (verify no other callers first). Remove the `test_dispatch_action_restart` test.

6. **"Relaunch App"** — remove menu item, `relaunchApp(_:)` handler, `relaunchMenuItem` property, and the `relaunch` action branch in `actions.rs`. Remove the entire relaunch orchestration in `control.rs` (`handle_relaunch`, `resolve_app_bundle`, `resolve_tugrelaunch_binary`, `connect_progress_socket`, `relay_progress`, `send_build_progress_error`, and associated tests). Remove the `relaunch` shutdown reason case in `ProcessManager.swift`. Remove the `tugrelaunch` crate from `Cargo.toml` workspace members and delete `tugcode/crates/tugrelaunch/`. Verify `dev_build_progress` frame type has no other producers before removing.

7. **"Reset Everything"** — remove menu item, `resetEverything(_:)` handler, and the `reset` action branch in `actions.rs` (exit code 43). Remove the `reset` shutdown reason handling in `ProcessManager.swift`. Remove the `reset` action handler in `action-dispatch.ts` and its tests in `action-dispatch.test.ts`.

8. **"Source Tree: /path"** (the disabled display item) — remove from menu, remove `sourceTreeMenuItem` property and any update logic.

### Structural

9. **Add a divider** between "Add Tab To Active Card" and "Source Tree...".
10. **Remove dividers** that are no longer needed (the one that used to appear above "Show JavaScript Console" remains; the one above "Show Component Gallery" remains; a new one goes before "Source Tree...").

## Files to Touch

| File | What Changes |
|------|-------------|
| `tugapp/Sources/AppDelegate.swift` | Rename 4 handlers + 3 menu titles, remove 4 items + handlers + properties, adjust dividers |
| `tugapp/Sources/MainWindow.swift` | Rename `chooseSourceTree` → `sourceTree` in WKScriptMessageHandler registration/handling |
| `tugapp/Sources/ProcessManager.swift` | Remove `restart`/`reset`/`relaunch` shutdown reason cases, remove `copyBinaryFromSourceTree()` |
| `tugcode/crates/tugcast/src/actions.rs` | Remove `restart`, `reset`, `relaunch` match arms + tests |
| `tugcode/crates/tugcast/src/control.rs` | Remove `handle_relaunch` and all relaunch orchestration helpers + tests |
| `tugcode/crates/tugcast/src/server.rs` | Update assertion referencing `reload_frontend` |
| `tugcode/crates/tugcast/src/integration_tests.rs` | Update `reload_frontend` → `reload` in test |
| `tugcode/crates/tugcode/src/cli.rs` | Update doc comment referencing `reload_frontend` |
| `tugcode/Cargo.toml` | Remove `tugrelaunch` from workspace members |
| `tugcode/crates/tugrelaunch/` | Delete entire crate |
| `tugdeck/src/action-dispatch.ts` | Rename `reload_frontend` → `reload`, `add-tab` → `add-tab-to-active-card`, `choose-source-tree` → `source-tree`; remove `reset` handler |
| `tugdeck/src/__tests__/action-dispatch.test.ts` | Update all renamed action strings; remove `reset` tests |
| `tugdeck/src/components/chrome/deck-canvas.tsx` | Rename responder chain action `addTab` → `addTabToActiveCard` |
| `tugdeck/src/components/tugways/responder-chain-provider.tsx` | Update `addTab` reference in comment |
| `tugdeck/src/__tests__/deck-canvas.test.tsx` | Update `addTab` → `addTabToActiveCard` in responder chain tests |
| `tugdeck/src/__tests__/e2e-responder-chain.test.tsx` | Update if it references `addTab` responder action |

## What Stays Untouched

- `show-component-gallery`, `show-card`, `set-dev-mode`, `set-theme` actions
- `RestartDecision` enum and the restart-with-backoff logic in `ProcessManager.swift` (handles tugcast crashes, not user-initiated restart — verify `.restart` is still reachable after removing the menu-initiated restart reason; simplify enum if not)
- `window.openWebInspector()` call on WKWebView (that's the WebKit API name, not ours)
- `store.addTab()` method on DeckManager (generic store API, not an action name)

## Open Questions

- Verify `copyBinaryFromSourceTree()` has no callers outside the `restart` shutdown reason handler before removing.
- Verify `dev_build_progress` frame type has no other producers before removing.
- After removing the menu-initiated `restart` reason, verify `.restart` is still reachable from the crash/backoff path. If not, simplify the `RestartDecision` enum.
- Exit codes 42, 43, 45 in `actions.rs` — approved for removal (42=restart, 43=reset, 45=relaunch complete).
