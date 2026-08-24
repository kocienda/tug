# Developer Card Working State

Show developers what they're looking at — is the running version current, and have files changed from what's committed?

## Problem

The Developer card currently tracks one dimension: whether the running version matches the latest file changes. For Code and App, this means "needs restart/relaunch." For Styles, it means almost nothing — hot reload keeps the browser current automatically, so the row flashes "Reloaded" then returns to "Clean" in a cycle that carries little information.

What's missing is the second dimension: **have source files changed relative to the committed version?** This is the "am I looking at committed code or a work-in-progress?" question. It matters for all three rows:

- **Styles:** The browser shows live CSS, but is it committed? A developer switching branches or handing off needs to know.
- **Code:** After a restart, the build is current — but does it match what's in git? If not, there's uncommitted work.
- **App:** Same as Code. After a relaunch, is the running app built from committed source?

The "Clean" label currently means "running version is current." It says nothing about committed state. A row can show "Clean" while the developer has 15 uncommitted files in that category. That's a blind spot.

## Existing Infrastructure

**We already have git status plumbed end-to-end.** The Git card displays it:

1. `GitFeed` (Rust, `tugcast/src/feeds/git.rs`) polls `git status --porcelain=v2` every 2 seconds
2. Parses into a `GitStatus` struct with `staged`, `unstaged` (`Vec<FileStatus>` with path + status code), and `untracked` (`Vec<String>`)
3. Sends as a `FeedId::Git` (0x20) frame over WebSocket
4. `DeckManager` fan-out broadcasts to all subscribed cards
5. `GitCard` renders the full file list

The Developer card currently receives data only through `dev_notification` actions (Control frames). But any card can subscribe to additional feed IDs by declaring them in its `feedIds` array. The Developer card can add `FeedId.GIT` and receive the same `GitStatus` payloads the Git card gets — no backend changes required.

## Design

### Two dimensions, one glanceable label

Each row has two independent states:

| Dimension | Source | Question |
|-----------|--------|----------|
| **Runtime** | File watcher notifications | Is the running version current? |
| **Working** | Git status feed | Have source files changed from committed? |

For **Styles**, the runtime dimension is trivial (always current due to hot reload), so only the working dimension matters. For **Code** and **App**, both dimensions are relevant.

### State table

| Runtime | Working | What the dev sees |
|---------|---------|-------------------|
| Current | Committed | **Clean** — nothing to do |
| Current | Edited | **Edited** — uncommitted changes, but running version is current |
| Stale | Edited | **N changes — restart/relaunch** — action needed (edited is implicit) |
| Stale | Committed | Unlikely in practice but possible (e.g., `git stash` after editing) — show stale state |

The stale state always dominates because it requires action. "Edited" only surfaces when the running version is current — it's the "you're up to date but haven't committed" reminder.

For **Styles**, there is no stale state. The row is either "Clean" or "Edited."

### Row labels

| Row | Clean | Edited | Stale |
|-----|-------|--------|-------|
| **Styles** | Clean | Edited (N files) | *(n/a — hot reload)* |
| **Code** | Clean | Edited (N files) | N changes — restart |
| **App** | Clean | Edited (N files) | N changes — relaunch |

Timestamps from the previous plan carry forward: "Clean -- 9:42 AM", "Edited (3 files) -- 9:42 AM", "2 changes -- since 9:38 AM".

When both dimensions are active (stale + edited), show the stale state — the developer needs to restart/relaunch first, and the "edited" state will resolve to the correct display after they do.

### Dot indicator colors

The dot indicator (already present on each row) gains a third color:

| State | Dot color |
|-------|-----------|
| Clean | Green (existing) |
| Edited | Blue (new — work in progress, no action needed) |
| Stale | Yellow/amber (existing — action needed) |

Blue is intentionally calm. It says "you have uncommitted work" without implying urgency.

## File categorization

The Developer card needs to map git file paths to rows. The rules mirror what the backend watchers already cover:

| Row | Git path patterns |
|-----|-------------------|
| **Styles** | `tugdeck/**/*.css`, `tugdeck/**/*.html` |
| **Code** | `tugdeck/src/**/*.ts`, `tugdeck/src/**/*.tsx`, `tugcode/**/*.rs`, `tugcode/**/Cargo.toml` |
| **App** | `tugapp/Sources/**/*.swift` |

Files outside these patterns (docs, configs, tests, etc.) are ignored by the Developer card — the Git card already shows everything.

These patterns are hardcoded in the TypeScript card. They're stable (they match the project's directory structure) and keeping them client-side avoids any backend protocol changes.

The card counts both `unstaged` and `staged` files from `GitStatus` — any file that differs from HEAD counts as "edited" regardless of staging state.

## Implementation

### What changes

| Layer | Change | Scope |
|-------|--------|-------|
| **Developer card (TS)** | Add `FeedId.GIT` to `feedIds`; implement `onFrame()` to parse `GitStatus` and categorize files | Medium |
| **Developer card (TS)** | Add file-path categorization logic (pattern matching against row categories) | Small |
| **Developer card (TS)** | Update row rendering to show "Edited (N files)" state with blue dot | Small |
| **Developer card (TS)** | Merge runtime state (from `update()`) with working state (from `onFrame()`) for composite display | Medium |
| **Developer card CSS** | Add blue dot color class | Trivial |
| **Developer card tests** | New tests for git status integration, file categorization, state merging | Medium |
| **Backend (Rust)** | None | — |

### What doesn't change

- The `GitFeed` polling, parsing, and frame encoding — untouched
- The `GitCard` — continues to show the full git status independently
- The `dev_notification` protocol — the watcher system continues to work exactly as before
- The `DeckManager` fan-out system — the Developer card simply subscribes to an additional feed

### State merging logic

The Developer card maintains two state sources per row:

```
runtimeState: { status: "clean" | "stale", count?: number, timestamp?: number }
workingState: { editedCount: number }  // from GitStatus categorization
```

The display merges these:

```
if runtimeState.status === "stale":
    show stale label (N changes — restart/relaunch)
else if workingState.editedCount > 0:
    show edited label (Edited (N files))
else:
    show clean label
```

The `onFrame()` handler (git status) and `update()` handler (dev notifications) both trigger a re-render. Since git status polls every 2 seconds, the "Edited" state appears within 2 seconds of a file save — fast enough for a status indicator.

## Non-goals

- Showing individual file names in the Developer card (that's what the Git card is for)
- Changing the git polling interval or mechanism
- Adding git-awareness to the Rust file watchers
- Tracking staged vs unstaged distinction in the Developer card (both count as "edited")
- Showing "edited" state for files outside the three watched categories
