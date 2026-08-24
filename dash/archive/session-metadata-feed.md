# Session Metadata Feed

**Status:** Proposed  
**Depends on:** tugcast feed infrastructure, tugcode IPC  
**Relates to:** T3.3 (SessionMetadataStore), Dev roadmap

## Problem

Session metadata (slash commands, skills, model, cwd, permission mode) is emitted once by tugcode as a `system_metadata` JSON event on the `CODE_OUTPUT` stream (feed 0x40). This is a multiplexed stream carrying all Claude Code output — text chunks, tool calls, status events, and metadata.

The `CODE_OUTPUT` stream uses a replay buffer (1000 frames) for lag recovery. However, `system_metadata` is typically frame #1 or #2 in the session. By the time a card mounts and subscribes, hundreds of subsequent frames have pushed it out of the replay buffer. The client-side `lastPayload` cache only stores the single most recent frame per feed ID, so `system_metadata` is overwritten immediately by the next `CODE_OUTPUT` frame.

**Result:** `SessionMetadataStore` never receives data. Slash command and skill completions do not work. The gallery card previously masked this with hardcoded mock data.

## Solution: Dedicated Snapshot Feed

Add `SESSION_METADATA` (feed ID `0x51`) as a snapshot feed in tugcast. This follows the same pattern as `FILESYSTEM` (0x10), `GIT` (0x20), and `DEFAULTS` (0x50) — all of which use `tokio::sync::watch` channels that deliver current state to late subscribers.

### Feed ID

```
0x51  SESSION_METADATA
```

This sits in the 0x50 band alongside `DEFAULTS` (0x50), forming a "session state" group.

### Architecture

```
tugcode (claude stdout)
  │
  ├─ system_metadata JSON line ──► CODE_OUTPUT broadcast (0x40) [unchanged]
  │
  └─ same frame also parsed by ──► SessionMetadataFeed
                                      │
                                      ▼
                                   watch::channel ──► SESSION_METADATA (0x51)
                                                        │
                                                        ▼
                                                     client connects
                                                        │
                                                     borrow_and_update()
                                                        │
                                                     instant snapshot ✓
```

### Tugcast Changes

**New file: `tugrust/crates/tugcast/src/feeds/session_metadata.rs`**

A task that subscribes to the `CODE_OUTPUT` broadcast, filters for `system_metadata` events, and publishes the latest one on a `watch::channel`.

```rust
pub struct SessionMetadataFeed {
    code_rx: broadcast::Receiver<Frame>,
}

impl SessionMetadataFeed {
    pub fn new(code_rx: broadcast::Receiver<Frame>) -> Self {
        Self { code_rx }
    }

    pub async fn run(mut self, tx: watch::Sender<Frame>, cancel: CancellationToken) {
        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                result = self.code_rx.recv() => {
                    match result {
                        Ok(frame) => {
                            if Self::is_system_metadata(&frame) {
                                // Re-wrap payload under SESSION_METADATA feed ID
                                let meta_frame = Frame::new(
                                    FeedId::SESSION_METADATA,
                                    frame.payload().to_vec(),
                                );
                                let _ = tx.send(meta_frame);
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
        }
    }

    fn is_system_metadata(frame: &Frame) -> bool {
        // Quick check: look for "system_metadata" in payload bytes
        // without full JSON parse for performance.
        let payload = frame.payload();
        let needle = b"\"type\":\"system_metadata\"";
        payload.windows(needle.len()).any(|w| w == needle)
    }
}
```

**Registration in `main.rs`:**

```rust
// Session metadata snapshot — filters system_metadata from CODE_OUTPUT.
let (session_meta_tx, session_meta_rx) = watch::channel(
    Frame::new(FeedId::SESSION_METADATA, vec![])
);
let session_meta_feed = SessionMetadataFeed::new(code_tx.subscribe());
tokio::spawn(async move {
    session_meta_feed.run(session_meta_tx, cancel.clone()).await;
});
// Add to snapshot watches so clients receive it on connect.
snapshot_watches.push(session_meta_rx);
```

**Feed ID constant in `tugcast-core`:**

```rust
pub const SESSION_METADATA: u8 = 0x51;
```

### Frontend Changes

**`tugdeck/src/protocol.ts`:**

```typescript
SESSION_METADATA: 0x51,
```

**`tugdeck/src/lib/session-metadata-store.ts`:**

Change the constructor to subscribe to `SESSION_METADATA` instead of `CODE_OUTPUT`:

```typescript
// Before:
const feedStore = new FeedStore(connection, [FeedId.CODE_OUTPUT]);
const store = new SessionMetadataStore(feedStore, FeedId.CODE_OUTPUT);

// After:
const feedStore = new FeedStore(connection, [FeedId.SESSION_METADATA]);
const store = new SessionMetadataStore(feedStore, FeedId.SESSION_METADATA);
```

The `SessionMetadataStore._onFeedUpdate` parsing logic is unchanged — it already looks for `type: "system_metadata"` in the payload.

**Card-level construction** (gallery-prompt-input.tsx and future cards):

```typescript
function buildCardStores() {
  const connection = getConnection()!;
  // SESSION_METADATA is a snapshot feed — late subscribers get current state.
  const metaFeedStore = new FeedStore(connection, [FeedId.SESSION_METADATA]);
  const metadataStore = new SessionMetadataStore(metaFeedStore, FeedId.SESSION_METADATA);
  // ...
}
```

Because `SESSION_METADATA` is a snapshot feed, `connection.onFrame()` replays the cached payload to late subscribers. The `FeedStore` receives it immediately, `SessionMetadataStore` parses it in the constructor, and slash commands are available before the first render.

### Tugcode Changes

Tugcode currently emits `system_metadata` once at session init. It must also re-emit whenever metadata changes mid-session — new skills loaded, permission mode changed, MCP servers added, etc. The `SessionMetadataFeed` picks up every emission and updates the watch channel. All connected clients receive the update immediately. `SessionMetadataStore` already handles replacement — it overwrites `_snapshot` on each new payload.

Changes needed in `tugcode/src/session.ts`:
- Track the current metadata state.
- On events that change metadata (skill registration, permission change, MCP server connect/disconnect), re-emit `system_metadata` with the updated state.
- The emission format is identical to the initial emit — a full snapshot, not a delta.

### Testing

- **Unit test:** `SessionMetadataFeed.is_system_metadata` correctly identifies system_metadata frames and rejects others.
- **Integration test:** Start tugcast with a mock tugcode that emits system_metadata. Connect a client late. Verify the client receives the metadata snapshot on connect.
- **Frontend test:** Verify `SessionMetadataStore` receives data from `SESSION_METADATA` feed and populates slash commands.

### Migration

1. Add `SESSION_METADATA` feed ID to tugcast-core and protocol.ts.
2. Add `SessionMetadataFeed` to tugcast, register in main.rs.
3. Update `SessionMetadataStore` consumers to use `FeedId.SESSION_METADATA`.
4. Remove mock slash command fallbacks.
5. The `system_metadata` event continues to flow on `CODE_OUTPUT` for backward compatibility — other consumers (logging, debugging) may still read it there.
