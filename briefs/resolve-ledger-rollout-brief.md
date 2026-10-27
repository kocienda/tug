# The Resolve Ledger: roll the spike out to the Changes shade and the transcript

**Purpose:** The Changes shade's REPORT section under a reconciling arc is a centred alert, a clipped register badge, a doubled DOCUMENTS list and a 12px spinner, over a resolve pipeline that knows a great deal and says almost none of it. The `resolve-ledger` spike (landed as `299bf271e5`) settled what it should look like and what has to change behind it; this brief carries those calls into the codebase.

---

## Purpose {#purpose}

The user's opening words: the conflict-resolution interface in the Changes shade when running arcs "needs *substantial improvement*". The specific complaints, in order of arrival:

- The alert content is centred; it must be left-aligned.
- The "reconciling" register label is clipped on the right.
- "Far too little information" is shared about the resolution work.
- The DOCUMENTS section is confusing, with doubled-up rows wearing the same title.
- The "teeny-tiny" spinner should be retired for a transcript of resolution steps, using the thinking-wave animation.
- On the second pass: the `brief`/`plan` role labels are too small; DOCUMENTS should read like a commit receipt (mono, paths); REPORT should be modelled on the transcript's tool blocks, not custom bullet rows; the ASKING step must not smash button labels together; RESOLVE AGAIN belongs at lower right; "UNDO THE FOLD" is confusing and should be an inline dialog offering accept or undo. "Improve the design — but ALSO the behavior."
- Then: the *base-motion* notice that appears in the transcript while running arcs must move from an accented quote bar in proportional type to a git-commit-receipt-style block.
- Throughout: "We have *components* for these things. USE THEM!"

The spike answered the design. This brief is the hand-off from spike to product.

---

## Evidence {#evidence}

**[F01] Centring comes from the inline dialog primitive, not the shade** — `tugdeck/src/components/tugways/tug-inline-dialog.css` sets `.tug-inline-dialog-description { text-align: center; margin: -0.2rem auto -0.7rem; max-width: var(--tugx-idialog-options-max-width) }` (435px). The blocker sheet in `session-changes-arc-join.tsx` puts its file list, sentence and remedy in that description slot and inherits the centring. The same file's body slot already insets by `--tugx-idialog-content-inset + --tugx-idialog-content-nudge` to sit under the title text; the description slot does not. **(verified)**

**[F02] The register badge clips because the register root hides overflow** — `session-changes-arc-fold.css` sets `overflow: hidden` on the register root (lines 107 and 122), and the block header's trailing cluster is a float one line tall that the register badge overflows. The spike's one-line fix, `overflow: visible` on `.tug-arc-join-register`, paints the row whole. **(verified in the spike)**

**[F03] DOCUMENTS doubles the title because both documents share one H1** — `tugarc-core/src/ops/documents.rs:303–308` reads a document's title as the first line starting with `#`. An arc's brief and plan both open with the arc's title, so the shade draws two rows that differ only in a role word the reader has to find. **(verified)**

**[F04] The spinner is a 12px lucide `LoaderCircle`** — `session-changes-arc-join.tsx:576`, mounted for the whole of a resolve and carrying no words. **(verified)**

**[F05] Rungs 1–4 of the ladder emit no deltas, and the scribe rung has no terminal delta** — `tugcast/src/feeds/join_resolve.rs` broadcasts `changeset_join_resolve_delta` (its Spec S12 frame) only around the async scribe run; the clean squash, replay probe, salvage, rerere, `git merge-file --zdiff3` and driver rungs in `tugarc-core/src/resolve.rs` resolve files and record `ResolvedBy` (`record_resolved_rung`, line 1795) without a frame reaching the deck. A resolve that the machine rungs settle entirely shows the spinner from press to result with nothing under it. **(verified)**

**[F06] The resolver's stream-json is discarded** — `tugcast/src/feeds/join_resolver.rs:485–534`, `drive_claude`, reads `--output-format stream-json` and skips every frame whose `type` is not `result` (line 524). Assistant text, tool names and the question's framing never leave tugcast. **(verified)**

**[F07] The deck already holds facts it never draws** — `ArcJoinStateWire` on the CHANGESET_ALL feed carries `archaeology[]`, `candidate` (the sha at `refs/tug/join/<name>`), `conflicts[].what_each_side_did`, the question's answer, per-file diff counts, and the scribe's text, which the store keeps and the shade does not render. **(verified by reading `lib/changeset-types.ts` and the shade; the scribe text is stored at the reducer and has no consumer)**

**[F08] "Resolve again" is a sentence with no control** — the stale note (`session-changes-arc-join.tsx:447–453`) tells the reader to decide whether to resolve again, and nothing on the shade re-runs the ladder. Today only the pilot's head-pair mark re-resolves a stale candidate. The CONTROL verbs in `tugproto/src/control.ts:52–55` are `changeset_join_resolve`, `changeset_join_resolve_base`, `changeset_join_resolve_base_undo` and `changeset_join_question_answer`; there is no re-run on a stale candidate distinct from the first resolve. **(verified)**

**[F09] The fold receipt offers only undo** — after `changeset_join_resolve_base` commits the base holder's work in progress, the shade shows a receipt with one control, UNDO THE FOLD, which the user read as confusing: it reads as a warning rather than a result, and there is no way to say "yes, keep it" and retire the receipt. **(verified in the shade; the reading is the user's)**

**[F10] The ASKING step overlapped its button labels** — `tug-inline-dialog.css` fixes every action button at `--tugx-idialog-action-w: 5rem`; a question whose options have long labels overflows the cluster. The shipped `QuestionWizard` (`chrome/session-question-dialog.tsx`) with `joinQuestionAsParsed` lays options out as a stack and does not have the problem; the spike mounts it inside the resolver block and it reads correctly. **(verified in the spike)**

**[F11] The base-motion notice is prose in a quote bar** — `tugcast/src/feeds/base_motion.rs:279` composes `Arc "<name>" was replayed onto <base> at <sha> while you were between turns.` plus a column of bare paths, and sends it as a `tug_notice`, which the deck's session store (`lib/code-session-store/reducer.ts`) renders as an accented system note in proportional type. A replay is a commit-shaped fact (a sha, a sentence, a file list) and the transcript already has the commit receipt chrome for exactly that shape. **(verified)**

**[F12] The spike composes only shipped primitives** — `tugdeck/src/spikes/spike-resolve-ledger.tsx` renders the six moments (`blocked|folded|resolving|asking|stale|resolved`) with `BlockChrome` (variants `tool` and `receipt`), `BlockNoticeBand` carrying `TugProgressIndicator variant="wave"` as the live band, `ToolResultSummary`, `TugSectionLabel`, `ArcFoldRow`/`ArcFoldCell`, `TugBadge`, `TugInlineDialog`, the shipped `QuestionWizard`, and, for the blocked moment, the real `SessionChangesArcJoin` over a fixture entry. Its CSS is ~200 lines, all token-based, and every rule is a candidate to move into the shade's own stylesheet. `tsc`, `vite build` and the card-taxonomy test are green at `299bf271e5`. **(verified)**

---

## Decisions {#decisions}

**[B01] The REPORT section becomes a ledger of blocks, one per thing the resolve did, in the transcript's tool-block chrome.** Probe, Ladder, Scribe, Resolver, Audit and Candidate are each a `BlockChrome` block with a prose identity line, a `ToolResultSummary`, and a body of fold rows or words. The chrome already answers every question the spike asked of it (in-flight dot, phase/status colouring, notice bands, receipt insets), and the user's instruction was to use the components that exist. A custom bullet list was tried in the spike's first pass and rejected as "all off".

**[B02] The live block carries the thinking wave in a notice band; the spinner is retired.** `BlockNoticeBand tone="progress"` with `TugProgressIndicator variant="wave" state="running" role="inherit"` as its icon, at the standard size and in the band's own text colour, on whichever block is in flight. The chrome's leading dot stays the in-flight signal; the wave is never put in the leading slot (tried, oversized, rejected). The `LoaderCircle` import goes.

**[B03] Every rung reports a delta, and the scribe rung reports a terminal one.** Each rung of the ladder in `tugarc-core::resolve` emits `changeset_join_resolve_delta` as it is tried, declined (with its one-line reason) or resolves (with counts), so the Ladder block fills in as the ladder runs rather than appearing as a result. Without this the design is a prettier spinner: [F05] is the reason the shade has nothing to say today.

**[B04] The resolver's stream is relayed, not dropped.** `drive_claude` forwards assistant text and tool names per turn as deltas that become the Resolver block's body. The question, when asked, is the shipped `QuestionWizard` mounted in that body via `joinQuestionAsParsed`, as the spike mounts it, and the answer is drawn once given ([F07]). The multi-turn resolver is the step a reader most wants to watch and the one whose output tugcast currently throws away ([F06]).

**[B05] The ledger is durable.** Blocks are written as the resolve goes, beside the checkpoints already landing on `refs/tug/conflict/<name>`, so a reload mid-resolve and a second deck read the same blocks. Deltas alone would make the ledger a property of whichever deck happened to be listening; the join's history is a fact about the arc.

**[B06] A fold is answered, not only undone.** The resolve-base receipt becomes a `TugInlineDialog` with `iconRole="success"`, a sentence saying what was committed and for whom, and two acts: Keep (primary) retires the receipt; Undo (outlined) is `changeset_join_resolve_base_undo` as it exists. "Undo the fold" as a lone control goes.

**[B07] Resolve again is a verb.** A CONTROL that re-runs the ladder on a stale candidate, offered as a button at the lower right of the stale moment, replacing the sentence that has no control behind it ([F08]). The existing head-pair re-resolve the pilot performs is what the control invokes; the work is exposing it to the shade.

**[B08] DOCUMENTS reads as a receipt's file list.** One `TugSectionLabel` whose qualifier is the arc's title, said once, then one row per document: a `TugBadge` role (`brief`, `plan`) at the row's text size, the path in mono relative to the checkout (`.tug/arcs/<name>/brief.md`), the fact at the trailing edge (`5 of 5 done`) with the pop-out. The title lives on the label so [F03] cannot double it, and the role cell widens to the longer word so both paths start on one column.

**[B09] Sheets are left-aligned, and the icon sets the left edge.** The blocker sheet's and the fold receipt's description take `text-align: start`, no centring margin, no options-width cap, and the same content inset the dialog's body slot already uses, so the file list, the sentence and the remedy start under the title text. The blocker's path rows drop their empty leading `ArcFoldCell` and the compact list row's inline padding so a file name stands on that edge too. This is scoped to the fact-sheet uses of `TugInlineDialog` by class, not changed on the primitive: a permission prompt is still centred by design.

**[B10] The register paints whole.** `overflow: visible` on the register root ([F02]), and the trailing badge sized so it does not depend on the float's one-line height.

**[B11] The base-motion notice becomes a commit-style receipt in the transcript.** A `BlockChrome variant="receipt"` block named "Replayed", identity `^arc onto main at <sha> while you were between turns`, summaries for the file count and the round count, an info notice ("No action is required. Re-read any file you were holding before editing it."), and a body of mono path rows. The stopped case is a sibling "Replay stopped" block in error phase with a warning notice, the colliding path in danger tone and the three commands to recover (`git -C .tug/worktrees/<arc> rebase main`, `tugtool arc replay <arc> --json`, `tugtool arc verify <arc>`) as numbered rows. The `tug_notice` payload gains the structured facts (arc, base, sha, paths, rounds, outcome) so the deck draws the receipt from data rather than parsing the sentence.

**[B12] The spike's CSS migrates into the shade's and the receipt's stylesheets and the spike is deleted when the rollout lands.** A spike that outlives its product is a second copy of the design that drifts; `spike-resolve-ledger.{tsx,css}` and its registry line go in the same change that lands the last moment.

---

## Open Questions {#open-questions}

- **Does the ledger also become the join's transcript receipt?** Today the join lands a receipt block in the transcript when it completes. If the durable ledger ([B05]) holds every block of the resolve, the transcript receipt could be a fold of the same blocks rather than a separate rendering. Settling it needs the join-receipt block's owner to say whether two renderings of one record are wanted; it does not block the shade work.
- **Where the durable ledger lives.** Beside the conflict chain as notes on `refs/tug/conflict/<name>`, or as a file in the workshop worktree `.tug/workshops/<name>`. The first survives a workshop teardown, the second is simpler to write as the resolve goes. The implementer should read `workshop.rs` and `join_resolver.rs` checkpointing before choosing; either satisfies [B05].

---

## Non-goals {#non-goals}

- **Changing `TugInlineDialog`'s default centring.** Permission prompts and wizards are centred on purpose. The left-aligned treatment is a class-scoped override for fact sheets ([B09]).
- **A hand-rolled question UI.** The spike's first pass drew the question as a `TugInlineDialog` with option buttons and was rejected ("USE THEM"); the question is `QuestionWizard` and nothing else.
- **A custom row component for REPORT.** Rejected in the spike's second pass; the ledger is `BlockChrome` and the fold rows that exist.
- **Reworking the resolve ladder's rungs or their order.** The ladder's logic is unchanged; the work is making it report ([B03]).
- **Fixing the CLI help for `arc resolve-base`.** It says a foreign edit "is refused by name" while the code folds it. Real, noticed during the investigation, and a one-line doc fix that belongs in its own change rather than in this arc's scope.
- **Polling or timers to animate the live band.** The wave runs on the in-flight block from the delta stream; nothing ticks.

---

## Exit {#exit}

**An arc.** The shape, in the order the pieces must land:

1. The shade's visual fixes that need no wire change, taken straight from the spike: left-aligned sheets with the icon-set edge ([B09]), the register overflow ([B10]), DOCUMENTS as a receipt list ([B08]), the fold receipt with Keep and Undo ([B06], Keep is deck-local), and the REPORT section as `BlockChrome` blocks drawn from the facts already on the wire ([B01], [B02], [F07]), with the spinner retired.
2. The wire: deltas from every rung and a terminal scribe delta ([B03]); the resolver stream relayed ([B04]); a resolve-again CONTROL ([B07]); the structured base-motion notice ([B11]). Each extends `ArcJoinStateWire` or the `tug_notice` payload and is consumed by the blocks from step 1.
3. Durability ([B05]), once the delta shapes from step 2 are settled, so what is persisted is what is drawn.
4. The base-motion receipt block in the transcript ([B11]), replacing the quote-bar rendering.
5. Migrate the spike's CSS, delete the spike and its registry line ([B12]).

Each step is verifiable with `bunx tsc --noEmit`, `bunx vite build`, the session-changes and code-session-store unit suites, and the tugcast/tugarc-core nextest suites for the wire steps; the app-test selection is derived from `@covers` as usual.
