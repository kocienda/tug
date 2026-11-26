<!-- brief-skeleton v1 -->

# Cycle feed: cycles on the aggregate frame, and a deck store over them

**Purpose:** Stage 3 of `briefs/cycle-rollout-brief.md`. Cycles now have a durable record and derived entry states in `tugarc-core`, but nothing carries them to the deck, so no surface can be built over them. This stage sends every cycle, with each entry's derived state and the sessions working on it, from tugcast to tugdeck, and gives tugdeck a store to read them from. It builds no UI.

---

## Purpose {#purpose}

The rollout brief's exit table gives stage 3 as "tugcast sends cycles with derived states and each entry's sessions; tugdeck holds them in a store", waiting on stage 1 alone. Stage 1 landed as `03cb88584`. Stages 5 and 6, the cycle shade and the Cycles & Arcs card, both wait on this one, and the rollout's rule [B18] is that no surface is built before the data under it exists.

The user's scope for this brief: stage 3 only, and no UI.

---

## Evidence {#evidence}

**[F01] The cycle record and its read view exist in `tugarc-core`.** `tugrust/crates/tugarc-core/src/cycle.rs` stores a cycle at `<project_state_dir>/cycles/<id>/cycle.json`. `cycles(paths, repo)` lists a checkout's cycles, most recently changed first, and `view_cycle(paths, record)` returns a serializable `CycleView`: id, name, created, updated, `project_dir`, `created_by`, `landed`, the sketches as letter and id, and one `EntryView` per entry. An `EntryView` is the entry flattened (n, brief, arc link, waits, from, note, added) plus its derived `state` (`joined | running | ready | waiting`) and the `stages` of its arc, each an `ArcStageLine` carrying `stage`, `session_id`, `model` and `at`. **(verified)**

**[F02] `view_cycle` reads the arc log once per cycle, and `read_arc` once per linked entry.** `entry_states(log_text, record)` is pure over the log text, but `view_cycle` reads the file itself. A project with many cycles composed on every recompute would read the same log once per cycle. **(verified, by reading)**

**[F03] `tugrust/crates/tugcast/src/feeds/arc.rs` is not the transport.** It is the arc predicate, the pure rule list that decides what a server-driven arc does next. Nothing in it sends arcs to the deck. **(verified)**

**[F04] Arcs reach the deck on the account-global `CHANGESET_ALL` feed (0x24).** `tugrust/crates/tugcast/src/feeds/changeset_all.rs` composes one `WorkspacesChangesetSnapshot` over the `WorkspaceRegistry`'s open projects. Each `ProjectChangeset` carries live arcs as `ChangesetEntry::Arc` rows inside its flattened snapshot and branchless arcs as `document_arcs: Vec<DocumentArcEntry>`. Both carry `owner_id`, the arc's owner key, and `bound_session`, and the live row adds `bound_callsign`. The wire types are in `tugrust/crates/tugcast-core/src/types.rs`, mirrored in `tugdeck/src/lib/changeset-types.ts`, and guarded by the shared golden fixture `tugdeck/src/__tests__/fixtures/workspaces-changeset-snapshot.golden.json`, which a Rust test (`types.rs`, near line 2374) and the TS tests (`changeset-types.test.ts`, `arcs-card.test.ts`, `session-changes-arc-lane.test.ts`) all read. **(verified)**

**[F05] Arc composition runs once per repository, not once per open project.** `changeset_all.rs` groups projects by git common dir and lets only one member of a group (the base checkout, if open) compose the arc rows and `document_arcs`. Under an app-test instance, `arcs_hidden_for` in `feeds/changeset.rs` hides the checkout's arcs so a test does not list the developer's work. **(verified)**

**[F06] The session bound to an arc is read from this instance's ledger by owner key.** `SessionLedger::bound_session_by_arc()` maps `arc_id` to one session id. The owner key is `tugarc_core::ops::arc_owner_key(repo, name)`: `tugarc/<name>#<tugid>`, or the bare `tugarc/<name>` for an arc with no creation id. It is a read path that never mints. **(verified)**

**[F07] The aggregate recomputes only on a bump, and a cycle write reaches no bump today.** The feed waits on a shared `Notify`. Out-of-process writes under the data dir reach it through a 2 s probe that reads the drafts version and stats each open project's arc log. A `tugtool cycle` write lands in `cycles/<id>/cycle.json` under the data dir, which no workspace watcher sees and the probe does not stat. **(verified)**

**[F08] A watch on the project state dirs already exists, and it is the house pattern for data-dir files.** `tugrust/crates/tugcast/src/feeds/arc_notes.rs` arms a recursive `notify` watch on `<data>/projects`, matches events by file name, coalesces them through a depth-1 channel, logs at `error` and stops when it cannot arm, and has no poll fallback. Its docblock gives the reason: a file the user is watching for is watched, never stat'd on a timer. **(verified)**

**[F09] The deck holds the aggregate in one store, and arc questions are derived indexes over it.** `tugdeck/src/lib/changeset-all-store.ts` is an app-level singleton over a `FeedStore` for `CHANGESET_ALL`, read through `useChangesetAll` ([L02]). `tugdeck/src/lib/arc-session-index.ts` answers "what arc is this session on?" by projecting that snapshot into a map memoized on snapshot identity, and it files each fact under both the bound segment and that segment's line. **(verified)**

**[F10] `tugcast-core` does not depend on `tugarc-core`.** Only `tugcast` does. The aggregate's wire types are plain strings and numbers: `ArcTimelineStage` carries `stage` as a string, for example. **(verified, from both `Cargo.toml` files)**

---

## Decisions {#decisions}

**[B01] Cycles ride `CHANGESET_ALL`, as a `cycles` list on each `ProjectChangeset`. There is no new feed.** An entry's state is derived from the same arc log as the arc rows beside it. In one frame, an entry reading `running` and its arc's row can never disagree, and two feeds arriving at different moments could. The aggregate also already has every piece this needs: the registry enumeration, the per-repository owner gate ([F05]), app-test hiding, diff suppression, and the deck store every arc surface reads ([F09]). A separate `CYCLES` feed id would duplicate each of them. The field is omitted when empty, the same as `document_arcs`.

**[B02] Cycles are composed where arcs are composed, under the same gate.** Only the project that owns its repository's arcs lists that repository's cycles, so a base checkout and its open arc worktrees do not each list them. Under an app-test instance they are hidden whenever `arcs_hidden_for` hides the arcs. The list keeps the order `cycles()` returns, most recently changed first. Every cycle is sent, a cycle of one included, because the rollout's [B02] puts every arc on a cycle, and how a cycle of one looks is decided by the surfaces.

**[B03] The wire types are new structs in `tugcast-core/src/types.rs`, composed in `tugcast` from `CycleView`.** `tugcast-core` cannot name `tugarc-core`'s types ([F10]), and every aggregate type already lives in `types.rs` with a TS mirror and a golden fixture. A `CycleWire` (or whatever name fits the file) carries the `CycleView` fields as they are. Each entry carries `n`, `brief`, `waits`, `from`, `note`, `added`, the arc link (name and generation start), `state` as its lowercase string, and `stages` as stage, session id, model and timestamp strings.

**[B04] Each entry's sessions are two facts, both resolved by the server.** The first is the **live session**: when the entry's link is the arc's current generation, the entry carries the arc's `owner_id` from `arc_owner_key` ([F06]), `bound_session` from `bound_session_by_arc`, and `bound_callsign`, read exactly as the arc rows read them. `owner_id` is what lets a surface go from an entry to its arc's row in the same frame without matching names. The second is the **history**: the session id of every stage rotation, already in `stages`. The live session is this instance's view, as it is for an arc row. A session bound in another instance does not appear, and that matches how arcs read today. The cycle's own writer travels as `created_by`. The deck composes none of this ([D138]): it has no filesystem and no arc log.

**[B05] Each entry carries its brief's absolute path and first heading, present only when the file is on disk.** This follows `ArcDocuments`, for the reason that struct gives: a surface that wants to name a document cannot open it. The relative `brief` from the record stays beside them. Sketches travel as letter and id only. Their text is not this stage's, and the arc's documents already carry an arc's sketch text.

**[B06] Composition reads each project's arc log once.** `tugarc-core` gains a view entry point that takes the log text, so composing a project's cycles reads the log once and not once per cycle ([F02]). `entry_states` is already pure over that text. The existing `view_cycle` stays for `tugtool cycle show` and reads through the new entry point. The work runs on the blocking pool, as `document_arc_entries` does.

**[B07] A cycle write is observed by a `notify` watch, and the watch fires the aggregate's bump.** The watch is recursive over the project state dirs and matches `cycle.json` by file name, the pattern `arc_notes.rs` uses ([F08]), and it does not stat on a timer. A watch that cannot be armed logs at `error` and stops. There is no poll fallback. Adding `cycle.json` to the 2 s probe was considered and rejected: a cycle appearing in the sidebar is something the user watches for, and the house rule is to watch such a file. The same watch also matches the arc log, since an entry's state moves when the log does. A burst of events coalesces into one bump, and the feed's 150 ms floor coalesces it again.

**[B08] tugdeck holds cycles as a derived store over `ChangesetAllStore`, in `tugdeck/src/lib/cycle-store.ts`, with no `FeedStore` of its own.** It follows `arc-session-index.ts` ([F09]): project the snapshot on read, memoize on snapshot identity, and read through `useSyncExternalStore` ([L02]). It answers three questions:

- every cycle, across projects, in the order the frame sends them;
- one cycle by id;
- the cycles a session belongs to: those it created, or one of whose entries it is bound to or ran a stage of.

The last is what the rollout's [B09] needs, a cycle showing in the session that wrote it and in every session bound to one of its arcs. Like the arc index, it files each session under both the segment and that segment's line, because a caller holds a segment and a rotated card's history names earlier ones. The store returns frozen empties when no aggregate store is attached (gallery, fixtures).

**[B09] The TS mirror and the golden fixture move with the Rust type.** `changeset-types.ts` gains the cycle types, and its snapshot guard accepts a frame with or without `cycles`. The golden fixture gains one cycle holding an entry in each of the four states, one with a bound session, and one sketch, so both languages are checked against the same bytes.

**[B10] Verification is unit tests only.** Rust: composition over a scratch repository and arc log, covering states, `owner_id` and bound session for the current generation and none for an ended one, the owner gate, hiding, and the one-log-read entry point. TS: the store's three queries, including a lookup by line. Nothing in this stage changes what a card draws, so no app-test covers it.

---

## Open Questions {#open-questions}

- **Whether the probe's arc-log stat retires once the watch covers the arc log.** With [B07] the stat becomes redundant, but other aggregate facts (join readiness) rely on it, and removing it changes their latency path. This stage leaves it in place. Retiring it is a separate change for whoever owns that probe.

---

## Non-goals {#non-goals}

- **Any UI.** No shade, no CYCLE cell, no sidebar rows, and no change to what any existing surface draws. Those are stages 5 and 6.
- **A `CYCLES` feed id.** Rejected in [B01].
- **Stat'ing `cycle.json` on the existing probe.** Rejected in [B07].
- **Writing cycles from tugcast.** Cycles are written by `tugtool cycle` and, after stage 2, by the skills. tugcast only reads them.
- **Resolving stage sessions to callsigns on the server.** Stage session ids travel bare, as `ArcStageLine` carries them. The deck's session identity stores already resolve an id. Only the live session gets its callsign, matching the arc rows.
- **Sketch text or sketch titles on the wire.** Left to the stage whose surface shows them.
- **Cycles from projects that are not open.** The aggregate lists open projects, and so do its cycles.

---

## Exit {#exit}

An arc, `cycle-feed`, waiting on nothing now that stage 1 has landed. Its first steps, in order:

1. `tugarc-core`: the one-log-read view entry point ([B06]), with `view_cycle` reading through it.
2. `tugcast-core`: the cycle wire types on `ProjectChangeset` ([B03], [B05]), the golden fixture extended ([B09]), and the Rust round-trip test passing against it.
3. `tugcast`: composition inside the arc-owning branch of `changeset_all`, with hiding, owner key and bound session ([B02], [B04]), and its unit tests.
4. `tugcast`: the `cycle.json` and arc-log watch firing the bump ([B07]).
5. `tugdeck`: the TS mirror and guard, and `cycle-store.ts` with its tests ([B08], [B09]).

Steps 1 to 3 land in that order. Step 4 needs only the bump. Step 5 needs only the fixture from step 2.
