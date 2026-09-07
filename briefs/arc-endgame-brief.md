# Arc endgame: one row grammar for the fold, one line for the register

**Purpose:** The Changes shade's arc fold and the Arcs card's join register each invented their own way to set type and space rows, so the surfaces a reader reaches at the end of an arc do not look like the rest of the app. Settle them onto the grammar the commit receipt already uses.

---

## Purpose {#purpose}

The arc endgame is the stretch between an arc finishing its work and its landing: the Changes shade's fronted arc row with its `documents` · `report` · `draft` fold, and the Arcs card row that says whether the join is ready. Both were built section by section, and it shows.

The report, in the user's words:

> Changed files need to look *exactly* as they do in "regular" expanded Git commit sections. We use this style throughout the app. The arc summaries should not get a different style.
>
> When we group files into directories, we shouldn't be including so much *air* / margin between the content. This overall display must be *tighter*.
>
> The Documents, Reports, Rounds sections need a complete pass over them to adjust and refine their styling. There are too many different styles, sizes, and wandering baseline alignments here.
>
> The extra *Ready to join* affordance in the Arcs card looks out of place.

The spike `spike-arc-endgame` (`tugdeck/src/spikes/spike-arc-endgame.tsx`) staged today's fold beside a candidate and staged the Arcs card's register in several seats. The candidate and one register treatment were approved. This brief records what the spike measured and what it settled, so a plan can be devised from it.

---

## Evidence {#evidence}

Every measurement below was taken with `getComputedStyle` inside the running app, against the spike's two zones rendering the same fixture arc — the shipping components on one side, the candidate on the other.

**[F01] The fold sets three type sizes in pairings that contradict each other.** Measured in the shipping fold: the document row pairs a 13px sans title with 12px sans facts; the report pairs a 13px mono conflict path with 11px sans archaeology; the draft's cluster row pairs an **11px** mono directory path with **12px** sans facts. The draft's summary and subject are 13px. So the fold runs 11/12/13px, and which two sizes appear together depends only on which section wrote the row. **(verified)**

**[F02] On a directory row, the subordinate fact is set larger than the path it qualifies.** `tugdeck/src/components/tugways/cards/session-changes/session-changes-arc-brief.css` sets `.session-changes-arc-cluster-dir` at `--tugx-filerow-name-size` (11px) and `.session-changes-arc-cluster-facts` at `--tug-font-size-xs` (12px). The name of the thing reads smaller than the count describing it. **(verified)**

**[F03] `--tugx-filerow-name-size` is one step below the row grammar the areas were modelled on.** The token is defined on `body` in `tugdeck/styles/tugx-block.css:255` as `--tug-font-size-2xs` — 11px. The commit receipt's file rows are compact mono `TugListRow`s, which `tug-list-row.css` sets at `--tug-font-size-xs` — 12px. So the fold's areas, whose stylesheet comment says they borrow the receipt's size so the two cannot drift, are in fact a step smaller than the receipt's rows. **(verified — this corrects an earlier reading that the token was undefined; it is defined, and the defect is that it names a different size than the one intended.)** **(verified)**

**[F04] Row heights in the fold range from 17px to 28px.** Measured: a document row is 21px, a directory fold's head is 28px (it is a `TugPushButton` carrying its own `padding-block: 3px`, its own `line-height: 1.6`, and a negative inline margin to claw back its own padding), a file line under a cluster is 17px. The candidate's rows are uniformly 22px. **(verified)**

**[F05] The air is authored in three places that compound.** `session-changes-arc-lane.css` puts `gap: var(--tug-space-xl)` (16px) between the fold's sections; each section then hangs its content one `--tug-space-md` further in and adds its own internal `gap`; the cluster lists add `margin-block` of their own. Measured `gap` on `.session-changes-arc-detail` is 16px. **(verified)**

**[F06] Conflicts are painted in two different reds.** `session-changes-arc-join.css` sets `.session-changes-arc-join-conflict-path` to `--tug7-element-tone-text-normal-danger-rest`, while the lifecycle line's own trouble clause (`arc-lifecycle-line.css`, `[data-tone="danger"]`) uses `--tug7-element-tone-icon-normal-danger-rest`. In `brio` these resolve to different lightness and chroma — `l: 880, c: 160` against `l: 770, c: 340` — so one arc's conflict is stated twice in two tints, a line apart. **(verified)**

**[F07] The candidate holds to two sizes and one row height.** Measured across the candidate zone: every row is 12px with a 22px box; the only line above it is the draft subject at 13px. Prose, paths, and facts differ by face and tone, never by size. **(verified)**

**[F08] The Arcs card's register is a rail-band header mounted inside a list row.** `ArcJoinRegister` composes `BlockHeader` at `altitude="section"`, which `block-strip.css` gives the rail band's `sm` semibold name, a taller line box, and `--tug-space-sm`/`--tug-space-md` padding over the band's own surface. Inside a compact arc row, that reads as a pane header that fell into the list. **(verified)**

**[F09] The register's sentence for a ready arc is already one clause.** `arcJoinRegister` in `tugdeck/src/lib/arc-join-register.ts` returns `{ phase: "success", line: "Ready to join", word: "ready" }` for an arc with a standing candidate — the shortest of its readings, and the one that costs a whole line of chrome to say. The base branch is already in the derivation's input but absent from that line. **(verified)**

**[F10] The range diff descriptor cannot be scoped to paths.** `DiffDescriptor`'s `range` variant in `tugdeck/src/lib/git-diff-store.ts:204` carries `worktree`, `base`, `branch` and no `paths`, while `head` and `commit` both carry `paths?`. A per-file or per-directory pop-out inside an arc's fold therefore cannot open anything narrower than the whole range. Confirmed by the type error when the spike attempted it. **(verified)**

**[F11] The taxonomy test's spike pin was already stale on `main`.** `tugdeck/src/__tests__/card-taxonomy.test.ts` asserted fifteen spikes while `SPIKES` held fourteen — the commit that deleted the commit-failure-notice spike did not repin it. Repinned in passing while adding this spike. **(verified)**

---

## Decisions {#decisions}

**[B01] The whole arc fold is set in the commit receipt's row grammar — the compact mono `TugListRow` — and nothing in it invents a second one.** Every line under the arc block becomes that row: a 2ch leading cell holding a status mark, a glyph or an ordinal; the content column; a trailing cluster. This is what the report asked for in its first sentence, and it is what makes [F01], [F02] and [F04] impossible to reintroduce: there is one row, so there is one height and one size. Revisit only if a section is found that genuinely cannot be a row, which the spike did not find.

**[B02] The changed files are `ChangesFileRow` itself, not a lookalike.** The receipt's own row component, mounted directly, each expanding to its file's diff. A row that merely resembles the receipt's is a row free to drift from it, and drift is the defect under repair. This is what makes "exactly as they do in regular expanded Git commit sections" a true sentence rather than an aspiration.

**[B03] Two type sizes in the fold: the draft subject at `sm`, everything else at `xs`.** The `2xs` step goes entirely ([F03]) — it was a size below the grammar it claimed to borrow. Distinctions that used to be carried by size are carried by face and tone instead: a path is mono, prose is sans, a fact is muted. Sizes are what wander; faces and tones do not.

**[B04] A directory is a row of the same grammar, and its trailing cluster is ordered counts · pop-out · fold.** A folder glyph in the mark cell, the directory path, its facts, then the same three trailing controls every file row carries in the same order. The last control on any row is the one that acts on it — a fold cue where something folds, an open cue where something opens — so the rightmost position always means "do the thing this row is for".

**[B05] The totals line is a row, and it is the fold for the whole file list.** `31 files · 4 rounds · 4/6 steps` sits in a row with the range's ± counts and the range pop-out, and its fold cue collapses every file row beneath it — the same relationship a commit receipt's header has to its file list. This replaces the separate stat strip and the `N more areas` reveal with one gesture in one place.

**[B06] Air comes from the rows and from the section eyebrow, and from nowhere else.** The fold's `--tug-space-xl` inter-section gap goes, as do the per-section content hangs and the nested lists' block margins ([F05]). A row's separation is its own 1px of block padding; a section's separation is `TugSectionLabel`'s own `margin-top`, which already exists to do exactly this job. This is the whole of the answer to "this overall display must be tighter".

**[B07] One danger tint for a conflict, and it is the darker one — `--tug7-element-tone-icon-normal-danger-rest`.** The path, its glyph, and its `conflicts with main` fact all take it, which puts the fold's conflict in the same red as the lifecycle line's trouble clause one line above ([F06]). One fact, one colour.

**[B08] The Arcs card row loses its third line: a ready arc says so in the lifecycle line's own reading.** The register's band is not restyled, moved, or quieted — it is not mounted at all for this state. The line's reading becomes `Ready to join to <base>`, naming the branch off the entry rather than spelling it, and the phase glyph gives way to the lifecycle dot settled green. The dot is the same `TugProgressIndicator` every tool header settles on, so the arc's readiness is stated in the app's existing vocabulary for "this finished well" instead of a strip of its own. This decides the Arcs card only — see the open questions for the shade and the composer.

**[B09] The arc block's eyebrow is untouched.** Arc atom, hairline, worker atom, trailing controls, exactly as `ArcLifecycleBlock` draws it today. The eyebrow is the identity line the whole app has learned, and nothing in this work has an argument against it.

**[B10] `ArcLifecycleLine` gains a mark override beside its existing note override; the spike's hand-composed block is not what ships.** The spike assembles the block's spans by hand only because the line has no seat for a mark that is not the phase glyph. The component takes that seat — one optional prop, in the same shape as the `note` override it already has, so the receipt row's precedent covers it — and every caller keeps composing `ArcLifecycleBlock`.

**[B11] `DiffDescriptor`'s `range` variant gains `paths?`, so a row's pop-out opens that row's diff.** Without it ([F10]) the per-file and per-directory pop-outs in [B04] open the whole arc range, which makes the control a lie about its own row. The `head` and `commit` variants already carry the field; this is the range variant joining them, plus whatever the server-side range diff needs to accept a pathspec.

**[B12] Grouping by directory stays, and it is not a user-facing toggle.** The spike's `Group by directory` control existed to let the two shapes be judged side by side. Grouping is the shipping shape: `clusterArcFiles` already answers what the change is made of before a path is read, and the report's complaint was about the air around the groups, never the grouping.

**[B13] What the fold says does not change — only how it is set.** Every fact currently rendered still renders: the documents and their review state, the blockers and their remedies, the resolution ladder's progress and its account, the conflicts and their archaeology, the draft's subject, summary, areas, rounds and full message. This is a presentation pass, and any change to the facts is out of scope for it.

---

## Open Questions {#open-questions}

- **What the Arcs card row shows for the register's other states.** [B08] settles the ready state, which is one of eleven readings `arcJoinRegister` derives — the others include `blocked`, `reconciling`, `joining`, `question`, `stuck`, `working` and `auditing`, several of which carry a pulsing or caution phase and a sentence much longer than `Ready to join`. Whether they all fold into the line, whether some keep a band, and what happens to a sentence that will not fit the line's width, is the substantial design question this spike did not stage. It cannot be settled by reading the code because it is a judgment about which states deserve their own row.

- **Whether the shade's arc row and the composer take the same collapse.** Both mount `ArcJoinRegister` today, and the whole argument for the register is that all three surfaces read one sentence from one derivation. If the Arcs card's row stops mounting it and the other two do not, the surfaces diverge — which may be right, since the shade is the surface a reader came to read and the composer is where the press happens. Needs a look at all three together.

- **Whether the server's range diff can take a pathspec at all.** [B11] assumes it can. If `tugcast`'s range diff genuinely cannot be scoped, the per-row pop-outs in [B04] need a different answer — most likely dropping the pop-out from directory rows and keeping it on the totals row alone.

---

## Non-goals {#non-goals}

- **Restyling the join register's derivation.** `arcJoinRegister` stays the one place the sentence and the word are decided, and no surface composes its own. [B08] changes where a reading is mounted, never what it says.

- **The transcript's join and commit receipts.** `SessionCommitReceiptBlock` and `SessionJoinReceiptBlock` are the grammar this work is moving *toward*; they are not themselves under repair here.

- **The register as a de-banded third line (spike treatment B).** Rejected. It kept the row's third line and the reader's eye still had two places to look for one fact; removing the band made it quieter without making it fewer. The line's own reading is strictly better because it is one line instead of two.

- **The state as a one-word badge on the eyebrow (spike treatment C).** Rejected. `ready` on the eyebrow says the state and says nothing about what to do next or what it would join onto, and it puts a state reading on the line whose subject is identity — the same argument `ArcLifecycleBlock`'s own docblock already makes about the phase glyph.

- **A filter or search inside the fold.** The fold is a briefing, and a set that needs searching is one the pop-out should open in a card.

- **Changing which arcs the lane lists, or any of its verbs.** Binding, discarding, replaying and joining are all untouched.

---

## Exit {#exit}

**A plan**, devised against this brief.

Its natural first phase is the fold, because it is self-contained and the largest share of the complaint: one row component under `session-changes/`, `SessionChangesArcDocuments` / `SessionChangesArcJoin` / `SessionChangesArcBrief` rewritten onto it, the three stylesheets collapsed to one, and [B03] / [B06] / [B07] applied as it goes. The `--tugx-filerow-name-size` reading in `session-changes-arc-brief.css` disappears with the file.

The second phase is the Arcs card, which is smaller but has a dependency the fold does not: [B10]'s mark override on `ArcLifecycleLine` has to land before `arcs-card.tsx` can stop mounting the register, and the open question about the register's other states should be settled before either. [B11]'s descriptor change is independent of both and can be sequenced wherever it fits.

The phase boundary is the natural checkpoint: the fold can land, be looked at in the real shade against a real arc, and be joined on its own, with the Arcs card following.

The spike stays mounted until the plan lands, since it is the only place the two treatments can be compared. It is deleted on graduation — `tugdeck/src/spikes/spike-arc-endgame.tsx`, its stylesheet, its two registry lines, and the taxonomy pin — with whatever of [B01]–[B07] proves durable moving to `tuglaws/`.
