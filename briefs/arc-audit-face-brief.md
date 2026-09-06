# The audit wears its own name, and a stopped audit does not offer the join

**Purpose:** The Changes shade told the user an arc was in `check`, then that it had `stopped · audit did not mark planned`, then that it was `Ready to join` — three sentences about the audit stage, one wrong word, one that is not English, and one that offers to land code nothing audited. The join draft is also written by the wrong stage for a reason that is no longer true. This brief settles the audit's vocabulary on every face, retires the kind word from the lifecycle line, holds the join offer shut on a stopped audit, and makes the audit the author of record for the join message.

---

## Purpose {#purpose}

The `arc-never-stops` arc ran its audit stage on 2026-09-04 in `tug/solid-gnat`. The Changes shade's arc row read, in sequence:

> `check planned`
> `stopped · audit did not mark planned` — with **Ready to join · ready** beneath it

The user's notes, verbatim: *"The word is 'audit', and we should use it everywhere. Banish 'check' from this usage context."* — *"'audit did not mark planned' is very awkward English. I would really like something better here."* — *"'Ready to join' beneath a stopped audit is out of whack. Needs a fix."* And one question about the stages' order of work: *"We still write the join draft before we audit. Does that seem right to you?"*

Four faults, one surface. Each is small; together they make the arc's last stage the least legible one, on the row the user reads to decide whether to land it.

---

## Evidence {#evidence}

**[F01] The lifecycle line prints the phase *key*, and the audit's key is `check`.** `arcLifecycleNote` in `tugdeck/src/components/tugways/arc-lifecycle-line.tsx:57` returns `model.phase` bare when the arc has not stopped, and `ArcPhase` in `tug-arc-track.tsx:36` is `"brief" | "devise" | "review" | "implement" | "check" | "join"`. The strip's cell label was already corrected to `Audit` (`ARC_PHASE_LABELS.check: "Audit"`, `tug-arc-track.tsx:86`) with a comment keeping the key as `check` "because every `data-phase` and test that reads the strip names it". So the strip says Audit and the note beside it says check. `arcPhaseWord` in `arc-phase-mark.tsx:49` prints the same bare key into the glyph's tooltip and `aria-label`. **(verified)**

**[F02] The `check` key has five homes and no CSS.** The type and both phase lists (`tug-arc-track.tsx:36-66`), the label and icon maps (`tug-arc-track.tsx:86`, `arc-phase-mark.tsx:45`), the derivation's four `"check"` arms and `arcPhase` (`tug-arc-track.tsx:257-281`), seven cases in `tugdeck/src/components/tugways/__tests__/tug-arc-track.test.ts`, and two app-tests — `at0407-arcs-card.test.ts:620-632` asserts the cell list contains `"check"` and `at0473-arc-cockpit.test.ts:724` waits on `[data-phase="check"]`. No stylesheet selects on `data-phase="check"` (`tug-arc-track.css` and `arc-lifecycle-mark.css` select only `brief` and `join`), so the rename touches no paint. [D169] in `tuglaws/design-decisions.md:681` names "a `check` cell between implement and join" in prose. **(verified by grep)**

**[F03] "planned" is a fact rendered after the note with nothing between them.** `arcMetaFacts` in `tugdeck/src/lib/arc-meta-facts.ts:162` pushes `{ key: "kind", label: "planned", tone: "muted" }` last, and `ArcLifecycleLine` maps every surviving fact into a span directly after the note span (`arc-lifecycle-line.tsx:147-160`). The line's filter `NOT_ON_THE_LINE` drops `arc`, `arc-stopped`, `uncommitted`, `behind`, `replayed` — and not `kind`. So a running audit reads `check planned` and a stopped one reads `stopped · audit did not mark planned`. The fact's own docblock says the kind "yields to every fact that describes what is happening now", which describes its sort position, not its presence. **(verified)**

**[F04] The kind is already drawn; the word repeats the strip.** `arcTrackModel` reads `input.arcKind` into `model.planned`, and `TugArcTrack` chooses its cell set from it: `model.planned ? ARC_PHASES : DIRECT_PHASES` (`tug-arc-track.tsx:341`). A planned arc draws six cells including Devise and Review; a plain arc draws four. The word `planned` on the same line says what the two extra cells already say, and the cells say it in the strip's own register. **(verified)**

**[F05] The server arms `join_ready` on a stopped audit.** `wheel_live` is derived in `tugarc-core/src/ops.rs:1844` and `:2168` as *record exists, not done, no standing stop*. A stopped audit therefore reads `wheel_live = false`, and `join_ready` (`tugarc-core/src/log.rs:697`) takes its pre-wheel branch — `decls.run_complete || latest is Built | Audited` — where `run_complete` is true because the implement stage closed every step. The gate that reads "the audit's own declaration, and nothing else" is the `wheel_live` branch, which a stopped audit never reaches. **(verified)**

**[F06] The deck's register agrees, on purpose.** `arc-join-register.ts:336-345` holds the offer only while `run.stopped` is empty, and the test at `tugdeck/src/lib/__tests__/arc-join-register.test.ts:422` pins it: *"a stopped wheel does not hold the surface hostage"* — a run stopped as `stalled` in audit reads `Ready to join · ready`. The rationale is sound for a stop that is a person's act (`stopped by user`, `card taken`) and wrong for `audit did not mark`, where the stop *means* the code was never audited. The predicate's own comment on `audit_action` (`tugcast/src/feeds/arc.rs:759`) gives the reason for stopping rather than retrying as avoiding "an arc that offers its join wearing a word nothing earned" — and both layers then offer exactly that. **(verified)**

**[F07] The implement stage writes the join draft for a reason that stopped being true.** `arc-implement/SKILL.md` §2 and §3: *"closing the last step is the arming event, the server may raise the join offer the instant it lands, and a draft written afterwards is a draft racing the user's finger."* That was the ordering when implement was the last stage. Since [D169] every arc ends in audit, and under a live wheel `join_ready` arms on the `audited` declaration alone ([F05]); the final step's `done` arms nothing. The audit skill's §6 refreshes the draft conditionally — *"if the audit changed anything, it is now describing a tree that has moved"* — so the stage that read the whole diff cold and touched the tree last may leave the message written by the stage that never saw the audit. **(verified in both skills)**

**[F08] The stop in the screenshot was the known first-turn hole.** The audit stopped as `audit did not mark` mid-audit, which is F06 of `notes/arc-never-stops-brief.md`; its fix landed in `25aefdde3`, and the `Tug.app` running that arc was built before it. This brief does not re-fix the stop. It fixes what the row says about one. **(verified against the join's commit)**

---

## Decisions {#decisions}

**[B01] The phase is `audit`, and the key is the word.** `ArcPhase` becomes `"brief" | "devise" | "review" | "implement" | "audit" | "join"`; `ARC_PHASES`, `DIRECT_PHASES`, `ARC_PHASE_LABELS`, `ARC_PHASE_ICONS`, every `"check"` arm of `arcTrackModel`, and `arcPhase` follow. The comment that kept the key as `check` argued from the cost of renaming its readers; the readers are seven unit cases and two app-test selectors ([F02]), and the cost of keeping it is a note that says `check` beside a cell that says Audit. `data-phase="audit"` is what the strip emits and what `at0407` and `at0473` read. No CSS moves. The word `check` is banished from this vocabulary: it survives as an English verb in prose about verification and nowhere as a phase, a key, a label, or a `data-*` value.

**[B02] The note says the phase in the stage's own word, so a running audit reads `audit`.** With [B01], `arcLifecycleNote` and `arcPhaseWord` need no change of their own — they print the phase, and the phase is now spelled the way the stop reason, the register, the placard, and the wheel spell it. The arm that reads `check` for "arrived by git facts while the holder is still busy" reads `audit` too: on every arc the work after the last commit *is* the audit, or the seconds before it is seated.

**[B03] The kind word leaves the lifecycle line; the strip carries the kind.** `"kind"` joins `NOT_ON_THE_LINE`. The reasoning is [F04]: the strip already draws the kind as its cell set, so the word is a second spelling of a fact the eye has just read, and the only thing it adds is a stray adjective at the end of whatever the note said. The fact itself stays in `arcMetaFacts` — its tooltip, *"Devised a plan and had it reviewed cold before the first step was walked"*, is the one sentence that explains the extra cells, and the plan should move it to where that sentence is wanted: the Devise cell's own hover on the track, so a reader who wonders why one arc has six cells and another four gets the answer on the cell. `at0407`'s "the word" assertions flip: the planned row's line carries no `kind` span, and the cells are the whole statement. **A separator was considered and rejected**: `stopped · audit did not mark · planned` is grammatical and still puts a standing property of the arc at the end of a sentence about its present, which is the same awkwardness with punctuation.

**[B04] A stopped audit does not arm the join, on either layer.** Server: `wheel_live` stays what it is — it correctly says no stage is seated — and `join_ready` gains the fact it is missing: when the record's standing stop is in the audit stage and the latest declaration is not `Audited`, the arc is not ready. A stop whose reason is a person's act (`stopped by user`, `card taken`, `card closed`) is *not* excepted, because the fact is the same: the audit did not mark, whoever stopped it. Deck: the register's stopped-run arm distinguishes the stage. A run stopped in audit without an `audited` declaration reads phase `awaiting`, the caution pulse the register already defines as "work that has stopped for somebody", with the line `<arc>'s audit stopped — resume it, or land it unaudited` and the word `unaudited`. The test at `arc-join-register.test.ts:422` keeps its name and moves its case to a stop in implement, which is the case it was written for. The join stays *possible*: `/arc-join` still lands an unaudited branch, and the receipt says so. What changes is that the shade never calls it ready.

**[B05] The audit is the author of record for the join message; the implement draft is provisional.** `arc-audit` §6 rewrites the draft unconditionally: the audit has read the whole diff cold and is the last stage to touch the tree, so its message is the one that describes what lands, whether or not it changed a byte. `arc-implement` §2 and §3 keep writing a draft before the final step closes — an arc that stops before its audit still needs a message on the shade, and the implement session is the one that knows the argument the work rests on — but the *reason* is rewritten: the draft is provisional and the audit will replace it, and the arming event is the audit's mark, not the step's `done`. The words "racing the user's finger" leave the skill; the race they described cannot happen.

**[B06] Doctrine moves with the machine.** `tuglaws/arc-lifecycle.md` gains one sentence under the join: *a stopped audit never arms the join; the shade offers to resume it or to land unaudited.* [D169]'s "a `check` cell between implement and join" gets an amending clause naming the rename and this brief, rather than a rewrite. `arc-lifecycle.md` §"draft" says who writes the join message and in what order, per [B05].

**[B07] Pinned where each fact lives.** Unit: `tug-arc-track.test.ts` cases read `audit`; `arc-lifecycle-line` gains a case that a stopped audit on a planned arc renders the note and no `kind` span; `arc-join-register.test.ts` gains the stopped-audit case per [B04] and keeps the stopped-implement one; `tugarc-core/src/log.rs` gains a `join_ready` case for a record stopped in audit with `run_complete` true and no `Audited`. App: `at0407` and `at0473` read `audit`; one app-test drives an arc to a stopped audit and asserts the row reads `stopped · audit did not mark` with the word `unaudited` and no `Ready to join`.

---

## Open Questions {#open-questions}

- **Whether the Devise cell's hover is the right home for the kind's sentence, or the phase glyph's tooltip is.** [B03] chooses the cell because the cell is the thing the sentence explains. The plan's step should look at both hovers on the placard and the rail and pick the one that reads, without adding a third.

---

## Non-goals {#non-goals}

- **Re-fixing the audit's first-turn stop.** It landed in `25aefdde3` ([F08]). This brief takes the stop as given and fixes the sentence about it.
- **A separator between the note and the kind.** Rejected in [B03]: punctuation makes the sentence grammatical and leaves it saying the wrong thing in the wrong place.
- **Forbidding the join of a stopped audit.** The join is the user's act. The shade stops *offering* it as ready; it does not stop the user landing what they choose to, and the receipt records that the audit did not run.
- **Dropping the implement draft.** Considered; rejected in [B05]. An arc that never reaches its audit would land with a branch description or a fallback phrase, and the implement session's account of the argument is worth keeping as the audit's starting text.
- **Renaming the audit stage or its stop reason.** `audit` and `audit did not mark` are already the words everywhere but the strip's key. The strip catches up; nothing else moves.

---

## Exit {#exit}

**A plain `/arc`.** The work is a rename with its pins, one filter entry and a tooltip move, one guard on each layer of the join gate, two skill passages, and two law sentences. A task list carries it; nothing needs devising. The first tasks are the rename and its tests ([B01], [B02], [B07]), because every later screenshot reads the new word; then [B03]; then [B04] server-side with its `log.rs` case, then deck-side with its register case; then [B05] and [B06]; then the stopped-audit app-test last, since it needs the runner to produce a stopped audit on demand, which `tugtool arc stop` does.
