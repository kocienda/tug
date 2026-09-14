# Ghost arcs in the Arcs card

**Purpose:** A discarded arc goes on drawing a row in the Arcs sidebar card, reading "Briefed" as though it were about to begin. The scan that mints paperwork rows cannot see that the arc ended, and the row it draws carries no verb that could remove it.

---

## Purpose {#purpose}

`session-topline-currency` was opened by mistake on 2026-09-14, stopped by the user — *"I did not say to start the work, at all! Cancel this arc."* — and discarded. The discard did everything it was asked to. The next day the arc was still in the sidebar:

> Why is this Arc still lingering in the Arcs sidebar card? This is a *horrid bug*. There is no such arc anymore.

The row shows the arc's name, an empty step strip, and the word **Briefed** — the reading a brand-new arc gets. Nothing on the surface distinguishes an arc that is about to start from one that is over.

---

## Evidence {#evidence}

**[F01] The discard completed correctly.** The arc log at `~/Library/Application Support/Tug/projects/-Users-kocienda-Mounts-u-src-tug/arc-log.md` records the whole life and its end — `arc-start`, `arc-kind plain`, `created`, `arc-dispatch implement`, `arc-stop implement stopped by user`, then `discarded via cli`. `git worktree list` shows no worktree and `git branch` no `tugarc/session-topline-currency`. The teardown is complete; the row is not a stale branch. **(verified)**

**[F02] What survives is the paperwork, and by design.** `.tug/arcs/session-topline-currency/` still holds `brief.md` and `tasks.md`. `discard_inner` keeps them deliberately — `tugrust/crates/tugarc-core/src/ops.rs:5442`: *"The documents stay: a discarded arc's brief and plan are the only trace of decisions the user may want back, and `arc run <name>` reopens on them ([P11])."* The `DiscardOutcome` reports this as `documents_kept`. **(verified)**

**[F03] Join and discard treat the documents oppositely, and only discard leaves a ghost.** A join removes the directory outright (`tugrust/crates/tugarc-core/src/ops.rs:5180`, `remove_dir_all` with the squash commit as the documents' new home, [P11]). A discard keeps it. So the ghost row is specific to the discard path — every joined arc leaves the card cleanly, which is why the defect survived `abae7ebe9`. **(verified)**

**[F04] The scan that mints paperwork rows tests two things, and neither is "is this arc over".** `document_arc_entries_in` (`tugrust/crates/tugcast/src/feeds/changeset.rs:1476`) walks `document_arc_dirs`, drops any name carrying a `tugarc/<name>` branch, and keeps the rest if they hold a document or a bound session. A discarded arc passes both filters. The arc row shape landed in `abae7ebe9` ("List briefed and planned arcs beside branched ones"); the discard's keep-the-documents rule long predates it. Two individually-correct behaviours meeting is the whole of the bug. **(verified)**

**[F05] The row cannot tell, and `read_arc` is why.** The scan does call `tugarc_core::read_arc` for the arc's stage and kind. But `read_arc` (`tugrust/crates/tugarc-core/src/arc.rs:506`) applies the generation reset: on every terminal line it sets `found = None`, so a discarded arc reads as *no arc record at all*. The entry therefore gets `arc: None` and `arc_kind: None` — byte-identical to a name that was briefed and never created. The card renders "Briefed" because that is honestly everything the wire gave it. The terminal marker erases the record rather than leaving a headstone. **(verified)**

**[F06] There is no way to remove the row — not from the card, and not from the CLI.** `PlanCell` (`tugdeck/src/components/arcs/arcs-card.tsx:893`) renders paperwork rows with a transport control and nothing else: no `onContextMenu`, so no `useArcRowVerbsMenu`, so no Bind/Discard/Replay. `ArcCell` — the branched row — has all of them. And the CLI refuses: `tugtool arc discard session-topline-currency` exits with `error: Arc not found: session-topline-currency`, because `discard_inner`'s branchless path (`ops.rs:5314`) requires `read_arc(...).is_some()`, which [F05] has already emptied. The only remedy today is `rm -rf` on the directory. **(verified)**

**[F07] The confirm affordance the delete wants already exists on this card.** `TugConfirmPopover` is mounted once for the whole card, anchored to whichever row armed it, with `confirmRole="danger"` so default focus lands on Cancel (`arcs-card.tsx:1147`). `requestDiscard` sets `pendingDiscard`; the popover's `onConfirm` calls it. A paperwork row's delete can arm the same one popover rather than introducing a second. **(verified)**

---

## Decisions {#decisions}

**[B01] The scan learns to ask whether the arc ended.** `document_arc_entries_in` gains a third filter beside the branch check: a name whose arc log's last terminal line is not followed by a fresh `arc-start` draws no row. The fact is already on disk — `is_terminal` (`tugrust/crates/tugarc-core/src/log.rs:476`) knows every spelling of it, including the historical `released` — and the only thing missing is an API that reports it, because `read_arc` deliberately cannot ([F05]). This rules out inferring deadness from the documents, which would be guessing at a fact the log states outright.

**[B02] The documents stay exactly where they are.** [F02] is not collateral damage to be tidied up: `arc run <name>` reopening on a discarded arc's brief is a promise [P11] makes, and moving the directory to a `.discarded/` sibling would quietly break it to fix a rendering problem. The row disappears; the brief does not. This is what rules out the alternative in Non-goals, and it would only be revisited if the reopen path itself were retired.

**[B03] `tugarc-core` grows a small read that names the terminal fact.** Something on the order of `last_terminal(repo, name) -> Option<(timestamp, marker)>`, or a predicate over the same scan — one implementation, in the crate that owns the log, so the card and any later surface asking the same question read the same answer. Putting the log-line walk in `changeset.rs` would put arc-log parsing in tugcast, which is where the per-surface divergences of the past have started.

**[B04] Paperwork rows get a delete verb, behind the card's existing confirm.** A discarded arc is not the only way to end up with a directory the user wants gone — an abandoned door leaves one too, and [F06] says nothing can currently remove either. The row gets the gesture; the gesture arms the `TugConfirmPopover` already mounted ([F07]); the confirm deletes the documents directory and nothing else. Its wording must say what it destroys — a brief, permanently, and untracked, so git will not give it back.

**[B05] Delete is a document verb, not a discard.** It does not route through `tugtool arc discard`, which is about branches and worktrees and refuses this case outright ([F06]). It needs its own verb and its own wire frame. Keeping them distinct is what stops the destructive branch-teardown path from acquiring a second meaning.

---

## Open Questions {#open-questions}

- **Where the delete gesture lives on the row.** The user asked for a delete *button*; the card's established idiom for rare row verbs is the second pointer button, and `useArcRowVerbsMenu`'s own doc comment argues at length against spending a row's trailing end on verbs nobody presses. A paperwork row's trailing end currently holds the transport, so a visible button would be the second control on a row [D142] describes as having room for one. Settling this is a look-and-feel call on the real card.

- **Whether [B01] alone empties this particular row.** The fix makes the scan drop discarded names going forward. `session-topline-currency` on this machine would be dropped by it — the log's last line for that name is terminal — so no migration is implied. Worth confirming against any other checkout carrying older arc-logs before concluding no one needs a sweep.

---

## Non-goals {#non-goals}

- **Moving a discarded arc's documents to `.tug/arcs/.discarded/<name>-<stamp>/`.** Considered as the alternative shape: it empties the scan's field of view without teaching the scan anything, and it preserves the brief. Rejected on [B02] — `arc run <name>` reopens on documents at their own path ([P11]), so relocating them breaks the reopen to fix the rendering, and it puts the brief somewhere the user would not think to look.

- **Changing what `read_arc` returns for a discarded arc.** The generation reset is load-bearing: it is what stops an arc name reused after a discard from inheriting the previous generation's declarations (`log.rs:466–472`). The scan needs a *different* question answered, not this one answered differently.

- **Making the join path keep its documents for symmetry.** The asymmetry in [F03] is correct — a joined arc's brief is in the squash commit, a discarded arc's is nowhere else. Nothing here proposes to level it.

- **A general "clean up `.tug/arcs/`" sweep or retention policy.** Out of scope. The delete verb is per-row and user-initiated.

---

## Exit {#exit}

An arc. Its raw material, in the order the dependencies fall:

1. **The terminal read in `tugarc-core`** ([B03]) — the function, over the same log walk `read_arc` does, plus unit tests for the discard spelling, the historical `released`, the join spellings, and a name re-started after a terminal line.
2. **The scan filter** ([B01]) — `document_arc_entries_in` calls it; a test alongside `document_arc_entries_read_review_and_steps` (`changeset.rs:3377`) covering a directory whose arc was discarded.
3. **The delete verb** ([B04], [B05]) — the core operation, its wire frame, and the `PlanCell` gesture arming the card's existing confirm. Its own app-test.

(1) and (2) are one change and want to land together; (3) is independent of both and could land first or last. Both halves touch surfaces app-tests cover, so `just app-test-changed` is the read.
