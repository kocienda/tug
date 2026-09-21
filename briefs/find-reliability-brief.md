# Find Reliability

**Purpose:** Find in Session cards and Text cards lands on the wrong thing, skips around, or leaves its match off screen, and it has regressed repeatedly. This brief records why, and decides the shape that makes it correct and keeps it correct.

---

## Purpose {#purpose}

The report, in the user's words:

> Find highlighting in text cards and session cards simply doesn't work. It's basically a drunkard's walk. Sometimes it works, and sometimes it doesn't. All too often, *the behavior confidently fails*, skipping around in a transcript or text files to highlight random things, or fails to bring the content into view that it means to show/highlight to me.

And the second half of it, which matters as much as the first: this has been worked on several times over many months and is in a particularly bad state now. The ask is not one more patch. It is to get find under control *and keep it there* — find is well-known technology and Tug should do it well.

So there are two problems: the defects that exist today, and the absence of anything that would have caught them or will catch the next ones.

---

## Evidence {#evidence}

Every finding below was established by reading the code on `main` at `f698c79a8`. **None was reproduced in the running app.** Each is marked for what it is: the code path is verified; the felt symptom it explains is inference until the tests in [B06] reproduce it.

**[F01] The count and the highlight come from two separate copies of the text, joined by ordinal.** `tugdeck/src/lib/transcript-search-index.ts` projects every row to text segments and `searchSegments` counts and orders matches over them. `tugdeck/src/components/tugways/transcript-find-highlighter.ts` does not use those offsets: `paint()` re-runs `search()` over each mounted row's live DOM text and assumes the k-th DOM hit in a row is the k-th index hit (`activeOrdinal`, the `k` counter in the unit loop). Both files' header comments state this as "the invariant navigation relies on." If a row's two texts disagree by one hit, the active highlight lands on a different occurrence or on none, `activeRange` points at it, and the reveal scrolls to that rect. Nothing compares the two sides at runtime. **(verified by reading; the mis-highlight it predicts is not reproduced)**

**[F02] That invariant is kept by hand across a large, growing surface, and nothing tests it.** There are 104 `findable` marker sites across 38 `.tsx` files, each of which must be mirrored — same text, same order — in the one projection file. The only test that measured index/painter agreement, `at0271-find-tool-headers.test.ts`, was deleted on 2026-08-11 in `b80947798` ("delete deprecated AT tests"). Since then 22 commits have added or moved markers and 9 have touched the index or the painter. `tests/app-test/at0339-session-find-bar.test.ts` still says "match correctness is at0271's job." The highlighter's header still says to "extend the fidelity fixture"; no fidelity fixture exists. **(verified: `git log`, `grep`)**

**[F03] Reveals race each other.** `driveFindReveal` in `tugdeck/src/components/tugways/cards/session-card-transcript.tsx` is a `requestAnimationFrame` chain that captures its `input` and `activeMatch`, guarded only by the shared boolean `findPendingRevealRef`. A second gesture sets the flag (already true) and starts a second chain; the first is not cancelled. Each chain calls `settleFindReveal`, which calls `scrollToIndex` on *its own* captured row every frame and then writes `scrollTop` directly. Whichever chain reads `"settled"` first clears the flag and stops both, so the viewport and the "n of N" chip can end on different matches. `handleFindRenderedRangeChange` starts a further chain on every windowing commit while the flag is set, and the reveal's own scroll writes cause windowing commits. **(verified by reading; the race is not reproduced)**

**[F04] A reveal that runs out of budget stays armed with no end, and nothing cancels a reveal on user scroll.** Past `FIND_REVEAL_ATTEMPTS` (24 frames) the flag is deliberately left set ("Past the budget the reveal stays ARMED"). The next rendered-range change — including one caused by the user scrolling by hand — calls `driveFindReveal`, which scrolls back to the old match. Within the budget, a user scroll is likewise fought frame by frame. **(verified by reading)**

**[F05] Every new search starts at the first match in the whole document.** In `tugdeck/src/lib/transcript-find-engine.ts`, a re-search that does not preserve the prior active match sets `activeIndex = 0` — the oldest part of the session, while the reader is usually at the bottom. That makes the default jump the longest one available: across evicted rows, on estimated heights. In the Text card, `documentFindEngine.searchDidChange` in `tugdeck/src/components/tugways/cards/text-card-find-bar.tsx` calls `selectFirstMatch()` on every keystroke, and `selectFirstMatchFn` in `tug-text-card-editor.tsx` takes `query.getCursor(state).next()` — from the top of the document — and centers it. Typing `t`, `th`, `the` re-centers the view up to three times. **(verified by reading)**

**[F06] Session cards clobber each other's highlights.** `transcript-find-match` and `transcript-find-active` are document-global names in `CSS.highlights`. Each `TranscriptFindHighlighter` owns private `Highlight` objects and re-`set`s the names on paint, and its `clear()` `delete`s the names. `handleFindRenderedRangeChange` calls `clear()` whenever its own card has no matches. So a second Session card with no search open, whose window turns over (it is streaming), deletes the searching card's paint. The header comment accepts this "while one card searches at a time"; the clobbering card is not searching at all. **(verified by reading; not reproduced)**

**[F07] The Text card's engine is otherwise sound.** It is CM6's own search over the document, so count, highlight, and active match share one text model and [F01] does not apply. Its felt defects are [F05] and, smaller, that `getMatchInfo` stops assigning an active ordinal past `MATCH_INFO_CAP`, which also blinds the session's ordinal-based wrap detection beyond the cap. **(verified by reading)**

---

## Decisions {#decisions}

**[B01] A match is an address, and the painter paints addresses; it never re-searches.** A transcript match is `(row, unit, start, end)` in the unit's text, and the painter maps those offsets straight to a DOM `Range` with `rangeFromNodes`. This deletes the ordinal join of [F01] rather than guarding it. It is only sound if index text equals DOM text per unit, which is what [B02] establishes.

**[B02] Index and DOM are compared at mount, and the DOM wins.** When a row mounts (or re-renders), the painter compares each findable unit's live text to the index's text for that unit, and the unit count for the row. Equal: paint by offset. Different: replace that row's index entry with the DOM's text, re-run the search, and record a divergence. The consequence is chosen deliberately: a highlight can never sit on the wrong text; the worst case is a count that corrects by one as a row mounts, which is the honest direction to be wrong in. The projection file stops being trusted for correctness and becomes what it actually is — an estimate for rows that are not mounted. Rejected: rendering every row offscreen to derive the index from real DOM (cost), and keeping the ordinal join with a better test (it still fails silently between test runs).

**[B03] One reveal at a time, owned by the list view.** `TugListView` gains a `revealRange(index, getRect)` primitive beside its existing two-pass `scrollToIndex` correction; the find host stops writing `scrollTop`. Exactly one reveal is live per list. A new gesture supersedes the old through a generation token, and a user scroll cancels it. It advances on events, not a frame budget: the row mounts, any fold opens, the rect is measured, one scroll write places it in the band, one resize observation verifies it. It ends **landed** or **failed**, never armed. The flash is drawn only on landed; on failed the chip says so instead of reading "1 of N" over a viewport showing none. It belongs in the list view because the list view already owns the estimated jump, the correction, and the scroll-intent declaration (`tuglaws/scroll-intent.md` classifies `find-reveal`); a host nudging `scrollTop` around that machinery is how [F03] and [F04] came to exist.

**[B04] Search starts where the reader is.** The anchor is the viewport at the moment find begins (⌘F), or the selection (⌘E). A query edit re-searches from the anchor — not from the top, and not from wherever the last keystroke's match happened to land. The active match is the first at or after the anchor, wrapping if there is none. Both cards. This is what Safari, AppKit text views, and CM6's own incremental search do, and it removes the far jump as the *default* outcome of typing a query.

**[B05] One shared `Highlight` per name, registered once, never deleted.** Each card adds and removes only its own ranges from the shared set. A card with nothing to paint touches nothing. This closes [F06] and removes the "most recent painter owns the names" rule.

**[B06] The tests go in first, red, and they are what keeps find fixed.** Four pieces:

- A **find trace** — a small ring buffer recording each gesture, its target address, its outcome (landed / failed / superseded / cancelled), timing, and every divergence from [B02]. App-tests read it; it is also the first thing to look at in any future report.
- A **fidelity sweep** — a fixture transcript carrying every row kind; the test mounts every row and asserts zero divergences. It replaces `at0271` without a per-kind checklist: a new row kind fails it until it is marked and projected correctly, which is the mechanism that answers "keep it there."
- **The walk** — ⌘G through all N matches of a long mixed transcript; at every step the active range's text satisfies the query, sits inside the visible band, and agrees with the chip. The same walk on a Text card with wrapped lines and a large file.
- **Adversarial cases** — ten ⌘G presses without awaiting, then viewport and chip agree; a hand scroll mid-reveal is not pulled back; a second card streaming while the first searches keeps the first's paint; typing a query in steps never moves the view behind the anchor.

Motion assertions use sampled probes, not a single settle read: a one-shot green read has passed a broken motion fix in this codebase before.

**[B07] This is one arc.** The pieces are separable in code but not in confidence: [B06] is the gate for all of them, and landing a fix without the test that pins it is how find got here.

---

## Open Questions {#open-questions}

- **How often do real transcripts diverge today?** [F01] says mis-highlights are possible; only the fidelity sweep and the trace say how common. If the sweep finds divergence in many row kinds, fixing those projections is real work inside the arc; if it finds few, [B02]'s heal path is mostly insurance. The first red run settles it.
- **What does "failed" look like on the chip?** [B03] decides that a failed reveal is reported rather than hidden. The wording and face of that report are not decided, and are small enough to settle when the state exists to look at.
- **For ⌘F with the transcript at the live edge, is "first match at or after the viewport top, wrapping" the right anchor rule, or should a transcript prefer the nearest match *above*?** A transcript reader at the bottom has nothing below them, so the forward rule wraps to the top on the first search — the same far jump [B04] set out to avoid. The likely answer is that a transcript anchors at the viewport *bottom* and searches backward first; it wants the user's call.

---

## Non-goals {#non-goals}

- **A new find face.** The bar, the cluster, the chords, the wrap overlay, and `FindSession`'s semantics are not in question and do not change, beyond the chip gaining a failed state.
- **Replacing the CSS Custom Highlight API.** It is the right mechanism for tinting ranges across the transcript's markdown DOM; the defect is what ranges it is handed, not how they paint.
- **Replacing CM6 search in the Text card or in embedded editors.** [F07]: that engine has one text model and is sound.
- **Deriving the index by rendering every row offscreen.** Rejected in [B02] on cost; the mount-time comparison gets the correctness without it.
- **Tuning the existing reveal loop** — a larger frame budget, a different stall limit, more retries. The loop's shape is the defect ([F03], [F04]); its constants are not.
- **Cross-card or deck-wide find.** One card searches itself.

---

## Exit {#exit}

**An arc.** The order matters more than the grouping:

1. The find trace and the [B06] tests, landed red — this also answers the first open question.
2. [B05] (shared highlights) and [B04] (anchored search), both small and immediately felt.
3. [B03] — `revealRange` in the list view; the host's `driveFindReveal` / `settleFindReveal` / `findPendingRevealRef` retire.
4. [B01] + [B02] — addressed matches and the mount-time comparison; the painter's re-search retires.
5. The stale pointers corrected: `at0339`'s reference to `at0271`, and the two header comments describing the ordinal invariant and the missing fidelity fixture.
