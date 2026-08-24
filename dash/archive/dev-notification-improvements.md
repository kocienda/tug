# Dev Notification Improvements

## Problem

The dev-mode notification system (implemented per `dev-mode-notifications.md`) has a critical routing bug, confusing internal naming, and missing state information that makes the Developer card less useful than intended.

### 1. Notification routing is broken

The `dev_notification` and `dev_build_progress` action handlers in `action-dispatch.ts` use `cardState.tabItems` to find the Developer card instance. But `CardState` (defined in `layout-tree.ts`) has a `tabs` field, not `tabItems`. The property access silently returns `undefined`, the loop never executes, and the Developer card never receives notifications when it's open. The dock badge path works (it fires when the card is "closed"), but the card's `update()` method is never called.

This is a one-line fix in two places: `cardState.tabItems` -> `cardState.tabs`.

### 2. "Category 1/2/3" naming is opaque

The plan and code comments refer to "Category 1", "Category 2", "Category 3" throughout. These numbers carry no meaning. The code itself already uses better names in function signatures (`dev_file_watcher`, `dev_compiled_watcher`, `dev_app_watcher`) and notification types (`reloaded`, `restart_available`, `relaunch_available`), but the category numbers persist in comments, doc strings, and the plan document.

Proposed naming:

| Old | New | What it covers |
|-----|-----|----------------|
| Category 1 | **styles** | CSS and HTML hot reload (automatic) |
| Category 2 | **code** | Compiled frontend (`dist/app.js`) + backend (`tugcast` binary) |
| Category 3 | **app** | Mac app Swift sources |

These match the Developer card's row labels ("Styles", "Code", "App") and are self-explanatory.

### 3. No timestamp on notifications

When the Developer card shows "Clean" for a row, there's no indication of *when* it was last checked or when the last change was detected. After a restart, did the styles reload 2 seconds ago or 20 minutes ago? The developer has no way to know.

Adding a timestamp to each notification enables:
- Displaying "Clean (last: 9:42 AM)" on each row
- Knowing whether a notification is stale
- Debugging notification delivery issues

### 4. Backend watches build outputs, not source files

This is by design (the plan explains why), but it means touching a `.rs` or `.ts` source file doesn't directly trigger a notification. The flow is:

- Edit `.ts` file -> `bun build --watch` recompiles `dist/app.js` -> mtime poller detects -> notification
- Edit `.rs` file -> developer runs `cargo build` (or cargo-watch does) -> binary mtime changes -> notification

If `bun build --watch` isn't running or the developer hasn't built yet, no notification appears. This is correct behavior but could be confusing. The Developer card should make this clear -- perhaps "Code" should say "Watching build outputs" rather than implying it watches source files.

## Proposed Changes

### Fix 1: Routing bug (critical, immediate)

In `tugdeck/src/action-dispatch.ts`, change both occurrences of:
```typescript
for (const tabItem of cardState.tabItems) {
```
to:
```typescript
for (const tabItem of cardState.tabs) {
```

This fixes both the `dev_notification` handler (line ~192) and the `dev_build_progress` handler (line ~227).

### Fix 2: Replace category numbers with names

In `tugcode/crates/tugcast/src/dev.rs`, replace all "Category 1/2/3" references in comments with the human-readable names: **styles**, **code**, **app**. No code changes needed -- only comment text.

Examples:
- "Category 1 watcher: HTML/CSS" -> "Styles watcher: HTML/CSS live reload"
- "Category 2 watcher: compiled code" -> "Code watcher: compiled frontend + backend"
- "Category 3 watcher: app sources" -> "App watcher: Mac app Swift sources"

### Fix 3: Add timestamp to notification protocol

Extend the `dev_notification` payload with a `timestamp` field:

```json
{"action": "dev_notification", "type": "reloaded", "timestamp": 1740000000000}
{"action": "dev_notification", "type": "restart_available", "changes": ["frontend"], "count": 1, "timestamp": 1740000000000}
```

The timestamp is milliseconds since Unix epoch (matches JavaScript's `Date.now()`).

**Rust side:** In `send_dev_notification()`, add:
```rust
use std::time::{SystemTime, UNIX_EPOCH};
let timestamp = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_millis() as u64;
```

**TypeScript side:** In `DeveloperCard.update()`, store the timestamp and display it:
- When a row is "Clean", show the time of the last notification: "Clean -- 9:42 AM"
- When a row is dirty, show the time of the first change: "2 changes -- since 9:38 AM"
- Format as locale time string (hours:minutes AM/PM)

### Fix 4: Improve Developer card row labels

When all rows show "Clean", add context about what each row watches:

| Row | Clean state | Dirty state |
|-----|-------------|-------------|
| Styles | Clean -- 9:42 AM | Reloaded (flashes, returns to Clean) |
| Code | Clean -- 9:38 AM | 2 changes -- since 9:38 AM [Restart] |
| App | Clean -- 9:35 AM | 1 change -- since 9:40 AM [Relaunch] |

The "since" time is the timestamp of the first dirty notification after the last clean state.

## Implementation Order

1. **Fix the routing bug** -- one-line fix, unblocks everything else
2. **Add timestamps** -- protocol change in Rust, display in TypeScript
3. **Rename categories** -- comment-only cleanup in dev.rs
4. **Improve card labels** -- TypeScript-only UI polish

Fixes 1 and 3 are the only ones that touch both Rust and TypeScript. Fix 2 is Rust-only comments. Fix 4 is TypeScript-only.

## Non-goals

- Watching source files directly (the build-output-watching design is intentional)
- Changing the notification protocol structure beyond adding `timestamp`
- Restructuring the watcher architecture
- Adding new watcher categories
