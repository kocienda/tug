# Arc quiet lines: the Task-step register

**Purpose:** An arc run narrates itself into the Session card as quiet lines — `arc-lexicon: run declared through step 15`, `arc-lexicon: step 1/15 started — Rename the crate …` — and every one of them is the same wheel over the same flat grey sentence, packed with no air between rows. The Task-step marker is an approved precedent for exactly this kind of row and reads far better; the user's ask (2026-09-03): "Inline dash quiet lines are good, but could use some styling work; model these on how we do Task steps." This brief charters that: the arc line takes the Task step's grammar — bold verb, muted subject, state in the glyph's shape, room around the row — without changing what it says.

---

## Purpose {#purpose}

The screenshot that prompted this shows two arc lines between two `Bash` blocks:

```
❋ arc-lexicon: run declared through step 15
❋ arc-lexicon: step 1/15 started — Rename the crate `tugdash-core` → `tugarc-core`
```

Same glyph, same weight, same colour, no gap between them and none from the block above. The only thing that says these are two different gestures is a run of grey words in the middle of each line. Directly beside them in the same transcript, a Task step reads `🔧 **Started** Rename the crate …` with a glyph that names the event and a verb you can find from across the room. The user likes that precedent and wants the arc lines brought onto it.

Two calls were made in the conversation and are recorded as decisions below: the per-gesture glyph shapes are **in** ([B04]), and the arc's name **stays on every row** ([B03]).

---

## Evidence {#evidence}

**[F01] Both rows already sit on the same substrate as the Task step.** The Task marker (`tugdeck/src/components/tugways/cards/blocks/task-inline-tool-block.tsx`) and both seats of the arc line — the between-turns seat `SessionArcNoteBlock` (`tugdeck/src/components/tugways/cards/session-arc-note-block.tsx`) and the mid-turn seat in `session-card-transcript.tsx` (`message.source === "arc"`, near line 1350) — compose `TugQuietLine` (`tugdeck/src/components/tugways/tug-quiet-line.tsx`). Nothing new is needed at the primitive level; the difference is entirely in how each caller fills the slots. **(verified — read all three)**

**[F02] What the precedent does, in three moves.** The Task marker passes `tone="primary"` (semibold label in the normal text tone, muted subject), puts the verb in the nowrap `label` slot and the task's subject in `subject`, chooses the glyph by state (`ListPlus` / `Wrench` / `CircleCheck` / `RotateCcw` / `CircleMinus` / `Pencil`) — "state by shape, not hue", the module docstring's own argument — and gives every row `margin-block: var(--tug-space-md)` (`task-inline-tool-block.css`). A run of same-verb rows folds into one (`TaskInlineRunBlock`). **(verified)**

**[F03] The arc line uses none of it.** Both seats pass `tone="quiet"`, one `ShipWheel` for all nine gestures, **no `label`**, and the whole server sentence in `subject`. The substrate's label/subject distinction — the thing the precedent's legibility rests on — is unused. **(verified)**

**[F04] The mid-turn seat has no styling at all.** The wrapper at `session-card-transcript.tsx` carries `className="session-card-transcript-arc-note"`, and that class matches no rule anywhere under `tugdeck/src` (`grep -rn transcript-arc-note src` finds only the TSX). No margin, no `user-select: none`. The between-turns seat's stylesheet (`session-arc-note-block.css`) has one rule, a `padding-inline-start` inset on `.session-card-transcript-quiet-row`. So the rows in the screenshot are welded to each other and to their neighbours by omission, not by design. **(verified — grep)**

**[F05] The verb is recoverable without a wire change — on one seat.** The server composes each sentence in `note_for_line` (`tugrust/crates/tugcast/src/feeds/arc_notes.rs:338`) from a marker plus parts, and renders a synthetic command from the same marker in `command_for_line` (`:392`): `arc create <name>`, `arc step <name> start --through`, `arc step <name> start|done|withdraw|reset|reopen`, `arc mark <name> built|audited`, `arc commit <name>`. The command is one-to-one with the marker and is already on every between-turns row as `message.command`. The deck already reads it there — `matchesArcNote` in `tugdeck/src/lib/arc-note-command.ts` is the regex both layers share. **(verified — read `arc_notes.rs` and `arc-note-command.ts`)**

**[F06] The mid-turn seat drops the command on the floor.** `SystemNote` (`tugdeck/src/lib/code-session-store/types.ts:199`) carries `text` and `source` only. `handleArcNote` (`reducer.ts` ≈6239) has `event.command` in hand — `ArcNoteActionEvent` (`events.ts:71`) carries it — and builds the note from `event.text` alone; `absorbArcNotes` (`reducer.ts` ≈6103) has `msg.command` and does the same. The seat in the screenshot is this one. Without the command it can only render the flat sentence. **(verified)**

**[F07] The sentence carries the name on every row and the title on the start row.** `note_for_line` prefixes `{arc}: ` to every sentence; a `step-start` carries the step's title as its tail ("the one thing the card cannot get from anywhere else while the step runs"), a `step-done` carries the round's sha, a round carries the verbatim instruction. **(verified)**

**[F08] The icon shapes exist.** `Wrench`, `CircleCheck`, `CircleMinus`, `RotateCcw`, `Undo2`, `GitCommitHorizontal`, `ListChecks`, `ShipWheel` are all exported by the installed `lucide-react` (1.21.0). **(verified — `lucide-react.d.ts`)**

---

## Decisions {#decisions}

**[B01] The arc line takes the Task step's grammar: bold verb in `label`, the rest in `subject`, `tone="primary"`.** This is the whole of what the precedent asks, and the substrate already spells it. The verb is derived from the synthetic command, not parsed out of the rendered sentence — a sentence is the server's output, and re-parsing prose the server composed is the wrong direction; the command is the marker, already durable in the shell ledger. The mapping:

| command | label | subject |
|---|---|---|
| `arc create` | **Arc opened** | — |
| `arc step … start --through` | **Run declared** | `through step 15` |
| `arc step … start` | **Step 1/15** | the step's title |
| `arc step … done` | **Step 1/15 closed** | the round's sha |
| `arc step … withdraw` | **Step 2/15 withdrawn** | the title, when carried |
| `arc step … reset` | **Step 2/15 parked** | the title, when carried |
| `arc step … reopen` | **Step 2/15 reopened** | the title, when carried |
| `arc mark … built` / `audited` | **Marked built** / **Marked audited** | — |
| `arc commit` | **Round 999353ca1** | the verbatim instruction |

One pure function beside `arcNoteSentence` in `arc-note-command.ts` produces `{label, subject}` from `(command, sentence)`, read by both seats — the same one-implementation rule the matcher regex already follows. A row whose command the function does not recognise (a ledger row old enough to carry only `dash …`, or a future marker) falls back to today's rendering: no label, the sentence in `subject`. Never a blank row.

**[B02] `SystemNote` gains an optional `command`, and both seating paths pass it.** [F06] is the one structural change and it is the load-bearing one: without it only the between-turns seat can split, and the seat the user photographed is the other. `handleArcNote` passes `event.command`; `absorbArcNotes` passes `msg.command`. The field is optional so every other `source` is untouched, and a restored note from before this change simply renders the fallback.

**[B03] The arc's name stays on every row.** The user's call (2026-09-03): "Why would we need to or want to drop the arc name from step rows? Keep them, eh?" The argument for dropping it was repetition — fifteen rows opening with the same word. The argument for keeping it is stronger: a transcript is scrollback read out of order, a `$`-route row is the one place the arc's record speaks with no header on it, and "which arc" is the first thing a reader landing mid-run needs. It moves, though: from a `name: ` prefix welded to the front of the flat sentence to **its own quiet run at the head of the `label` node, ahead of the bold verb**. `TugQuietLine.label` takes a `ReactNode`, so this is one `<span>` and one class in `session-arc-note-block.css`; the substrate does not change. Three weights, left to right: quiet name, bold verb, muted subject.

```
🔧  arc-lexicon  Step 1/15  Rename the crate tugdash-core → tugarc-core
```

The `label` slot is `white-space: nowrap`, so the name and the verb travel as a unit and the subject is what gives way — the right thing to lose.

**[B04] State goes in the glyph's shape, and the wheel signs the arc's life events only.** The user's call (2026-09-03): "Take the shapes for the tier-2 glyphs." Nine gestures on one `ShipWheel` is the wall the Task marker refuses, and the precedent's own vocabulary is there to be borrowed so the two registers rhyme:

| gesture | glyph |
|---|---|
| step started | `Wrench` (the Task step's own *Started*) |
| step closed | `CircleCheck` |
| step withdrawn | `CircleMinus` |
| step parked | `RotateCcw` |
| step reopened | `Undo2` |
| round | `GitCommitHorizontal` |
| run declared | `ListChecks` |
| arc opened, marked built, marked audited | `ShipWheel` |

The case against was that the wheel is *whose voice this is*. It survives on the rows where it reads as a signature on the run rather than a stamp on every line, and these rows keep the tell that matters: a bold verb with no participant header, which nothing else in the transcript wears. Icons stay muted — shape, not hue, per the precedent's docstring; colour is not spent here.

**[B05] Both seats take the Task marker's rhythm.** `margin-block: var(--tug-space-md)` and `user-select: none` on `.session-card-transcript-arc-note` (mid-turn, currently unstyled — [F04]) and on the between-turns row. Applied per row, not by adjacency, for the same reason the Task marker gives: a streamed row never hops as siblings append. This is the smallest change in the brief and, from the screenshot, likely the most visible.

**[B06] One renderer for the row, two seats.** Today each seat spells its own `<TugQuietLine …>`. With a label, a subject, a glyph, a name span, and a fallback, that is too much to keep in step by hand. The row becomes one small component (`ArcNoteLine`, in `session-arc-note-block.tsx` or beside it) that takes `{command, sentence}` and both seats mount it — the between-turns seat adds its hover title around it. The mid-turn seat then gets the hover title too, which it lacks today.

**[B07] The register's own tests pin the mapping.** The pure `{label, subject}` function and the glyph choice get unit tests beside `changeset-verb-store-arc-note.test.ts` / `reducer.arc-note.test.ts`: every marker in [B01], both heads (`arc` and the retired `dash`), the fallback for an unrecognised command, and the name-span. The seating tests already cover where a note lands; they gain the assertion that the seated note carries its command ([B02]).

---

## Open Questions {#open-questions}

- **Whether the between-turns seat's `padding-inline-start` inset survives as-is.** It exists so the standalone row lands at the same x as the mid-turn seat inside the body column ([F04], `session-arc-note-block.css`). Adding `margin-block` to the same row should not disturb it, but the devise round should look at both seats side by side once, in the app, rather than assume.

---

## Non-goals {#non-goals}

- **Dropping the arc name from step rows.** Proposed in the sketch, rejected by the user ([B03]). Stays rejected.
- **Changing what the server says.** `note_for_line` and `command_for_line` are untouched. The sentence's wording, the `{arc}: ` prefix in the wire text, the nine-gesture closed set — none of it moves. The deck reads the command it already has and re-arranges the sentence it already has. A wire or ledger schema change is out of scope.
- **Colouring the glyph by gesture.** The precedent's argument against it holds here at least as strongly — an arc run produces dozens of these rows.
- **The fold.** `TaskInlineRunBlock` exists because bulk sweeps stack same-verb rows into a wall. Arc rows are interleaved with the work they narrate, so there is no wall yet. Not built; noted so it stays deliberate.
- **The arc lifecycle line, the Arcs card, the Changes shade.** Different surfaces, different registers. This brief is the transcript's quiet line only.

---

## Exit {#exit}

**A plan**, small — this is an `/arc` shape rather than an `/arc-plan` one. There is no design left to settle: both forks were decided in conversation ([B03], [B04]), the substrate is in place ([F01]), and the one structural change is a single optional field ([B02]). The steps, roughly in order: the pure `{label, subject}` function and its tests ([B01], [B07]); the `SystemNote.command` field through both seating paths ([B02]); the shared `ArcNoteLine` renderer with the name span and glyph table ([B03], [B04], [B06]); the rhythm on both seats ([B05]); then a look at the two seats side by side in the app for the open question. An app-test that seats one note each way and asserts the label, the glyph slot, and the name span would close it.
