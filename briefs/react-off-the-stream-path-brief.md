<!-- brief-skeleton v1 -->

# React off the stream path

**Purpose:** Every streamed token costs React a whole-card re-render: the session card body, the prompt entry, the telemetry rows and the list view, plus the Overview's rows and every session masthead on every current-line frame. Streaming text is already painted imperatively. This stage makes React hear only structural change, so a token costs React nothing.

Stage 2 of `briefs/main-thread-headroom-program-brief.md`; builds on stage 1's streaming reading.

---

## Purpose {#purpose}

The user's goal is full frame rates no matter what work the app is doing. The work the app is doing, when it is doing a lot, is streaming. React is the largest script cost per streamed frame that is not the parse, and most of what it re-renders does not change when a token arrives.

---

## Evidence {#evidence}

**[F01] Streaming text already bypasses React.** The reducer emits `write-inflight` with the accumulated text (`tugdeck/src/lib/code-session-store/reducer.ts:2456`), the store writes it to a `PropertyStore` (`code-session-store.ts:2827`), and `TugMarkdownBlock` observes the path and reconciles DOM directly (`tug-markdown-block.tsx:381`). No React render is needed for the text to appear. **(verified, read from the code)**

**[F02] Every publish still re-renders the whole-snapshot subscribers.** `getSnapshot` returns a new object per publish (`code-session-store.ts:797`). Whole-snapshot subscribers include `SessionCardBody` (`session-card.tsx:2204`, a component of about 3,800 lines), `SessionTranscriptHost` (`session-card-transcript.tsx:2757`), `TugPromptEntry` (`tug-prompt-entry.tsx:1182`), four telemetry renderers (`session-card-telemetry-renderers.tsx:363`, `:413`, `:444`, `:1136`), `useTaskListState`, and `TugListView`, whose version is the snapshot (`tug-list-view.tsx:2630`). About 63 selector subscriptions exist across 23 files. **(verified, read from the code; the per-publish React cost is not measured)**

**[F03] `TugListView` rebuilds a wrapper per row on every render.** Rows themselves are `React.memo` (`session-card-transcript.tsx:460`, `:686`, `:798`, `:1018`, `:1675`), but the list rebuilds every row's wrapper div (`tug-list-view.tsx` near `:7679`), so reconciliation is O(rows) per publish even when no row changed. **(verified, read from the code)**

**[F04] The Overview re-renders everything on every current-line frame.** Each per-session current-line frame on the OVERVIEW feed calls `commit()`, which copies the posts array into a fresh snapshot (`tugdeck/src/lib/overview-store.ts:416`, `:552`). `OverviewPostRow` is not memoized and up to `OVERVIEW_MAX_ROWS = 150` are mapped per render (`overview-card.tsx:1300`, `:783`). `useOverview`'s inline subscribe lambda is a new function per render. **(verified, read from the code)**

**[F05] Every session masthead subscribes to the whole Overview.** `SessionIdentityRow` (`tugdeck/src/components/tugways/session-identity-row.tsx:1016`) uses `useOverview()`, so every session's current-line frame re-renders every session masthead and every Cards-card row. **(verified, read from the code)**

**[F06] React's own concurrency cannot be used to demote these.** `useSyncExternalStore` updates always run in the synchronous lane; the header of `gesture-scope.ts` records this as the reason the deck holds tells rather than using transitions. `startTransition` is used once (`lib/use-after-motion.ts:42`). So the route to a cheaper streaming commit is not a lower lane; it is no commit. **(verified, read from the code)**

**[F07] The planning commit of a gesture is mostly pane chrome, and the same chrome re-renders on streaming.** `briefs/set-up-and-go-motion-brief.md` [F04]: `Presence`, `Popper`, `TugButton2`, `TugEditorContextMenu`, `TugSlot2` dominate the fiber list. A session card body that re-renders per token carries that chrome with it unless the chrome is memoized against it. **(verified for the fiber mix; the streaming share is inference)**

---

## Decisions {#decisions}

**[B01] The session store publishes two things, and streaming is not one of them.** A structural snapshot changes on a new turn, a phase change, a tool call or result, an error, a rewind or a restore. Streaming text and thinking deltas go to the `PropertyStore` only and never bump the structural snapshot. The 16 ms coalesced publish from stage 1 [B06] then has nothing to publish for a text delta and is removed for that case. A token costs React zero commits by construction.

**[B02] Whole-snapshot subscribers become selector subscribers, or stop subscribing.** Each of the subscribers in [F02] names the fields it draws and subscribes to a stable selector over them, so a structural change that does not touch those fields does not re-render it. `SessionCardBody` is the first and largest. The react-door lint (`tugdeck/src/__tests__/react-door.test.ts`) gains a rule refusing a bare `getSnapshot` subscription on the session store from a component, so a seventh whole-snapshot subscriber does not arrive unnoticed.

**[B03] `TugListView` reconciles rows, not wrappers.** The row wrapper is keyed and memoized against the row's identity and its own version, so a publish that adds one row reconciles one row. This is the list's own fix and it reaches every list the deck has.

**[B04] The Overview's current line leaves React.** The per-session current line is an imperative write into the masthead and the Overview's live row, like the dot and the streaming text, observed from a `PropertyStore` path per session. `OverviewPostRow` is memoized against its post. The Overview's snapshot changes only when a post is added, removed or edited. `SessionIdentityRow` subscribes to its own session's line, never to the whole Overview.

**[B05] Pane chrome subscribes to what it draws.** This is the owed item from `briefs/deck-animation-pipeline-findings.md` and set-up-and-go [B07], and it belongs here because it is the same cut: a title bar, its buttons and its poppers do not re-render because the card body's snapshot changed. The arc memoizes the chrome against the pane's own props and measures the planning commit before and after with `tugtool deck motion settle --tasks`.

**[B06] The reading of record is stage 1's streaming arm, before and after.** The number this stage moves is React time per second with three sessions streaming, from the `--tasks` recorder's commit census, and the in-motion gap and land on the gestures under streaming. The quiet-deck planning commit is read beside it for [B05].

**[B07] Behaviour is unchanged.** Everything the card shows during a stream shows the same way. Phase marks, tool rows, the task list and the telemetry rows update on the structural publish they already depend on. A test that asserted an intermediate re-render count is re-pointed to the behaviour it was protecting, never silently retuned.

---

## Open Questions {#open-questions}

- **Which structural fields does each subscriber actually read?** Answered by reading each component; the arc's first step is that census, and it decides how many selectors there are.
- **Does anything draw from the streaming text through React today?** A component that reads the accumulated text from the snapshot (a character count, a copy button's enablement) would lose updates under [B01]. The census finds it, and it moves to a `PropertyStore` observer.

---

## Non-goals {#non-goals}

- **Moving the reducer or the wire off the main thread.** Stage 3. This stage reduces what the main thread does with a frame it already has.
- **A lower React lane for streaming.** [F06]; the answer is no commit, not a cheaper one.
- **Changing what the Overview shows.** Its row count and content are stage 4's question and the user's call.
- **Rewriting `TugListView`'s windowing.** Stage 4.

---

## Exit {#exit}

**An arc.** The shape: the subscriber census first, then the store's structural-versus-streaming split with the react-door rule, then the subscribers converted largest first (`SessionCardBody`, the list view, the prompt entry, the telemetry rows), then the Overview and masthead current line, then pane chrome memoization. Each lands with the streaming arm read before and after, and the arc joins with the reading written into the program brief's record.
