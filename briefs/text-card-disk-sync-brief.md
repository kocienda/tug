<!-- brief-skeleton v1 -->

# Text card disk sync: never stale, never jumps

**Purpose:** When a file open in a Text card changes on disk, the card sometimes reloads late (at the moment of the next click), sometimes never reloads at all, and until `dc6908ba0` visibly jumped when it did. The bar is BBEdit: a clean buffer tracks the disk silently and the reader's place never moves.

---

## Purpose {#purpose}

The report, in the user's words:

> When the file content of a text card is edited underneath on disk, the in-card behavior *really works poorly*. It seems to jump around sometimes when the content is reloaded at the moment I first interact after the silent background reload. Sometimes this reload doesn't work at all, and I'm left with a dangling file. Now, an app like BBEdit handles this *amazingly well*. […] We really need to do better at this.

Three distinct failures are in that report: the view **jumps** on reload; the reload lands **late**, on the first interaction rather than when the file changed; and the reload is sometimes **missed** entirely, leaving a stale buffer. The first is fixed and landed. The second and third are one structural problem in how change events reach the card, and they are what this brief is for. A Tug session makes this worse than it is in an ordinary editor: an agent is rewriting the files the user has open, continuously, so the external-change path is the common path here and not the rare one.

---

## Evidence {#evidence}

**[F01] The jump was a whole-document replace, and it is fixed.** `replaceText` in `tugdeck/src/components/tugways/tug-text-card-editor.tsx` dispatched `{from: 0, to: doc.length, insert: next}` and then restored selection from line/ch and scroll from a pixel `scrollTop`. Both guesses are wrong whenever a line is added or removed above the viewport. `dc6908ba0` replaced it with a minimal change set from the new `tugdeck/src/lib/minimal-text-changes.ts` (Myers line diff, per-hunk character tightening, surrogate-safe, bounded by `MAX_EDIT_DISTANCE`), letting CM6 map the selection, keep measured heights, and hold its own scroll anchor. `at0209` scenario 3 now asserts the text at the viewport top is unchanged within 2px; a reverse `tugtool file probe` with the old dispatch turned it red ("tall line 045" → "044"). **(verified)**

**[F02] Only the bootstrap workspace's FILESYSTEM events ever reach a client.** `tugrust/crates/tugcast/src/main.rs:1926` registers `bootstrap.fs_watch_rx` with the router; every other `WorkspaceEntry` builds an `fs_watch_rx` (`feeds/workspace_registry.rs:228`) that nothing reads. A card on a file in any other workspace, or outside every workspace, gets no events. **(verified by reading the code; not reproduced in the running app)**

**[F03] For those files the only reload trigger is activation, which is why the reload lands on the first click.** `text-card.tsx` calls `store.recheckOnActivation()` from `onCardActivated` and on `visibilitychange`; its own comment says files outside the watcher's roots "get no FILESYSTEM events, so activation is when an external change is caught". Combined with [F01]'s old behaviour, this is the reported "jumps at the moment I first interact". **(verified)**

**[F04] FILESYSTEM is an event stream carried on a latest-value channel, so batches can be lost.** `FilesystemFeed` is a `SnapshotFeed` sending each batch into a `tokio::sync::watch` (`feeds/filesystem.rs`). The router forwards with `watch_rx.changed()` → `borrow_and_update()` into a bounded `mpsc(16)` shared by every snapshot feed (`router.rs:1117-1144`). Two batches sent between forwarder wakeups coalesce to the second; the first is gone. The loss is by construction; how often it happens in practice was not measured. **(verified by reading the code; frequency is inference)**

**[F05] Nothing recovers from a lost batch.** `RecvError::Lagged` in `filesystem.rs` is logged and skipped. The client has no sequence number to notice a gap and no re-verification on WebSocket reconnect. A missed event stays missed until the next activation recheck. **(verified)**

**[F06] The watcher forwards events unfiltered by gitignore.** `file_watcher.rs` says so in its module doc; `target/`, `node_modules/`, and `.git/` churn all ride the same batches, which raises the batch rate that [F04] needs in order to lose one. **(verified; the contribution to real-world loss is inference)**

**[F07] The store already has the right adjudication, and it is sound.** `text-card-store.ts` conditions every real-file write on a baseline sha256, reads carry `(dev, ino)`, an absent path descends one ladder (`_classifyAbsentPath`: replace-in-place → paired rename → `MISSING_SETTLE_MS` settle → verdict), a clean buffer adopts disk silently, and a dirty buffer never does. This matches the universal rule in every editor surveyed. **(verified)**

**[F08] Self-write echo suppression is a state window, not a hash.** `_onFilesystemFrame` defers any frame that arrives while `saveState === "writing"` and rechecks on settle. An echo that arrives after the write settles is handled only because the recheck finds the hash equal to the baseline; an external write that lands inside the window is deferred, not lost. It works, but the correctness lives in the hash compare, and the window is redundant with it. **(verified)**

**[F09] A dirty automatic-mode buffer ignores an external change until its own next write 409s.** The `saveState === "editing"` branch of `_onFilesystemFrame` returns without reading for automatic mode. The user learns of the divergence only as a conflict banner after their next flush. **(verified)**

**[F10] A reload is an ordinary undoable transaction.** `replaceText` carries the `externalReplace` annotation (so it does not arm autosave) but not `Transaction.addToHistory.of(false)`. ⌘Z after a reload restores the pre-reload text as a user edit; in automatic mode autosave then writes those bytes over the external change. `history()` is used with defaults (`tug-text-card-editor.tsx:916`), so typing coalesces into runs under `newGroupDelay` = 500 ms. **(verified by reading; the ⌘Z-overwrites-disk consequence was reasoned, not reproduced)**

**[F11] A read can be torn.** `readFileFromDisk` trusts a single read. A non-atomic writer truncates then writes, so a read between the two returns empty or short content, which a clean buffer would adopt. VS Code shipped this as issue #138850. **(inference from the code path; not reproduced here)**

**[F12] The file watcher drains its channel on a timer.** `run_armed` loops `try_recv` with a 50 ms sleep when idle (`POLL_MILLIS`), plus a 100 ms debounce. **(verified)**

**[F13] What the best editors do.** From a web survey (sources in the session transcript; items read from source are marked):
- VS Code: never reloads a dirty model; per-file `ResourceQueue` of one running + one pending resolve so the trailing reload is never dropped; etag (mtime+size) as a re-read trigger; `versionId` guard abandons a reload the user typed under; `_computeEdits` applies prefix/suffix-trimmed edits rather than `setValue`; orphaning is delayed and re-checked. **(read from source by the research agent)**
- Zed: reload is a line diff (then word diff inside hunks) applied as edits "to preserve the positions of cursors"; character diff was abandoned for hanging on large files; dirty buffers are never reloaded. **(read from PR #25129)**
- Emacs: `replace-buffer-contents` does a minimal-diff replace under a `max-secs` budget with a wholesale fallback. **(read from the manual)**
- BBEdit: silent reload of clean documents, alert on dirty ones, scroll preserved since 9.5 and selection since 12.1 per release notes. The detection mechanism is undocumented; one forum user says modification-date compare, and the same thread shows mtime-only false positives on network volumes. **(release notes read; mechanism unconfirmed)**
- JetBrains, BBEdit, Neovim all re-verify on focus as a backstop for missed events. JetBrains' long-running "File Cache Conflict" complaints are a failure to tell its own writes from external ones.
- Atomic saves (temp + `rename`) replace the inode, so a per-fd vnode watch goes deaf after the first save; watching the parent directory, or FSEvents by path, survives. FSEvents flags are OR-coalesced per path, so event *kind* is not trustworthy.

---

## Decisions {#decisions}

**[B01] A Text card subscribes to its own file; it does not listen to a workspace.** On bind, the card asks tugcast to watch its canonical path, and tugcast answers for any path — in a workspace, in another workspace, or in none. This removes [F02] and [F03] at the root rather than forwarding more workspaces: forwarding every workspace's firehose would fix other-workspace files and still leave out-of-workspace files reloading on click. The subscription is released on rebind and on `dispose()`. Rename-follow and the absent-path ladder ([F07]) keep working; they currently read sibling `Created` events out of workspace batches, so the per-file stream must carry enough for them (the parent directory's creations in the same batch), or the ladder keeps reading the workspace feed for that one purpose.

**[B02] tugcast watches the file's parent directory, non-recursively, and treats every event kind as "look again".** The parent-directory watch survives atomic-rename saves and costs one watch per distinct directory, shared across cards. Event kind is never switched on for the changed/unchanged question ([F13]: FSEvents coalesces flags); any event naming the path means stat and re-read.

**[B03] Per-file change events ride a lossless stream, versioned, never a latest-value channel.** They go out on a broadcast sender registered like `ft_response_tx`, carrying `{path, sha256, seq}` with `seq` monotonic per path. The client drops a `seq` not newer than the last it applied. An event stream on `watch` is the defect in [F04]; this decision is that the new stream does not repeat it. Whether the existing workspace FILESYSTEM feed also moves off `watch` is the first open question.

**[B04] Every gap heals itself by re-asking.** On `Lagged`, on WebSocket reconnect, on card show, and on window focus, the client asks "what is the current hash for this path?" and reloads a clean buffer if it differs from the baseline. `recheckOnActivation` stays, demoted from the only trigger to a backstop. A missed push then costs a delay, never a permanently stale buffer ([F05]).

**[B05] The content hash is identity; mtime, size, and inode are only reasons to look.** This is already true for writes ([F07]) and becomes true for echoes: a change event whose hash equals the baseline is a no-op, which is the whole of self-write suppression. The `saveState === "writing"` deferral ([F08]) stays only if something other than echo suppression still needs it; time and state windows are not how Tug tells its own writes from someone else's.

**[B06] Reads are coalesced per file as one running plus one pending, and the trailing read always runs.** A burst of events during a read queues exactly one more read. A pure trailing debounce can starve under continuous writes, and dropping the last read is the classic cause of "stale forever".

**[B07] A suspicious read is confirmed before it is believed.** tugcast stats before and after the read and retries when they differ; an empty or sharply shorter result following a plain modify (not a rename) gets one confirming re-read after a short settle before it is reported ([F11]). An atomic-rename save cannot tear, so a new inode with a stable stat is reported immediately.

**[B08] A dirty buffer is never reloaded silently, and the first answer to divergence is a three-way merge.** Base is the baseline text, ours is the buffer, theirs is the disk. A clean merge is applied through `minimalTextChanges`, the buffer stays dirty, the baseline moves to the disk hash, and nothing is asked. Only a true overlap raises the existing conflict surface (non-modal banner in automatic, sheet in manual), which gains a way to see the difference. This is what makes Tug better than BBEdit's alert rather than equal to it, and it matters more here than elsewhere because an agent edits the open file while the user is typing in it. It requires retaining the baseline text, not just its hash.

**[B09] Automatic mode learns of divergence when it happens, not at its next write.** The `editing` branch reads disk on an event for its path and runs [B08]'s merge, instead of returning and waiting for a 409 ([F09]).

**[B10] A reload never enters the undo history.** `replaceText` adds `Transaction.addToHistory.of(false)`. CM6 still maps the existing undo stack through the change, so ⌘Z keeps undoing the user's own edits against the new text, and ⌘Z can never turn the disk's content into a dirty buffer that automatic mode then writes over someone else's change ([F10]). VS Code's alternative (the reload as one isolated undo step) was considered and rejected for that overwrite. This applies to every caller of `replaceText`, including Revert and Reload from Disk.

**[B11] "Undo typing" is untouched, and a test says so.** Typing coalescing is `history()`'s `newGroupDelay` behaviour and neither undo policy affects it ([F10]). A silent reload cannot split a typing run: manual mode reloads only a clean buffer, and automatic mode goes clean only after the 1000 ms autosave idle, which outlasts the 500 ms group window. The arc adds a test that types a run, reloads, and asserts one ⌘Z removes the whole run — so the property is pinned rather than assumed.

**[B12] The minimal-diff reload is the only way text enters a mounted editor from outside.** `dc6908ba0` made `replaceText` the single door; nothing in this arc reintroduces a whole-document dispatch, including the merge in [B08].

**[B13] The watcher's 50 ms `try_recv` poll loop goes.** `notify`'s std channel is drained by a blocking receive on its own thread (or bridged to a tokio channel at the source), so an idle watcher does nothing ([F12]). The debounce that batches a burst stays; the idle timer does not. This is the standing no-polling rule applied to a file the arc is already in.

---

## Open Questions {#open-questions}

- **Does the workspace FILESYSTEM feed also move off `watch`?** [B03] fixes the Text card by giving it its own stream. The path resolver and any other FILESYSTEM consumer still sit on the lossy channel ([F04]). Moving the feed to a broadcast sender is mechanically small but changes connect-time behaviour (no retained last frame) and touches `subscribe_feeds` / `retained_watches`. Settled by reading what each consumer does with a missed batch; if any of them can go wrong, it moves in this arc.
- **Where does the three-way merge run, and with what?** `diff-match-patch` is already a tugdeck dependency (lazy-loaded to stay out of the boot bundle) and has `patch_apply`, which is fuzzy rather than a true diff3. A line-based diff3 built on the Myers diff already in `minimal-text-changes.ts` is small and exact. The choice changes what "clean merge" means, so it should be made deliberately, with a few adversarial fixtures (both sides edit adjacent lines; both append at EOF; one side reformats the whole file).
- **What does the conflict surface show when the merge fails?** A Diff button is decided ([B08]); what it opens — the existing diff card against a temp of the buffer, or an in-card view — is a product call.
- **Should the gitignore filter move into the watcher for FILESYSTEM consumers?** [F06] is noise that every consumer pays for. FileTreeFeed wants unfiltered events to reconcile `.gitignore` changes, so the filter cannot simply be applied at the source for everyone.

---

## Non-goals {#non-goals}

- **Forwarding every workspace's FILESYSTEM feed to every client as the fix.** It repairs other-workspace files and leaves out-of-workspace files reloading on click; [B01] covers both with less traffic.
- **A per-fd vnode / kqueue watch on the file itself.** It goes deaf on the first atomic save ([F13]). Rejected in favour of the parent-directory watch.
- **mtime as the changed/unchanged test.** False positives on network volumes and coarse filesystems, false negatives on a same-second write. It is a trigger only ([B05]).
- **Time-window self-write suppression** ("ignore events for N ms after a save"). It both hides real external writes and leaks echoes ([B05]).
- **A timer that re-stats open files.** Emacs falls back to 5-second polling where notifications fail; Tug does not. The backstops in [B04] are events (focus, show, reconnect, lag), not a clock.
- **The reload as an undoable step.** Considered (VS Code's policy) and rejected in [B10].
- **Character-level diffing of whole files.** Zed abandoned it for hanging on large files; the line diff with per-hunk tightening is already landed and bounded.
- **Changing the save modes, the aside record, or the missing-file ladder.** They are sound ([F07]); this arc changes how the store *hears* about the disk and what it does with a dirty divergence, not how it saves.
- **Other cards that show files** (file-view, diff, image). They may want the same subscription later; this arc builds it for the Text card and keeps the wire general enough not to preclude them.

---

## Exit {#exit}

**An arc.** The work spans `tugrust/crates/tugcast` (per-file watch, lossless stream, guarded read, the poll loop), `tugproto`/the protocol feed ids, and `tugdeck/src/lib/text-card-store.ts` plus the editor bridge. A shape it could take, with the ordering that matters:

1. The two editor-only changes first, because they are independent and small: `addToHistory.of(false)` on `replaceText` with the typing-run ⌘Z test ([B10], [B11]).
2. The tugcast side of the per-file watch: subscribe/unsubscribe message, parent-directory watch shared per directory, stat-guarded read, `{path, sha256, seq}` on a broadcast sender, a "current hash for path" query ([B01]–[B03], [B07]). Rust tests can drive atomic-rename saves, truncate-then-write, delete-then-recreate, and a burst.
3. The store switches its trigger: subscribe on bind, release on rebind/dispose, per-file read queue with a guaranteed trailing read, hash-equals-baseline as the no-op, and the re-ask on lag / reconnect / show / focus ([B04]–[B06]). The rename ladder must still pass its existing tests here — this is the step where [B01]'s caveat about sibling `Created` events is settled.
4. Retained baseline text and the three-way merge for dirty buffers in both modes, with the automatic-mode branch reading on the event ([B08], [B09]).
5. The poll loop ([B13]), and the FILESYSTEM-off-`watch` question if it resolves to "move it".

An app-test should pin the headline behaviours from outside: a file **outside every workspace** reloads with no interaction; the text at the viewport top holds; a burst of external writes ends with the buffer equal to the last write; and an agent-style edit to a different region of a dirty buffer merges without a prompt. Per the standing lesson, each motion assertion gets a reverse-diff `file probe` to prove it can go red.
