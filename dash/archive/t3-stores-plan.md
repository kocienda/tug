# T3.3 Plan: Stores — SessionMetadataStore + PromptHistoryStore

*Data sources that feed tug-prompt-input's completions and history. Bridges the gap between the raw Claude Code protocol and the UI-centric provider interfaces established in T3.2.*

---

## Context

T3.2 established three provider interfaces on tug-prompt-input:

1. **`CompletionProvider`** — `(query: string) => CompletionItem[]`, keyed by trigger character in `completionProviders: Record<string, CompletionProvider>`. Currently mocked with hardcoded file lists and command names.

2. **`HistoryProvider`** — `back(current) / forward()` returning `TugTextEditingState | null`. Currently mocked with a `GalleryHistoryProvider` class that tracks session submissions.

3. **`onRouteChange`** — `(route: string | null) => void` callback. Currently wired to a gallery card display label.

T3.3 replaces the mocks with real data. T3.4 (tug-prompt-entry) will be the consumer that wires stores to providers.

---

## Data Flow

```
Claude Code ──(stdout)──> tugcode ──(IPC)──> tugcast ──(WebSocket)──> FeedStore
                                                │                         │
                                                │     SessionMetadataStore <── CODE_OUTPUT
                                                │            │
                                                │            ├── slash commands → CompletionProvider for "/"
                                                │            ├── model, session_id → UI display
                                                │            └── tools list → (future: tool completion)
                                                │
                                          FileWatcher
                                                │
                                          FileTreeStore <── FILETREE (0x11)
                                                │
                                                └── project files → CompletionProvider for "@"

User submissions ──> PromptHistoryStore ──> HistoryProvider for Cmd+Up/Down
                          │
                          └── tugbank persistence (survives reload/quit)
```

---

## Store 1: SessionMetadataStore

### What it captures

The `system_metadata` event arrives on CODE_OUTPUT at session start. It contains (from `tugcode/src/types.ts`):

```typescript
interface SystemMetadata {
  type: "system_metadata";
  session_id: string;
  cwd: string;
  model: string;
  permissionMode: string;
  slash_commands: unknown[];
  skills: unknown[];
  plugins: unknown[];
  agents: unknown[];
  mcp_servers: unknown[];
  version: string;
  // ...
}
```

### What we extract

For T3.3, we need:

| Field | Purpose | Consumer |
|-------|---------|----------|
| `slash_commands` | Command completion for `/` trigger | `CompletionProvider` |
| `skills` | Merged with slash_commands for `/` completion | `CompletionProvider` |
| `session_id` | Session identity | tug-prompt-entry (future) |
| `model` | Display in prompt entry chrome | tug-prompt-entry (future) |
| `permissionMode` | Display/behavior | tug-prompt-entry (future) |
| `cwd` | Working directory — used for history tagging (`projectPath`) and display | PromptHistoryStore, tug-prompt-entry (future) |

### API design

```typescript
class SessionMetadataStore {
  // L02-compliant subscription
  subscribe(listener: () => void): () => void;
  getSnapshot(): SessionMetadataSnapshot;

  // Derived data for direct consumer use
  getCommandCompletionProvider(): CompletionProvider;
}

interface SessionMetadataSnapshot {
  sessionId: string | null;
  model: string | null;
  permissionMode: string | null;
  cwd: string | null;
  slashCommands: SlashCommandInfo[];
}

interface SlashCommandInfo {
  name: string;
  description?: string;
  category: "local" | "agent" | "skill";
}
```

**Key design choice:** `getCommandCompletionProvider()` returns a function that closes over the store's current data. It matches the `CompletionProvider` type signature `(query: string) => CompletionItem[]`. This is the bridge between the store (L02 data) and the engine (L06 DOM-driven UI). The provider does NOT use `useSyncExternalStore` — it reads the store's current data synchronously when called. The engine calls it on each keystroke; the store's data updates when a new session_metadata arrives.

### Construction and lifecycle

```typescript
const metadataStore = new SessionMetadataStore(feedStore, FeedId.CODE_OUTPUT);
```

- Takes a `FeedStore` and the feed ID to listen on
- Subscribes to feed updates, filters for `type === "system_metadata"` events
- Parses slash commands and skills into typed arrays
- Notifies subscribers when metadata changes

The store is created once per connection (at the DeckManager level or similar) and passed down. Individual cards/components don't create their own.

**Slash command completion is a closed set.** The system never allows freeform `/foo` — it always completes to a known command. The completion provider filters the known set by query; if nothing matches exactly, it shows the closest matches (case-insensitive substring match, same pattern as file completion). Strict types with `name` (required) and `description` (optional). Parse defensively at the store boundary — skip entries without a `name` string.

---

## Store 2: PromptHistoryStore

### Tiered history model

History has three access tiers. Storage supports all three from day one; T3.3 implements navigation only.

| Tier | Scope | Access | When |
|------|-------|--------|------|
| **Navigate** | Current session | Cmd+Up/Down | T3.3 (now) |
| **Search** | Per-project (`cwd`) | Search UI | T3.4+ (future) |
| **Search** | Global (all projects) | Search UI | Later |

### What it stores

Every prompt submission, tagged with enough metadata to query at any scope:

```typescript
interface HistoryEntry {
  id: string;              // UUID — unique across all history
  sessionId: string;       // from SessionMetadataStore — groups entries per session
  projectPath: string;     // cwd from session metadata — groups per project
  route: string;           // ">", "$", ":", "/"
  text: string;            // prompt text with TUG_ATOM_CHAR for atoms
  atoms: SerializedAtom[]; // atom data for restoration
  timestamp: number;       // ms since epoch
}

interface SerializedAtom {
  position: number;
  type: string;
  label: string;
  value: string;
}
```

**History entries include atoms.** Atoms are "promises" — the atom records what the user attached, not whether the target still exists. Resolution (does this file exist? is this command valid?) happens at submit time, not at storage or restore time. History restores exactly what was typed.

### Navigation scope: current session

Cmd+Up/Down walks entries from the current session only. "What did I just type?" — not the full project history.

The `HistoryProvider` returned by `createProvider()` filters to entries matching the current `sessionId`. This gives focused, predictable navigation without scrolling through weeks of history.

### API design

```typescript
class PromptHistoryStore {
  // L02-compliant subscription
  subscribe(listener: () => void): () => void;
  getSnapshot(): PromptHistorySnapshot;

  // Push a new entry after submission
  push(entry: HistoryEntry): void;

  // Create a HistoryProvider for Cmd+Up/Down navigation.
  // Scoped to the given sessionId — only that session's entries are navigable.
  createProvider(sessionId: string): HistoryProvider;

  // Future: search API for project and global tiers
  // search(query: string, scope: { projectPath?: string }): HistoryEntry[];
}

interface PromptHistorySnapshot {
  /** Total entry count across all sessions. */
  totalEntries: number;
  /** Entry count for the current session (if any provider is active). */
  sessionEntries: number;
}
```

**Key design choices:**

- `push(entry)` takes a fully-tagged `HistoryEntry`. The caller (tug-prompt-entry) provides `sessionId`, `projectPath`, and `route` from SessionMetadataStore and the current route state.
- `createProvider(sessionId)` returns a `HistoryProvider` scoped to that session. Same `back(current) / forward()` interface the engine expects. Manages its own cursor and draft (same pattern as the gallery mock `GalleryHistoryProvider`).
- `subscribe`/`getSnapshot` are L02-compliant. The snapshot is lightweight metadata (counts), not the full entry array.

### Persistence: tugbank

History must survive reload, app quit, and `just app` restarts (L23). Tugbank is the existing persistence layer — SQLite-backed, REST API, used by everything else.

**Storage key:** `dev.tugtool.prompt.history/{sessionId}`
**Value:** JSON array of that session's `HistoryEntry` objects.

One key per session. Navigation reads exactly one key (fast). Future project search lists all keys under `dev.tugtool.prompt.history/` and filters by `projectPath`.

```
PUT /api/defaults/dev.tugtool.prompt.history/session-abc123
Body: { "kind": "json", "value": [{ "id": "...", "sessionId": "...", ... }, ...] }
```

**Write path:** `push()` writes to both the in-memory array and tugbank (fire-and-forget async PUT, same pattern as `putTabState`).

**Read path:** On first `createProvider()` for a session, fetch from tugbank into memory. Subsequent reads are from memory. Tugbank is the durable store, memory is the fast cache.

**Capacity:** Cap at ~200 entries per session. Real-world sessions have 5-50 submissions; 200 provides generous headroom. Cross-session cleanup (removing sessions older than N days) is future work.

**PromptHistoryStore is L02-compliant.** Laws are laws, not suggestions. `subscribe` + `getSnapshot` are implemented even though the primary consumer (HistoryProvider) is imperative. The overhead is trivial (a Set + version counter), and when a React-rendered history browser arrives, the compliance is already there.

---

## Bridge Layer: Store → Provider

The gap between stores and the engine's provider interfaces is thin but important:

### Completion bridge

```typescript
// In tug-prompt-entry (T3.4), the wiring looks like:
const commandProvider = metadataStore.getCommandCompletionProvider();
const fileProvider = fileTreeStore.getFileCompletionProvider();

<TugPromptInput
  completionProviders={{
    "/": commandProvider,
    "@": fileProvider,
  }}
/>
```

The store produces a `CompletionProvider` function that the engine can call directly. No adapter needed — the types align.

### History bridge

```typescript
// In tug-prompt-entry (T3.4):
const sessionId = metadataStore.getSnapshot().sessionId;
const historyProvider = historyStore.createProvider(sessionId);

<TugPromptInput
  historyProvider={historyProvider}
/>

// On submit:
historyStore.push({
  id: crypto.randomUUID(),
  sessionId,
  projectPath: metadataStore.getSnapshot().cwd ?? "",
  route: currentRoute,
  text,
  atoms,
  timestamp: Date.now(),
});
```

The store produces a `HistoryProvider` scoped to the current session. The prompt entry creates it once when the session starts (from SessionMetadataStore). Cmd+Up/Down walks that session's submissions only.

---

## Implementation Steps

### Step 1: SessionMetadataStore

1. **Types** — `SessionMetadataSnapshot`, `SlashCommandInfo` (with `category: "local" | "agent" | "skill"`) in `tugdeck/src/lib/session-metadata-store.ts`
2. **Store class** — subscribes to FeedStore, parses `system_metadata`, merges `slash_commands` and `skills` into a single `slashCommands` array (skills get `category: "skill"`), notifies listeners
3. **Command completion provider** — `getCommandCompletionProvider()` returns a function that filters the merged slash commands by query
4. **Tests** — unit tests with mock FeedStore data
5. **Gallery integration** — wire the store (with mock data) into the prompt input gallery card, replacing the hardcoded `TYPEAHEAD_COMMANDS`

### Step 2: PromptHistoryStore

1. **Types** — `HistoryEntry`, `SerializedAtom`, `PromptHistorySnapshot` in a new `tugdeck/src/lib/prompt-history-store.ts`
2. **In-memory store** — push, createProvider(sessionId), L02 subscribe/getSnapshot
3. **Tugbank backing** — one key per sessionId, async fetch on first access, fire-and-forget PUT writes, capacity cap
4. **Tests** — unit tests for push/navigate (mock tugbank via fetch stub)
5. **Gallery integration** — wire into gallery card with a mock sessionId, replacing `GalleryHistoryProvider`

### Step 3: File completion provider (stub)

The `@` trigger's real data comes from a project file index — that's future work (not in T3.3). But we should establish the pattern:

1. **Create `tugdeck/src/lib/file-completion-provider.ts`** with a stub that returns hardcoded files (same as current gallery mock)
2. **Define the interface** that the real provider will implement when the project file index exists
3. This keeps the gallery card clean — it imports providers, doesn't define them inline

### Step 4: Live file completion provider

Replace the hardcoded `TYPEAHEAD_FILES` stub with live project files from a self-owned file index service in tugcast.

#### Design rationale

We own the file index ourselves rather than depending on Claude Code. Claude Code's file context is optimized for AI model needs, not human completion UX — its list may exclude files, change shape between versions, or lag behind actual filesystem state. We already have the building blocks: `cwd` from `system_metadata` gives the project root, the `notify` crate watches for changes, and the `ignore` crate handles `.gitignore`. We just need a service that walks the tree once and keeps the list current.

All three major editor frameworks (CodeMirror 6, ProseMirror, Lexical) use the same core pattern: the completion source is a **pull-based function** called synchronously on each keystroke, filtering a pre-populated list. None ship a file indexer — they expect the host to provide the file list. Our `CompletionProvider` already works this way. The missing piece is the data source.

#### Architecture: FileWatcher + two feeds

The current FILESYSTEM feed has two limitations that prevent FILETREE from simply subscribing to it: (1) it uses a `watch` channel (single-value, latest-wins), so a fast consumer can miss event batches; (2) its `.gitignore` handling only reads the root `.gitignore`, missing nested overrides.

Rather than duplicate the `notify` watcher, we fix this at the source. Extract the watcher into a shared **FileWatcher** service that both feeds consume:

```
notify watcher ──> FileWatcher (shared service)
                       │
                       ├── initial walk via ignore::WalkBuilder (nested .gitignore)
                       │
                       ├── broadcast::Sender<Vec<FsEvent>>  (guaranteed delivery to all subscribers)
                       │       │
                       │       ├── FILESYSTEM feed (0x10): forwards event batches as snapshots
                       │       │                           (existing wire format, unchanged)
                       │       │
                       │       └── FILETREE feed (0x11): maintains BTreeSet<String>,
                       │                                 emits complete file list snapshots
                       │                                 (ignores Modified — only Created/Removed/Renamed)
                       │
                       └── .gitignore: WalkBuilder-grade (nested, full spec, shared)
```

**Why `broadcast` instead of `watch`:** `tokio::sync::broadcast` guarantees every receiver sees every message (up to the buffer capacity). No dropped events. Both FILESYSTEM and FILETREE get every batch. This is the standard pattern for fan-out to multiple consumers with different processing needs.

**Why one watcher:** `notify` uses kernel-level facilities (FSEvents on macOS, inotify on Linux). One watcher per directory is the right number. Two watchers on the same tree would receive duplicate kernel events and double the syscall overhead for no benefit.

**Data flow to tugdeck:**

```
tugcast ──(FILETREE 0x11 snapshot)──> WebSocket ──> FeedStore
                                                          │
                                                  FileTreeStore <──┘
                                                         │
                                                         └── getFileCompletionProvider()
                                                               └── createFileCompletionProvider(files)
```

#### Payload format

```json
{
  "files": ["src/main.rs", "src/lib.rs", "Cargo.toml", ...],
  "root": "/Users/ken/project",
  "truncated": false
}
```

- `files`: flat array of relative paths (relative to `root`), files only (no directories), sorted lexicographically
- `root`: absolute path to the project root (same as tugcast's `--dir`)
- `truncated`: true if file count exceeded the cap and the list was clipped (safety valve for monorepos)

#### Implementation steps

**Step 4a: FileWatcher shared service (Rust)**

Extract the `notify` watcher and `.gitignore` handling from `filesystem.rs` into a new shared service:

1. Create `tugrust/crates/tugcast/src/feeds/file_watcher.rs`:
   - `FileWatcher` struct owns the `notify::RecommendedWatcher` and the `ignore::Gitignore` matcher
   - Constructor takes `watch_dir: PathBuf`
   - `walk(&self) -> BTreeSet<String>`: performs initial directory walk using `ignore::WalkBuilder`, returns sorted set of relative file paths (files only, respecting nested `.gitignore` at every level, skipping `.git/`). Cap at 50,000 entries.
   - `run(&self, tx: broadcast::Sender<Vec<FsEvent>>, cancel: CancellationToken)`: starts the `notify` watcher, debounces events (100ms), filters via `WalkBuilder`-grade gitignore, and broadcasts batches to all subscribers
   - Gitignore filtering uses the `ignore` crate's full nested support (replacing the root-only `build_gitignore` + `is_ignored` pattern currently in `filesystem.rs`)

2. Refactor `filesystem.rs`:
   - `FilesystemFeed` no longer owns the watcher or gitignore logic
   - Constructor takes a `broadcast::Receiver<Vec<FsEvent>>` from FileWatcher
   - `run()` simply receives event batches from the broadcast channel and forwards them as `watch::Sender<Frame>` snapshots (same wire format, same FeedId, same behavior from the client's perspective)
   - All existing FILESYSTEM tests and consumers are unaffected

**Step 4b: FILETREE feed in tugcast (Rust)**

1. Add `FeedId::FILETREE = 0x11` to `tugcast-core/src/protocol.rs`
2. Add `FileTreeSnapshot` type to `tugcast-core/src/types.rs`:
   ```rust
   #[derive(Serialize, Deserialize)]
   pub struct FileTreeSnapshot {
       pub files: Vec<String>,
       pub root: String,
       pub truncated: bool,
   }
   ```
3. Create `tugrust/crates/tugcast/src/feeds/filetree.rs`:
   - `FileTreeFeed` implements `SnapshotFeed`
   - Constructor takes `watch_dir: PathBuf`, initial `BTreeSet<String>` (from `FileWatcher::walk()`), and `broadcast::Receiver<Vec<FsEvent>>` (from FileWatcher)
   - On `run()`:
     - Send initial snapshot immediately (the walk is already done)
     - Loop on `broadcast::Receiver::recv()` — guaranteed to see every event batch
     - For each batch: apply only Created/Removed/Renamed to the BTreeSet. **Ignore Modified events** — they don't change the file list, just contents
     - After applying changes, if the set actually changed, serialize and send updated snapshot
     - Debounce: 200ms window after receiving events before sending snapshot (batches rapid sequences like `git checkout`)
4. Register in `main.rs`:
   - Create FileWatcher, call `walk()` for initial file set
   - Create `broadcast::channel` for events (buffer capacity ~256)
   - Pass `broadcast::Receiver` clones to both FilesystemFeed and FileTreeFeed
   - Spawn FileWatcher's `run()` task
   - Register FILETREE snapshot watch alongside FILESYSTEM
   - Spawn both feed tasks

**Step 4c: FileTreeStore in tugdeck (TypeScript)**

1. Add `FILETREE: 0x11` to `FeedId` in `tugdeck/src/protocol.ts`
2. Create `tugdeck/src/lib/filetree-store.ts`:
   - `FileTreeStore` class — L02-compliant `subscribe`/`getSnapshot`
   - Constructor takes `FeedStore` and subscribes to `FeedId.FILETREE`
   - On snapshot update: parse JSON payload, store `files` array
   - `getFileCompletionProvider(): CompletionProvider` — calls `createFileCompletionProvider(this._snapshot.files)`
   - `FileTreeSnapshot` interface: `{ files: string[], root: string, truncated: boolean }`
   - `dispose()` to unsubscribe
3. Tests in `tugdeck/src/__tests__/filetree-store.test.ts`:
   - Mock FeedStore with FILETREE payload → verify files parsed correctly
   - `getFileCompletionProvider()` filters by substring query
   - Snapshot updates when new FILETREE frame arrives
   - Empty/truncated snapshots handled gracefully

**Step 4d: Gallery card integration**

1. In `gallery-prompt-input.tsx`:
   - Import `FileTreeStore`
   - When live connection available: create `FeedStore` with `[FeedId.FILETREE]` (or add to existing FeedStore's feed list), create `FileTreeStore`, use `fileTreeStore.getFileCompletionProvider()` for `@` trigger
   - When offline: fall back to `createFileCompletionProvider(TYPEAHEAD_FILES)` as today
   - Remove direct dependency on `TYPEAHEAD_FILES` in the live path
2. `file-completion-provider.ts`: No changes needed — `createFileCompletionProvider(files)` already accepts any `string[]`

#### Scale considerations

- **Walk performance**: `ignore::WalkBuilder` is fast — walks 100k files in ~50ms on SSD. The initial snapshot is ready before any WebSocket client connects.
- **Filter performance**: `Array.filter` on 10k short strings is <1ms in V8. The 8-result cap means early bail is possible but not necessary at this scale.
- **Snapshot size**: 10k file paths at ~40 bytes average = ~400KB JSON. Acceptable for a one-time snapshot + rare updates. If this becomes a problem, switch to delta encoding (but measure first).
- **50k cap**: Safety valve for monorepos. If `truncated: true`, the UI could show a "(showing first 50,000 files)" hint. In practice, `.gitignore` filters out `node_modules`, `target/`, etc., so most projects are well under this.
- **BTreeSet for the index**: Sorted insertion/removal is O(log n), and iteration produces a sorted `files` array without a separate sort step.
- **Broadcast buffer**: 256 slots is generous — each slot holds one debounced batch. If a consumer falls behind by 256 batches (unlikely at 100ms debounce = 25+ seconds of sustained activity without processing), it receives a `Lagged` error and can re-walk to recover.
- **Modified events skipped**: File saves don't change the file list. Without this filter, every file save would trigger a full snapshot resend for no reason.

#### Gitignore handling

The `ignore` crate's `WalkBuilder` handles `.gitignore` at every directory level, respects nested overrides, and skips `.git/`. The current `filesystem.rs` only reads the root `.gitignore` — a known limitation. By extracting the watcher into FileWatcher and using `WalkBuilder`-grade filtering throughout, both FILESYSTEM and FILETREE get correct nested gitignore support. This is a net improvement for FILESYSTEM consumers too.

**Gitignore rebuild on change:** When FileWatcher sees a `.gitignore` Created or Modified event, it rebuilds its gitignore matcher by re-reading all `.gitignore` files in the tree. This ensures that newly added or updated ignore rules take effect immediately for subsequent events. The rebuild is cheap (reading a few small text files) and `.gitignore` changes are infrequent.

#### Decisions

1. **Shared FileWatcher, not duplicate watchers.** One `notify` watcher per directory tree. Fan out to multiple consumers via `broadcast`. No duplicated kernel events, no duplicated gitignore logic.
2. **`broadcast` channel, not `watch`.** `watch` is single-value (latest-wins) — fine for a single consumer, but drops intermediate values when multiple consumers read at different rates. `broadcast` guarantees delivery to every subscriber. Both feeds see every event batch.
3. **Separate FILETREE feed (0x11), not an extension of FILESYSTEM.** FILESYSTEM emits change events (Created/Modified/Removed). FILETREE emits complete file list snapshots. Different semantics, different consumers. Mixing them complicates both.
4. **SnapshotFeed for FILETREE, not StreamFeed.** New clients need the full file list immediately. SnapshotFeed delivers the latest value on connect — exactly right.
5. **FileTreeStore, not SessionMetadataStore.** The file list comes from tugcast (our service), not from Claude Code's `system_metadata`. Different source, different lifecycle.
6. **Paths are relative to root.** Shorter, cleaner for display. The `root` field in the snapshot lets consumers resolve to absolute paths when needed (e.g., for file content reads at submit time).
7. **The full feed is always published.** FILETREE sends all non-ignored files. Client-side filtering (by extension, directory, recency, etc.) is the consumer's responsibility — the feed does not pre-filter for any particular use case.
8. **Refactor FILESYSTEM, don't preserve its internals.** Very little depends on FILESYSTEM's internal implementation — only its wire format matters. Clients see the same FeedId, same JSON payload, same behavior. The refactor to use FileWatcher is invisible to consumers.

#### Follow-on: completion matching algorithm

All completion providers currently use case-insensitive substring match (`String.includes()`). This is adequate for small lists but becomes a liability with thousands of project files — `@main` matches `domain/container/main.rs` equally with `src/main.rs`. Once the FILETREE feed is operational and provides real file lists, the matching algorithm should be revisited. Likely candidates: prefix-weighted scoring, path-segment-aware matching (prioritize filename over directory), or fuzzy matching (non-contiguous character sequences like `sms` → `session-metadata-store.ts`). This is follow-on work — get the data pipeline right first, then tune the ranking.

---

## Laws Compliance

| Law | How |
|-----|-----|
| L02 | All three stores (SessionMetadataStore, PromptHistoryStore, FileTreeStore): `subscribe` + `getSnapshot` for `useSyncExternalStore` |
| L06 | Completion/history providers drive direct DOM updates via the engine — no React re-renders |
| L07 | Providers are stable refs — created once per scope, not recreated on every render |
| L22 | SessionMetadataStore and FileTreeStore observed by engine callbacks, not round-tripped through React |
| L23 | PromptHistoryStore persists to tugbank — survives reload, quit |

---

## Exit Criteria

**Steps 1–3 (implemented):**
- SessionMetadataStore parses `system_metadata` from a FeedStore (tested with mock data)
- `getCommandCompletionProvider()` returns a working CompletionProvider filtering merged slash commands + skills
- PromptHistoryStore push/navigate works with session-scoped in-memory data
- Tugbank persistence: session entries survive page reload
- Entry schema includes sessionId, projectPath, route — ready for future search tiers
- All three stores have unit tests
- Gallery card uses real store instances (with mock feed data) instead of inline mocks
- Existing tug-prompt-input features unaffected

**Step 4 (planned):**
- FileWatcher shared service: single `notify` watcher with `WalkBuilder`-grade nested gitignore, broadcast to multiple consumers
- FILESYSTEM feed refactored to consume FileWatcher broadcast (wire format unchanged, existing consumers unaffected)
- FILETREE feed (0x11): sends complete file list snapshot on connect and on file creates/removes/renames
- FileTreeStore in tugdeck: L02-compliant, exposes `getFileCompletionProvider()`
- Gallery card `@` trigger shows live project files when connected
- `cd tugrust && cargo nextest run` passes (FileWatcher + FILETREE unit/integration tests)
- `cd tugdeck && bun test` passes (FileTreeStore unit tests)

---

## Decisions (resolved)

1. **Slash command shape** — strict types (`{ name, description?, category }`), parsed defensively. Skills merged into the same array with `category: "skill"`. Completion is a closed set — always completes to known commands.
2. **History includes atoms** — yes. Atoms are promises; resolution is at submit time. Full state stored (minus selection).
3. **PromptHistoryStore L02** — yes. Laws are laws. Both stores implement `subscribe`/`getSnapshot`.
4. **History tiers** — navigation is session-scoped (Cmd+Up/Down walks current session only). Storage schema includes sessionId + projectPath + route to support future per-project and global search. Search UI is T3.4+.
5. **Persistence** — tugbank, not IndexedDB. One key per sessionId. Consistent with all other persistence in the system.
