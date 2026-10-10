<!-- brief-skeleton v1 -->

# A shared subscribe-and-notify base for tugdeck's stores, and a cap on the session transcript

**Purpose:** Eighty-eight store classes and twenty module-level listener sets in `tugdeck/src` each hand-roll the same subscribe, unsubscribe, and notify, and the session store's transcript array has no upper bound, so a session left open all day grows memory linearly with every turn.

---

## Purpose {#purpose}

Item 23 of `briefs/audit-punch-list.md`:

> 23. A shared store base for the 98 hand-rolled subscribe and notify implementations, and a cap on reducer growth so a day-long session does not grow memory linearly.

Behaviour is held fixed for the stores. For the transcript, the one behaviour that changes is that a session with more turns than the cap shows the most recent ones and reaches the older ones through the door that already exists for them.

---

## Evidence {#evidence}

**[F01] The count** — 93 `class \w*Store` declarations in `tugdeck/src`, 88 of them production (the other five are mocks and gallery fixtures). `new Set<() => void>` appears 91 times in 88 files; 20 of those are module-level constants (among them `theme-tokens.ts:19`, `settle-engine.ts:394`, `cards-selection-store.ts:203`, `session-card-telemetry-renderers.tsx:287`, `lab-flags.ts:21`). A looser pattern over listener sets and maps finds 112, where the extra 26 are typed registries such as the pane registries' `Map<string, Set<Listener>>`. **(verified)**

**[F02] No base exists** — searches for `createStore`, `StoreBase`, `BaseStore`, `createExternalStore`, `ListenerSet`, and `Subscribable` find only comments. The one shared piece is the `useSyncExternalStore` wrapper at `lib/gesture-scope.ts:504`, imported by 140 files; 146 non-test files call it at 290 sites. **(verified)**

**[F03] The deck-manager carve added a store in the same hand-rolled shape** — `spaces-store.ts:52` holds `private subscribers: Set<() => void>`, with `subscribe` at :70 and `notify` at :113. `card-state-cache.ts` and `layout-persistence.ts` carry no subscribe surface by their own headers. **(verified)**

**[F04] The transcript is unbounded and the reducer state is nearly bounded** — the transcript is not in the reducer state; it is `CodeSessionStore._transcript: ReadonlyArray<TurnEntry>` at `lib/code-session-store.ts:535`, grown by append (`appendTurnInterleavingInk`, `upsertInkTurn`, and a spread at :2808-2833) and shrunk only by `truncateTranscriptAtAnchor` on rewind (:2852). In `reducer.ts` (7,919 lines), `CodeSessionState` at :346 holds `committedMsgIds: Set<string>` at :672, copied on every commit (:3723, :4047, :5530) and never trimmed; the three interval arrays at :894-896 are reset per turn. No `slice(-`, `MAX_`, `prune`, `evict`, or `retention` applies to turns or entries in either file. **(verified)**

**[F05] A door for older turns already exists** — `_prependStaging` at `code-session-store.ts:539` stages turns delivered by a load-previous replay bracket, and `flush-prepend` commits them to the front of `_transcript` at the bracket's `replay_complete`; `_loadPreviousTarget` drives the load sheet's progress. So the ledger is the source of truth for every turn, and the deck already knows how to hold a window and extend it backwards. DOM-level eviction of off-screen entries exists separately (`lab-flags.ts:12-37`, `smart-scroll.ts:1303`) and is about render cost, not data. **(verified)**

**[F06] tugcast's side is already capped** — the CODE_OUTPUT `ReplayBuffer` is a `VecDeque` of 1,000 frames (`boot/feeds.rs:64`, `tugcast-core/src/lag.rs:35-41`). **(verified)**

---

## Decisions {#decisions}

**[B01] One module, `lib/subscribable.ts`, exporting a `Subscribable` class (listener set, `subscribe` returning the unsubscribe, `notify`) and a `createSubscribable()` for the module-level sets.** It owns the listener set and nothing else: no snapshot, no caching, no equality. Every store's snapshot contract is its own and stays where it is, which is what makes adoption a mechanical replacement of three methods rather than a redesign of 88 stores. A base that also owned snapshots would be a framework, and the laws ([L02]) are satisfied by `useSyncExternalStore` already.

**[B02] Adoption is a sweep, counted down by `new Set<() => void>` and done in two steps: the 20 module-level sets first, then the class stores.** The gauge reaches zero outside `subscribable.ts` and the 26 typed registries, which are keyed maps and not this shape. `SpacesStore` ([F03]) is in the second step; `CardStateCache` and `LayoutPersistence` have nothing to adopt.

**[B03] The transcript is capped by turn count in `CodeSessionStore`, with the evicted turns reachable through the load-previous bracket in [F05].** The cap is one named constant; when an append would exceed it, the oldest turns leave `_transcript` and the store reports that older turns are loadable, exactly as it does for a session restored with a partial window today. The ledger is the source ([F05]) and the DOM eviction is unchanged, so the user sees the same transcript shape with one new fact: a very long session has a "load previous" edge where it did not before.

**[B04] `committedMsgIds` is pruned to the ids present in the window at the same moment, and the rewind path is checked for an anchor outside the window.** [F04]: it is the one reducer set that grows with the session. Rewind truncates at an anchor; if the anchor has been evicted, the rewind must either load the window back to it or refuse with the existing "not in transcript" shape, and the arc settles which by reading `truncateTranscriptAtAnchor`.

**[B05] The verdict for the cap is a unit test, not a heap reading.** A `bun test` that appends cap-plus-N turns asserts `_transcript.length` stays at the cap, `committedMsgIds` stays bounded, and a load-previous bracket restores the evicted turns in order. A heap number from a day-long session is the motivation, not the assertion.

---

## Open Questions {#open-questions}

- The cap value. Nothing in the deck measures turn memory; the first step of the arc takes a reading from a long real session through `/api/eval` on a motion-enabled deck and picks a number with headroom above the longest session seen. The constant is named so that the number is one edit.
- Search across evicted turns. `lib/transcript-search-index.ts` indexes what the window holds, so a capped session searches its window. Whether search should pull the ledger for older turns is a feature question for later, not this arc; the default is to document the window.

---

## Non-goals {#non-goals}

- **A store framework.** No zustand, no signals, no snapshot base. [B01].
- **Changing the `ReplayBuffer` size or any tugcast retention.** [F06].
- **Changing DOM eviction.** It is a render concern and already has a lab flag.
- **Capping any other reducer collection.** The interval arrays reset per turn; `scratch`, `jobs`, and `rewindPreviews` are bounded by their own lifecycles.

---

## Exit {#exit}

An arc. Steps as ordered in [B02] then [B03] through [B05]: `subscribable.ts` with its own test; the module-level sweep; the class sweep; the cap with the pruning and the rewind check, landing with the test in [B05]. `bun test` in `tugdeck/` is each step's verdict. The `@covers`-derived app-test selection runs once after the class sweep (the stores reach everywhere, so budget for two batches) and once after the cap.
