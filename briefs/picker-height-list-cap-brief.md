# The unbound Session card is pinned at the height of an empty picker

**Purpose:** An unbound Session card opens at a pinned height that was measured against a picker with nothing in its sessions list. On a real project the list runs to its cap and the picker is far taller than the card, so the sheet clips at both ends and scrolls. The card has to be big enough to present the whole picker, and the number has to be guarded against the picker as it actually appears.

---

## Purpose {#purpose}

The user's words, with a screenshot of a new Session card standing as the lower member of a split column on the `tug` project, its Choose Session sheet cut off above the path field and below the sessions list:

> What *exactly* is the problem here? Why can't you implement this the way I'm asking for? … You *see* that the new session card *isn't right*, yes? Now, give me a sketch *this time for real* that gives me a card that fully presents the new session picker sheet!

And from the brief that produced the current behaviour, the standing instruction: *"Just make the card big enough that the sheet doesn't clip."*

The `picker-card-arrival` arc (joined as `67db70119`) divided the arrival into beats and pinned the card at `SESSION_UNBOUND_HEIGHT_PX = 444`. The choreography is not at fault. The card arrives cleanly at the wrong size.

---

## Evidence {#evidence}

**[F01] The constant was measured against a picker with one row in its list.** `SESSION_UNBOUND_HEIGHT_PX` was resolved from `at0569`'s diagnostic line `claimed 380px against a floor of 600px`, taken as the picker's natural height. Every app-test launches on a fresh per-instance `sessions.db` (`tests/app-test/_harness/index.ts` sets `TUG_SESSIONS_DB` under the instance's own directory), so the picker in that fixture lists exactly one row, "New session". The 380 is the picker with nothing to pick from. **(verified by reading the harness and the constant's doc-comment in `session-card-registration.tsx`)**

**[F02] The sessions list is capped, and a real project reaches the cap.** `.session-card-picker-list-view.tug-list-view` in `session-card.css` is `height: auto; max-height: 14.5rem` — 232px at the 16px root — and every row has a floor of 3.5rem (56px) with resume rows carrying title, subtitle and a preview line. Three or more sessions fill the cap. The `tug` project has more than three. **(verified by reading the stylesheet; the screenshot shows the list scrolled inside its cap)**

**[F03] The picker with its list at the cap needs roughly 630px of card, against 444 pinned.** The list at its cap is about 176px taller than the one-row list of [F01], so the panel's natural height is about 556px rather than 380, and the card's height is that plus the 76px the current constant already accounts for (title bar and clip drop 37, panel top margin 12, `SHEET_CANVAS_GAP` 32, less the 5px the imposition leaves under the column's last member). **(arithmetic from [F01] and [F02], not measured in the built app; the built-app measurement is the first task of the arc)**

**[F04] The clipping in the screenshot is the sheet's clamp doing what it is built to do with a panel that does not fit.** `tug-sheet.tsx`'s top-anchor clamp caps the panel against the visible canvas: the clip grows down to `SHEET_CANVAS_GAP` above the canvas bottom, then up past the masthead, and the panel scrolls within it. On a 444px card at the foot of a split column that is exactly the picture — the Choose Session header cut off above, the action row cut off below. **(verified by reading the clamp's comment and code)**

**[F05] No test could have seen this, and the audit checked against the same fixture.** `at0569` asserts the panel's overflow is within 1.5px on a 444px card, and passes, because its picker is the one-row picker of [F01]. `at0571` adds the card at run time and reads the same empty list. The arc-audit verified [F04] of the previous brief ("a little under 400px") against the same diagnostics rather than asking what the number was measured against. **(verified)**

**[F06] The harness cannot yet put rows in the picker.** `seedLedger` writes `changes.db` rows for the Changes shade; nothing in `tests/app-test/_harness/` writes to the per-instance `sessions.db` the picker lists from. **(verified by grep; if a verb exists under another name, the arc's first task finds it)**

---

## Decisions {#decisions}

**[B01] The pinned height is the picker with its sessions list at its cap, not at one row.** The list is capped at 14.5rem, so the picker has a real maximum, and the card is pinned at that maximum: header, path field, sessions header, the list at its cap, the action row, plus the 76px of chrome and gutters the current constant already carries. A picker with a short list opens with air under it. The standing instruction was "big enough that the sheet doesn't clip", and air is the price of that. The number stays one constant known before `addCard` commits, so nothing about [B02] of `picker-card-arrival-brief.md` moves: the arrival is still one arm of the settle and nothing re-targets it a commit later.

**[B02] The constant is measured in the built app against a full list, and the doc-comment says so.** Not derived from the stylesheet ([F03] is arithmetic and is not the number). Open a card on a project with more sessions than the cap holds, read the panel's `scrollHeight` with the list at its cap, and pin that. The doc-comment on `SESSION_UNBOUND_HEIGHT_PX` must state that the measurement was taken with the list at its cap, so the next person to read 380 somewhere does not repeat this.

**[B03] The pin's tests open the picker with the list at its cap.** `at0569` and `at0571` prove nothing about this number while their picker lists one row ([F05]). The harness gains a way to seed session rows into the instance's `sessions.db` before the picker opens ([F06]), and both tests use it. The no-clip assertion — panel overflow within 1.5px, on a card at the foot of a split column, with the list at its cap — becomes the assertion that matters, because it is the case in the screenshot and the case that has never run.

**[B04] The card's height is not derived from the session count.** A pin computed at `addCard` from the number of sessions would size an empty picker tighter, at the cost of a second input to the arrival that depends on whether the session store already holds the list when the card opens. The cap makes the maximum knowable without that input, and the brief that produced the current behaviour already chose one constant over a computed one. Revisit only if the air under an empty list turns out to matter more than the extra machinery.

---

## Non-goals {#non-goals}

- **Sizing the card from the picker's measured report.** The `sheet-reservation` mechanism stays as it is, for sheets on other cards. A measured height lands a commit after the card does and re-targets the settle mid-beat, which is the judder `picker-card-arrival` removed; the previous brief rejected it and the cap makes the maximum knowable without it.
- **Touching the arrival choreography.** Beats, the arrival event, the settle-end notice and the clamp's re-measure occasions are all correct and stay untouched. This is one number and the tests that guard it.
- **Raising or removing the list's cap.** The cap is what bounds the picker's height and what makes a constant honest. A taller cap is a different question about the picker, not about the card.
- **Loosening the no-clip assertion to pass on the empty fixture.** The fixture is what must change ([B03]).

---

## Exit {#exit}

An arc.

The order that matters: first, find or build the harness verb that seeds session rows into the instance's `sessions.db` ([F06], [B03]), because without it the number cannot be measured in a test or guarded by one. Then measure the picker in the built app with the list at its cap and re-pin `SESSION_UNBOUND_HEIGHT_PX` with a doc-comment that records the condition ([B02]). Then rewrite `at0569` and `at0571` to open the picker over a seeded list at its cap, with the no-clip assertion on a card at the foot of a split column, and update the two tests' copied constants. Then look at it on the `tug` project — a split column, a new Session card, the whole picker on screen with nothing cut off at either end — and on a project with no sessions, to see the air.
