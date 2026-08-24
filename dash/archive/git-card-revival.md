# Git Card Revival

*Revive the git status card as the first live-feed-powered card in the modern tugways system. This serves as end-to-end verification of the Protocol v1 wire format (T0.5) and establishes the feed subscription pattern for all future cards.*

## Context

The git card was demolished in Phase 0 Demolition (commit `c8caa511`). It was a working React component that displayed branch name, ahead/behind counts, staged/unstaged/untracked files, and HEAD commit message. The server-side git feed (`tugrust/crates/tugcast/src/feeds/git.rs`) is still fully operational — it polls `git status` every 2 seconds and sends `GitStatus` JSON on FeedId `0x20` via a snapshot watch channel.

What's missing is the frontend: no card component, and — critically — no feed subscription wiring in `tug-card.tsx`. The card system currently stubs out feed data with an empty map (line 922: "feeds not yet wired").

This work delivers both the infrastructure (feed wiring) and the card (git status UI), giving us a live end-to-end signal through the entire stack.

## Prior Art

The old git card (`git show c8caa511^:tugdeck/src/components/cards/git-card.tsx`) used:
- `useFeed(FeedId.GIT)` — a hook that returned `Uint8Array | null` from the connection
- `useState` + `useEffect` to parse JSON and store `GitStatus`
- `useCardMeta` to set title/icon/menu items
- Tailwind utilities and shadcn `ScrollArea` for layout
- Lucide icons (`GitBranch`, `CircleCheck`, `CircleDot`, `CircleDashed`)

The old approach violates L02 (external state via `useSyncExternalStore` only — not `useState` + `useEffect` sync). The new card must use the `TugcardDataProvider` / `useTugcardData` pattern that's already stubbed in tug-card.tsx.

## GitStatus Schema

From `tugcast-core/src/types.rs` — this is what the server sends:

```typescript
interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  staged: FileStatus[];
  unstaged: FileStatus[];
  untracked: string[];
  head_sha: string;
  head_message: string;
}

interface FileStatus {
  path: string;
  status: string;  // M, A, D, R, etc.
}
```

## Architecture

### Data Flow

```
tugcast (git feed, 2s poll)
  → GitStatus JSON on FeedId 0x20
  → binary frame [0x20][0x00][len][json]
  → WebSocket
  → tugdeck connection.ts decodeFrame()
  → tug-card.tsx feed subscription (NEW)
  → TugcardDataProvider feedData map
  → useTugcardData<GitStatus>() in git card
  → rendered UI
```

### Key Design Decisions

1. **Feed subscription lives in tug-card.tsx**, not in individual card components. The card declares `defaultFeedIds: [FeedId.GIT]` at registration time. Tugcard subscribes to those feeds on the connection, decodes payloads, and provides them via `TugcardDataProvider`. Card content components access data via `useTugcardData<T>()`.

2. **L02 compliance**: the feed data is external state from the WebSocket. It must enter React through `useSyncExternalStore`. The subscription store is per-card-instance (created when Tugcard mounts, destroyed when it unmounts).

3. **The connection singleton** (`main.tsx` line 30) is accessed via a module-level export — not React context. Tugcard imports it directly. This follows the existing pattern (TugbankClient, action-dispatch all import the connection directly).

4. **JSON decode is the default.** The `decode` prop on `TugcardProps` already exists for custom decoders. The default path: `new TextDecoder().decode(bytes)` → `JSON.parse()`. This is sufficient for the git feed and most feeds.

## Steps

### Step 1: Export the Connection Singleton

**File:** `tugdeck/src/main.tsx`

Export the `connection` variable so other modules can import it:

```typescript
export const connection = new TugConnection(wsUrl);
```

Currently it's a `const` in module scope but not exported. One word change.

**File:** `tugdeck/src/connection.ts`

No changes needed — `TugConnection.onFrame()` already provides the subscription API.

### Step 2: Wire Feed Subscriptions in Tugcard

**File:** `tugdeck/src/components/tugways/tug-card.tsx`

Replace the stub at line 922 ("feeds not yet wired") with a real feed subscription store.

The implementation:

1. Create a `FeedStore` class (can live in a separate file or inline) that:
   - Takes a `TugConnection` and a list of `FeedIdValue[]`
   - Subscribes to each FeedId via `connection.onFrame(feedId, callback)`
   - On each frame: decodes the payload (JSON.parse by default), stores in an internal `Map<number, unknown>`
   - Exposes `subscribe` and `getSnapshot` for `useSyncExternalStore`
   - Cleans up subscriptions on dispose

2. In Tugcard, create the FeedStore on mount (via `useRef` + `useLayoutEffect`):
   ```typescript
   const feedStoreRef = useRef<FeedStore | null>(null);
   if (feedStoreRef.current === null && feedIds.length > 0) {
     feedStoreRef.current = new FeedStore(connection, feedIds, decode);
   }
   ```

3. Use `useSyncExternalStore` to read the feed data map:
   ```typescript
   const feedData = useSyncExternalStore(
     feedStoreRef.current?.subscribe ?? noopSubscribe,
     feedStoreRef.current?.getSnapshot ?? emptySnapshot
   );
   ```

4. Pass `feedData` to `TugcardDataProvider` (replacing the current `emptyFeedData.current`).

5. Set `feedsReady = feedIds.length === 0 || feedData.size > 0` so feed-dependent cards wait for the first frame.

**Key L02 compliance:** External WebSocket data enters React exclusively through `useSyncExternalStore`. No `useState` + `useEffect` sync. The `FeedStore` is an external subscribable store, not React state.

### Step 3: Create the Git Card Component

**File:** `tugdeck/src/components/tugways/cards/git-card.tsx` (new)

A modern card component that:
- Calls `useTugcardData<GitStatus>()` to get decoded git data
- Renders branch name with `GitBranch` Lucide icon
- Shows ahead/behind indicators
- Shows HEAD commit message
- Lists staged (green), unstaged (yellow), untracked (gray) files
- Shows "Clean working tree" when all lists are empty
- Shows "Waiting for git status..." when no data yet
- Uses `--tug-*` semantic tokens for all colors (not Tailwind color classes)
- Uses `data-slot="git-card"` per L19

The UI closely follows the old card's layout (it was clean and effective) but with Laws of Tug compliance:
- No `useState` + `useEffect` for feed data (L02 — handled by Step 2)
- CSS tokens for colors, not hardcoded Tailwind classes (L15, L18)
- Proper `data-slot` annotations (L19)

### Step 4: Register the Git Card

**File:** `tugdeck/src/components/tugways/cards/git-card.tsx` (same file)

Add registration function:

```typescript
export function registerGitCard(): void {
  registerCard({
    componentId: "git",
    contentFactory: () => <GitCardContent />,
    defaultMeta: { title: "Git", icon: "GitBranch", closable: true },
    defaultFeedIds: [FeedId.GIT],
  });
}
```

**File:** `tugdeck/src/main.tsx`

Call `registerGitCard()` alongside the other registrations.

### Step 5: Add Developer Menu Item (Swift)

**File:** `tugapp/Sources/AppDelegate.swift`

Add a "Show Git Card" menu item to the Developer menu, following the existing pattern:

```swift
devMenu.addItem(NSMenuItem(title: "Show Git Card",
    action: #selector(showGitCard(_:)),
    keyEquivalent: "2",
    modifierMask: [.command, .option]))
```

And the handler:

```swift
@objc private func showGitCard(_ sender: Any) {
    sendControl("show-card", params: ["component": "git"])
}
```

This sends a `show-card` control frame with `component: "git"`, which `action-dispatch.ts` routes to `deckManager.addCard("git")`, which looks up the registration and creates the card.

### Step 6: Tests

**File:** `tugdeck/src/__tests__/git-card.test.tsx` (new)

Tests modeled on the old test file but using the modern `TugcardDataProvider` pattern:
- Renders "Waiting for git status..." with no feed data
- Renders branch name from feed data
- Renders ahead/behind indicators
- Renders staged/unstaged/untracked file lists
- Renders "Clean working tree" when all lists empty
- Renders HEAD commit message

### Step 7: End-to-End Verification

Manual verification steps:
1. `just build` from repo root (builds tugcast + tugcode)
2. Launch Tug.app
3. Developer > Show Git Card (Cmd+Opt+2)
4. Verify: branch name, commit message, file lists appear
5. Make a file change in the repo, verify the card updates within ~2 seconds
6. Stage a file, verify it moves from "Unstaged" to "Staged"
7. Commit, verify "Clean working tree" appears

This exercises: tugcast git feed → Protocol v1 binary frame (6-byte header with flags byte) → WebSocket → tugdeck `decodeFrame` → `FeedStore` subscription → `useSyncExternalStore` → `TugcardDataProvider` → `useTugcardData<GitStatus>()` → rendered React component.

## Exit Criteria

- [ ] `FeedStore` wires WebSocket frames to `TugcardDataProvider` via `useSyncExternalStore` (L02)
- [ ] Git card renders live data from the tugcast git feed
- [ ] Developer menu has "Show Git Card" (Cmd+Opt+2)
- [ ] `bun test` passes (new git card tests + existing tests)
- [ ] `cargo nextest run` passes (no Rust changes expected)
- [ ] End-to-end verification in live Tug.app session
- [ ] Protocol v1 (6-byte header, flags byte) confirmed working end-to-end
