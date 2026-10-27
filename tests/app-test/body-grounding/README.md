# The body view grounding bar

One file per row of the bar in `briefs/body-view-grounding-brief.md` ([B02]).
A row is green when its test passes **on the app's own path** and a reading on
the real app agrees. Every card is a body; there is no switch.

## The path these tests take

- **Keys go through AppKit's own routing, to a real key window.** Every file
  here launches in pid mode, where the app believes itself active and the
  harness window is really key (`TugApplication` in `tugapp/Sources/main.swift`,
  under `AppDelegate.harnessPidMode`), so `nativeKey` and `nativeType` post to
  this process and enter `-[NSApplication sendEvent:]` as the same `NSEvent`
  the user's keyboard makes — through AppKit's key-equivalent scan, the key
  window's view-then-menu order and the first responder's page, with nothing
  activated and the user's keyboard untouched. The one hop not simulated is
  WindowServer choosing the destination process, which `postToPid` chooses
  instead of frontmost; no in-process code can tell the two apart, so a row is
  green on AppKit's own routing with a real key window and first responder.
  Two files still take the screen, each with its reason in its header beside
  `@foreground`: `row-12-composer-session-panel`, because the host's open
  panel is a remote service only WindowServer delivers keys to, and
  `row-27-drop-into-body`, because a drag is a real `NSDraggingSession` that
  moves the user's cursor and WindowServer picks its destination.
- **Menu commands are performed, not dispatched.** `app.performMenuItem(id)`
  finds the real `NSMenuItem`, validates it as AppKit does at open, and sends
  its action through `NSApp.sendAction`, so validation, the action and
  `sendControl` all run.
- **The effect is asserted where it should land.** A body's DOM, the shell's
  store, the pasteboard, the host's body snapshot — never the delivery of an
  event. `lab.dispatch`, DOM `keydown` synthesis and a `sendControl` from the
  test are not evidence for a keyboard or menu row.
- **Frames are compared by surface colour.** A composite window capture is read
  against the body's own surface colour and the shell's chrome colour, never an
  ink share, which the canvas grid satisfies through an empty placeholder. A
  row that must hold at *every* frame arms `app.captureBurst` over the rect —
  the composited window every 16–33 ms, cropped and written as PNGs — and
  classes each frame's pixels with `_frames.ts`: the pane surface (the lid, or
  the body on it), the canvas floor (the host's, beneath the bodies), its grid
  line, the bare window background,
  or content. An open hole with nothing beneath it is canvas-coloured paint
  with none of the floor's grid in it.

## The rows

Each row names the card kinds it is run against. Every kind moves to a body
by its registration, and arrives here with its own column; until then a row
is read for the Session card alone.

Each row runs for one card of each placement shape: the Session card for a
content card, the Overview for a pinned rail. The rows test the body
machinery, which does not know which card a body holds, so a kind that moves
proves itself in its own kind check rather than by running every row again;
`_kinds.ts` names the representatives, and `TUG_BODY_KINDS` runs a row
against any kinds named.

No file runs past 20 s, so a row that needs more than one launch is split
one launch per file: `_row-NN.ts` holds the row's helpers and runners, and
each piece is a `row-NN-<name>-<piece>.test.ts` carrying `@family
row-NN-<name>`. A piece that reads the way back makes the way out first as
its unmeasured set-up (`_motion.ts`'s `setUpGesture`). The table names a
split row by its pieces' glob.

| File | Row | Session | Overview |
|---|---|---|---|
| `probe-tap.test.ts` | The path itself: one character through the activated tap lands in a body's composer; one menu item performed takes effect in the body. | ✓ | — |
| `row-01-arrival-*.test.ts` (warm, cold, kinds) | ⌘N: a new card arrives with nothing of the canvas, grid or an older pane showing through the hole at any frame, cold and warm. | ✓ | ✓ |
| `row-02-drag-kinds.test.ts` | A card drags as one piece: masthead, frame and content together under the pointer, landing together. A card that draws its own chrome — the Session card and the rail kinds — drags as one view the host carries, read by the same invariant (`one-view-drag.ts`): the chrome and the content stand the chrome's height apart on every frame, or for a rail, whose bar and content paint one surface, the card's leading edge stands in one column on a row through the bar and one through the content. The Session card's drag is `at0744-card-drag-is-one-view`; this row reads every other kind. | ✓ (`at0744`) | ✓ |
| `row-03-departure.test.ts` | A card departs as one piece, and the hole closes with it. | ✓ | ✓ |
| `row-05-chords-*.test.ts` (edit, turns, deck, text, overview) | Every chord in the keyboard files works from a body and from the shell. | ✓ | ✓ |
| `row-06-menus-*.test.ts` (each menu part, Session and kinds; the two `-shows`) | Every Swift menu command works with a body first responder, including the ones validating against the first responder's undo manager. | ✓ | ✓ |
| `row-07-focus.test.ts` | Activating a card makes its body first responder; typing goes there and nowhere else; the shell's surfaces take and return focus; closing the key card hands focus on. | ✓ | ✓ |
| `row-08-sheets.test.ts` | The Changes shade, the history view and the find bar open, list, scroll and close from a body. | ✓ | n/a: no sheet |
| `row-09-fold-*.test.ts` (fold, unfold) | Fold hides the body; the unfold shows it with no peek. | ✓ | n/a: a rail does not fold: `setPaneFolded` refuses one |
| `row-10-workspace-*.test.ts` (session and kinds, home and away) | A workspace switch shows and places every arriving body and hides every departing one, with no frame showing a body in the wrong place. | ✓ | ✓ |
| `row-10-workspace-*-dormant.test.ts`, `row-10-workspace-*-evicted.test.ts` | Row 10's four switches with every hidden body put dormant, or dormant and then evicted, before the switch (`_tiers.ts`): the same bars, held against bodies that hear nothing and against cards with no page. Rows 14 and 19 have no tier variant: at their gestures the host holds no hidden body. | ✓ | ✓ |
| `row-11-lifecycle.test.ts` | Close, close all, reload and quit: no body outlives its card; every page saves and terminates under the deadline. A dirty Text body asks in its own page before its pane closes and before a Cards body's workspace delete, and Cancel keeps both. | ✓ | ✓ |
| `row-11-draft-tiers.test.ts` | A draft typed in a Session card whose workspace is then parked: once its body is dormant the card's bag on disk carries the draft, and after the body is evicted the card shown again has it in its composer. | ✓ | n/a: Session-only by construction |
| `row-12-composer-*.test.ts` (session-send, session-panel, kinds) | Z2, the composer, paste of text and images, and the picker-to-body handoff. | ✓ | ✓ |
| `row-13-arc-tracking.test.ts` | An arc bound to a body's session reads in that body's Z2, on the shell's masthead and in the Arcs body, which follows the Session card focused before it and offers Bind to its session. The stores a body attaches are enumerated by `tugdeck/src/body/__tests__/body-stores.test.ts`. | ✓ | n/a: the Overview has none of it |
| `row-14-beats-move-*.test.ts` (kinds and flow, out and back; stack) | A gesture that only moves body cards (the flow slide out and back, a cross-column stack move) carries each body with its chrome on the host: the lid stays lifted, the content box never shows the floor, the presented container tracks the placeholder, the render server advances it every tick, and it lands on the placeholder to the pixel. | ✓ | ✓ |
| `row-17-crossing-*.test.ts` (bullseye, sidebars and kinds-resize each way; new-card; split) | Bullseye, a column split and a new card beside the body card (⌘N's action) carry it with its chrome, to a new size where the box changes: `crossingReady` within a display period of the first moving beat, the content box and its bottom strip never the floor, the transcript pinned to its bottom before and after. The content box's top corners are not read square: the Session card draws its own masthead inside its page, so its box begins at the pane's top edge and its top corners are the pane's rounded ones, where the canvas shows — the check, restored and run on the base, read the top-left corner half canvas and half the focused pane's accent border. The guarantee it held, no rounding between a masthead and the content under it, has no masthead above the box left to hold against. Each leg asserts the settle is over before it judges the settle's frames. The row judges the plan that carried the card, which a settle re-armed mid-tween may follow with one that plans nothing. | ✓ | ✓ |
| `row-19-streams-*.test.ts` (flow-out, flow-back, stack) | A body streams through the shell's settle: every body applies a batch between the motion gate's close and open, and none is parked, across a flow slide and a cross-column stack move. | ✓ | n/a: Session-only by construction |
| `row-21-edges-*.test.ts` (session, kinds) | A body card's side edges are the pane's border and nothing else, read beside a Text card's at zoom 0.8, 0.9 and 1.0, with each card key. | ✓ | ✓ |
| `row-22-compaction-cover.test.ts` | A body's Compacting cover rests on the rest line above Z2, as the in-document card's does, not at the top of the transcript. | ✓ | n/a: Session-only by construction |
| `row-23-tab-edge.test.ts` | A body card's walk runs off its edge into the shell and comes back, by Tab and ⇧Tab and by the View menu's Next and Previous Keyboard Focus, with the body holding the keyboard at every step. | ✓ | ✓ |
| `row-24-focus-through-motion.test.ts` | The key body keeps the keyboard through a settle that carries it on the host, and what is typed during the motion lands in it. | ✓ | n/a: Session-only by construction |
| `row-25-in-card-surfaces.test.ts` | The completion popup, the composer's context menu and the route badge's report draw whole inside the body, where its DOM says they are. | ✓ | ✓ |
| `row-26-deck-scope-surfaces.test.ts` | What a body raises past its content box the shell draws: the Z2 placard over the deck, its buttons reaching the body, and `/logout`'s confirm. | ✓ | n/a: raises no deck-scope surface |
| `row-27-drop-into-body.test.ts` | A drag over a body is the body's: a file from outside the window and a jot dragged from the Jots body both land in its composer, and neither the shell's page nor the Jots page takes the drop. | ✓ | n/a: the Overview has none of it |
| `row-28-deck-facts.test.ts` | A body follows the focus-ring modality live, and the shell's held modifiers land on its root, with the shell key, the body key and across a hand-off. | ✓ | ✓ |
| `row-29-voiceover-order.test.ts` | VoiceOver reads the shell, then each showing body in deck order, whichever pane stands in front. | ✓ | ✓ |
| `row-32-overview-insert.test.ts` | The Overview's Insert into Prompt lands an atom in its own composer, in its body; the post reaches the body through the ledger. | — | ✓ |
| `row-33-arrangement.test.ts` | The Cards and Layout bodies read the shell's arrangement and act on it through the shell: the Layout row press and window drag reach the shell's deck and come back; the Cards body's session rows, row ×, new workspace, go-there and the menu's delete confirm all reach the shell. Each leg is also its card's kind check. | — | n/a: the arrangement cards' own row |
| `row-35-dormancy.test.ts` | A body hidden past its delay goes dormant and hears nothing of its session; shown again, it catches up on what it missed and wakes, and the reveal's stale window is read against the display period. | ✓ | n/a: Session-only by construction |
| `row-35-dormancy-lineage.test.ts` | A card holding a lineage's turns above its own session's — which its session does not count — goes dormant mid-turn and, shown again, catches up on exactly the turn it missed: the catch-up names the turns the card holds rather than an index it reconstructs, so the ancestors cannot push it past the session's end, and no turn it held comes back twice. | ✓ | n/a: Session-only by construction |
| `row-35-dormancy-open-bracket.test.ts` | A body that sleeps inside a replay bracket — a page of older turns it asked for, whose answer was sent while its subscription was gone — is not reset when shown: it asks for the same page again and takes the answer as the open bracket's completion, settling with its turn once and the window the page reports. | ✓ | n/a: Session-only by construction |
| `row-35-dormancy-streaming.test.ts` | A body shown while a turn streams, with turns behind it that finished while it slept — one it sent and slept through, one prompted from outside the card — asks for what it missed before it re-subscribes and sets aside what the session says until the bracket opens: the finished turns land once each, and the streaming one arrives as the bracket's snapshot and runs on live to its end, once and whole. | ✓ | n/a: Session-only by construction |
| `row-35-dormancy-never-shown.test.ts` | A body hidden before its first showing — a never-shown workspace's Text card, its workspace visited and left before the body painted, so it paints at opacity 0 — is reported not shown, because shown is what the user can see rather than whether the container paints: its page is told so, it goes dormant past its delay and the time trigger evicts it, while the shown workspace's card keeps its body. | n/a: a Text card stands for every kind | ✓ |
| `row-36-first-visit.test.ts` | A workspace nobody has shown has no bodies; its first visit makes its card a body, at a recorded cost, and parking it again puts the body to sleep without evicting it. | n/a: a Text card stands for every kind | ✓ |
| `row-37-terminated.test.ts` | A Session body whose WebContent process is killed comes back ready and visible, settled with its last turn and its draft, within the rebuild bound (twice `at0749`'s reading). | ✓ | n/a: Session-only by construction |
| `row-37-failed-reveal.test.ts` | A Session card evicted by the clock whose new body fails twice when it is shown again: it stands as the shell's placard, with no body or last frame over it, saying the card needs reloading and nothing of loss; its Reload brings it back ready, shown and settled with its last turn. | ✓ | n/a: Session-only by construction |
| `row-38-evicted.test.ts` | A sibling whose body critical memory pressure evicted comes back when its tab is chosen: cold, and with no cover, since critical pressure takes no snapshot, so under its stand-in until it paints, its draft and its last turn back. Every frame from the choosing is read by row 44's judge (`_row-44.ts`'s `readGesture`). | ✓ | n/a: Session-only by construction |
| `row-38-evicted-no-cover.test.ts` | A parked card — its clock's eviction armed while it is hidden — that critical memory pressure evicted keeps no cover, as one whose snapshot failed or missed its deadline keeps none (that deadline is `AnswerOrDeadline`'s, held by a Swift unit test). Shown again, it comes back under its stand-in until its page paints: the host says nothing of a cover and, by its own per-frame layer rows, never shows the card before the paint, and every frame of the reveal is read by row 44's judge. | ✓ | n/a: Session-only by construction |
| `row-38-evicted-guarded.test.ts` | Two Text cards that guard their close, one with an unsaved edit: parked hidden, the host arms no clock for either page (the snapshot's `evictDue`), and a warning leaves both; critical pressure takes the dirty one, the word that its close asks survives a shell reload, and the pane's close fronts it and asks. | n/a: no frames read | n/a: a Text card stands for every kind that guards its close |
| `row-38-evicted-fold.test.ts` | A parked card the clock evicted, its last frame kept, is shown again and folded a frame later, before its new page has painted. A body stands under one cover whatever its reasons (`BodyCovers`): the fold's crossing takes the frame the card came back under rather than snapshotting a page that has shown nothing, and that cover comes off at the later of the paint and the land. The crossing's account says its cover was the standing one and no snapshot was taken, the plan did not wait on the unpainted page, and once landed the body is ready, painted, shown and folded, its cover gone. | n/a: no frames read — the bar is the host's cover account; the fold's own frames are row 9's, and row 44's judge reads a pane that keeps its box, which a folding card does not | n/a: Session-only by construction |
| `row-39-evict-after.test.ts` | A body hidden past the host's eviction delay, a constant the row shortens through the harness's `bodyDelays`, is evicted by the clock alone, with no pressure raised: not before the delay and not past its recorded ~110 ms and a frame, and leaving the spare — the same page, by its identity — which the row waits to see stand before the clock falls due. Its card comes back under the last frame the clock's eviction kept, ready, painted and shown with its draft. | ✓ | n/a: Session-only by construction |
| `row-40-ask-redelivered.test.ts` | A question a command-line caller asked, standing in a sibling's dialog when critical pressure evicts it, leaves the caller blocked while the card has no body and stands again in the card's new page when its tab is chosen; answered there, the caller exits with the chosen value. | ✓ | n/a: Session-only by construction |
| `row-41-fold-pressed.test.ts` | A folded card is a shown card — every card draws its folded form in its own page — so critical pressure while it is folded takes the spare and never its body, and the unfold carries that same body from its strip to its open box, holding row 9's carried bar. | ✓ | n/a: every kind folds the same way, shown at its strip |
| `row-42-warning-keeps-spare.test.ts` | A memory-pressure warning takes a parked workspace's hidden body and the warm spare stands through it: the same page, by its identity, not one remade after it. | n/a: no frames read | n/a: no frames read |
| `row-43-bodiless-phase.test.ts` | A parked Session card streaming a turn: its row's dot in a Cards body runs while the card's body is dormant and after it is evicted, and stills when the turn ends on tugcast unheard by any page of the card. | ✓ | n/a: Session-only by construction |
| `row-43-bodiless-closed.test.ts` | A parked Session card streaming a turn whose session is closed on tugcast while its body is dormant: its row's dot in a Cards body stills on the ledger row's closed state, though no turn's end was ever stamped. | ✓ | n/a: Session-only by construction |
| `row-44-switch-*.test.ts` (evicted, first-visit, create) | A workspace switch onto cards whose pages have not painted — two Session cards the clock evicted, two Text cards never shown, and a new workspace's factory rail, made by New Workspace — read frame by frame from the switch until every new page has painted, each frame judged against the settled one — but a frame still showing the standing workspace while the commit reaches the compositor (~80 ms and a frame); a pane's box counts as the floor only where it shows the canvas's grid, since a Session card's restore lid lies within the canvas colour's tolerance. An open hole draws no grid, so a box also fails where it shows canvas-coloured paint with no grid in it (`showsBareHole`) at a frame where the host had nothing of the card's on screen — no shown container and no face — since a lid is its page's own. A never-shown card's title band is judged by its chrome, the share of it that is not canvas, so a blank face or a departing card's chrome held there scores as held: that judge tells a band from the floor, not one band from another. The host's layer window must finish, since whether the switch had to plan a hand-over is read from it. The host hides the departing card's view in the same transaction that stands a face for each arriving card, drawn from the shell's stand-in (`body-stand-in.tsx`, `lib/face-draw.ts`): the switch's hand-over lands, with every arriving card faced and the departing view handed over, and no face is left standing once the pages paint. No pane's box shows more than 0.5% more canvas than it settles to, and each card's title band holds at least three quarters of its settled title's ink — for a never-shown card, of its settled band's chrome. The same judge (`readGesture`) reads row 38's eviction rows. The evicted cards come back under the host's last frame; the never-shown ones under the face and then the stand-in, until their pages paint. New Workspace is one cut onto its rail as well: the deck's trace holds one activation commit for it, spelled `"cut"`, no rail commit behind it, and canvas arms on one arrangement that carry nothing (the focus flip after the cut arms `unchanged`); every face standing after it wears the progress wave at rest, the display list the host draws each face from carries the wave's bars, and every rail page marks its lid for the running wave at its painted report and takes the wave down with the lid. | ✓ | n/a: a Text card stands for every kind |
| `row-46-destroy-save-deadline.test.ts` | A body asked to save on its way out whose page never answers is removed at the save's two-second deadline: listed while the host waits on the save, gone soon after it. | n/a: no frames read | n/a: no frames read |
| `row-47-handback-*.test.ts` (one-message, busy-latch, idle-dot, host-dormant) | A Session card handed back after its workspace was parked keeps its turn intact. A prompt sent while the card was hidden renders once after the catch-up, because the in-flight snapshot carries the submission's id. A catch-up inside a live turn leaves tugcast's turn latch open for as long as the turn streams, and the session row says the turn ended once it has. A turn that ends while the card's body is dormant stills the card's Cards row within seconds of the shell hearing the latch close. A parked body goes dormant on the host's clock alone, its page's clock left a minute long: the host's log says it declared the card dormant, and the page reads dormant on the host's word. | n/a: no frames read | n/a: Session-only by construction |
| `floor-host.test.ts` | The host draws the canvas floor: its colour and grid match the page's own by composite at zoom 0.8, 1.0 and 1.25, and it never shows before the window's reveal. | ✓ | — |

A row's file lands with the step that builds the row; a file not yet here is a
row not yet green.

## The record

Every row that has been red has an ending here, with the runs it rests on:
how many times it ran alone, the batch sizes it was red in, the sha and
whether the tree was dirty (`just db-inspect apptest_results`). The
ledger keys a run by its base checkout, so an arc worktree's runs and the
base's share one history; a sha below is the one the ledger recorded at
run time, which a replay may since have rewritten. A written contention
finding — green alone, red only in batches, with the sizes — is an ending;
a sentence in a step commit is not.

Every run is named by its tree as well as its sha: the arc worktree it ran
on (`.tug/worktrees/<arc>`, branch `tugarc/<arc>`) or `main`'s checkout,
and `dirty=0` or `dirty=1`. "Clean `main`" is written only for a run whose
root is `main`'s checkout at `dirty=0`. Unless an entry says otherwise, the
runs below were on the `body-lifecycle-fourth-fixups` worktree.

- **`row-17-crossing-split`, `row-28-deck-facts`, `row-10-workspace-kinds-away`.**
  Red alone on 2026-10-22 on the `body-lifecycle-second-fixups` worktree at
  `50beb0243` and the `fully-solved-animations` worktree at `c0417b7aa`;
  `row-10-workspace-kinds-away` never ran at `50beb0243`, and its reds are
  the `c0417b7aa` ones. Green alone from `97a58cd2a` (second-fixups) and
  `f1e12a702` (third-fixups) on, except one red of `row-17-crossing-split`
  in a batch of 9 at `97a58cd2a`; no single commit names the fix — the
  files their failures read moved in `1336e24b7` and `721d2ab84`. Run alone
  3/3 green each on 2026-10-23 at `56ba8fecd`, `dirty=0` (runs 8962–8970),
  an arc commit on the fourth-fixups worktree, not `main`.
- **`at0024-prompt-state-roundtrip`.** Red alone 3/4 at `d6dd50244`
  (2026-10-22, `switch-hand-over` worktree), green alone 3/3 at `f1e12a702`
  (third-fixups), and on 2026-10-23 red alone
  again: 1 pass in 4 at `56ba8fecd` and 3 in 7 at `2afb42f43`, always the
  `gallery-prompt-entry × appReload` leg's selection axis reading 0,0 with
  the text intact. A probe copy with a selection timeline showed the
  selection already collapsed at the first sample after the reseed, the
  DOM caret at offset 0 of the content: WebKit places a freshly focused
  contenteditable's caret as a later task, which CodeMirror reads back
  after the paint's own re-assert. `paintMirrorAsActive`
  (`tugdeck/src/components/tugways/tug-text-editor/state-preservation.ts`)
  now re-asserts the held selection after the focus and once more on the
  first `selectionchange` inside 300 ms that moves it, when that left it
  collapsed at 0 — the re-assert's own echo is passed over; jsdom tests
  hold each. 3/3 green alone at `c56dae0d8`, `dirty=0` — and then, on the
  tree replayed onto `62cda36fe`, 1 and 2 green in 4 alone with either
  form of that hold: the paint was not where the selection was lost. A
  timeline with every `Selection` mutation and focus event stacked showed
  the paint landing 50–100 correctly, and some 0.5–1 s later the host
  moving first responder off the card's web view and back: the body page's
  `window` blurs and refocuses with the editor still its active element,
  the DOM selection empties, and WebKit re-places the caret at 0 on the way
  back, which CodeMirror reads in. `tug-text-editor.tsx` already bridges
  that pair for cmd-tab, but it saved the selection only when
  `view.hasFocus`, which asks `document.hasFocus()` — already false while
  `blur` dispatches — so it never saved and never restored. It now reads
  focus as the editor being the page's active element, and holds the
  restored range through WebKit's caret placement as the paint does. 4/4
  green alone, and 2/2 with the read delayed 1.5 s so the refocus lands
  before it every run, on 2026-10-23 at `8da77caad` `dirty=1` (runs
  9021–9028), the blur fix not yet committed.
- **`row-01-arrival-cold`.** Since 2026-10-20 green alone 17 times and red
  alone once (run 8870 at `f1e12a702`), and in batches 56 green and 23 red,
  the reds at batch sizes 2 (twice), 4 (twice), 6, 16, 20, 21 and 42 to
  70. There is no last-green / first-red pair to probe between, so the
  probe is waived: the red follows the batch, not a landing. Its failure
  is a cold body that paints after the 2 s burst closes, leaving the last
  frame the lid with no content in it. The bar is restated in `_row-01.ts`,
  and it is a looser bar, said plainly: the hole frames are still judged
  over the whole burst, but the finished rect is read from a short burst
  after the paint when the body painted past the burst's close, with a
  note saying the body was slow, so how soon the body paints is no longer
  bounded — a body painting at 29 s passes under `BODY_READY_MS`. 3/3
  green alone at `c56dae0d8`, `dirty=0`.
- **`at0140-cycle-session-card`.** In the batch of 25 (run 8906,
  `f1e12a702`, 2026-10-22) it was 0/5, then red alone twice (2/4, 2/4)
  before its popover read moved into the card's body and it went green
  once. 3/3 green alone on 2026-10-23 at `56ba8fecd`, `dirty=0`.
- **`row-33-arrangement`.** Red alone 10 of 15 runs in twelve minutes on
  2026-10-22 before its confirm fix, red in the batch of 25 and green alone
  after; on 2026-10-23 at `60b605be7` on `main`'s checkout, `dirty=1`, red
  alone 2 and green alone 2, and red in 6 of 9 runs counting batches,
  until `389770768` held the arrangement frames to one workspace. 3/3
  green alone at `c56dae0d8`, `dirty=0`.
- **`row-38-evicted-guarded`.** Red alone once at `8ae30c1b2` (third-fixups,
  `dirty=1`) while its reload leg was being written, red in a batch of 35
  at `50beb0243` (second-fixups), green
  in batches since. 3/3 green alone at `c56dae0d8`, `dirty=0`.
- **`row-25-in-card-surfaces`.** Red alone 6 times at `f1e12a702` before
  its bar changed (paint is rows changing past the composer or wearing the
  surface's own fill), then green alone once and in the batch of 25.
- **The batch of 25 (run 8906, `f1e12a702`).** Three files were red, not
  two: `row-44-switch-first-visit`, `row-33-arrangement` and `at0140`.
  Rows 44 and 33 were green alone straight after; `at0140` was red alone
  twice more before its edit.
- **Lifecycle rows 35–46 at `c56dae0d8`.** Run once together on
  2026-10-23, `dirty=0` (run 8999, 23 files): 22 green;
  `row-38-evicted` was stopped at the 20 s budget unfinished, having run
  17 s alone every time on record, and was green alone straight after
  (run 9000, 17 s). It is a file at the budget's edge, not a red: in a
  batch the margin is gone. That was not the tree that landed: after it
  `8da77caad` and `a657229b6` changed `tug-text-editor.tsx` and
  `state-preservation.ts`, which a restored Session draft runs through,
  and the replay moved the base. The run on the final tree is the next
  entry.
- **Lifecycle rows 35–46, the fold row and at0024 at `675282b3e`.** Run
  once together on 2026-10-23 on the `body-lifecycle-closing-tail` worktree,
  `dirty=0` (run 9040, 24 files, 62 s): 23 green. `row-38-evicted-no-cover`
  was red in the batch, a reveal frame showing the canvas through the pane,
  and green alone straight after (run 9041, 14 s) on the same tree. A
  catch-up fix in the session reducer landed after it, so the run on the
  final tree is the next entry.
- **Lifecycle rows 35–46, the fold row and at0024 on the final tree.** Run
  once together on 2026-10-23 on the `body-lifecycle-closing-tail` worktree
  at `6930dd68e`, `dirty=0` (run 9042, 24 files, 57 s): 24 green, among them
  `row-38-evicted-fold` asserting the unbound page it exists for,
  `row-38-evicted-no-cover`, and `at0024-prompt-state-roundtrip`. With run
  9040's red, `row-38-evicted-no-cover` is a contention finding: red once in
  a batch of 24, green alone and in the next batch of 24.

## Kind checks

A kind that moves lands with one `kind-<componentId>.test.ts`: the card
mounts as a body holding its kind, shows its real data reached the
production way, its own interactions work in its body, its body paints the
surface its pane paints (read by composite colour), and its deck bridge was
asked nothing only the shell answers.

| File | Kind | Its data | Its interactions |
|---|---|---|---|
| `kind-jots.test.ts` | Jots | a jots file (`TUG_JOTS_PATH`) | the row menu; an edit, an add and a drag reorder, each reaching the file |
| `kind-arcs.test.ts` | Arcs | a scratch repository's arc, through tugcast | Bind offered to the followed Session card; the row menu |
| `row-33-arrangement.test.ts` (Layout leg) | Layout | the shell's six-slot flow arrangement | the Layout row press (round trip noted); the window grip drag |
| `row-33-arrangement.test.ts` (Cards leg) | Cards | the shell's workspaces, cards and session bindings | row ×, new workspace named in the body, go-there, Delete Workspace's confirm |
| `kind-documents.test.ts` (Text) | Text | a text file on disk | typing, ⌘S to the file, the unsaved dot on the Cards rail's row, Reveal enabled in the shell's title bar |
| `kind-documents.test.ts` (file-view) | file-view | a picture on disk | the title bar's gear opens the image settings sheet in the body |
| `kind-documents.test.ts` (Diff) | Diff | this checkout's HEAD, through git | a section's trigger folds it |
| `kind-documents.test.ts` (Commit) | Commit | this checkout's HEAD, through git | the shell's masthead wears its subject; a roster path opens its file, and again reuses that card |
| `kind-singletons.test.ts` (Settings) | Settings | a seeded tugbank's stored values | a section click; a control's press writes tugbank, which the shell reads; a second open raises the one body; `reveal-settings` lands the named section |
| `kind-singletons.test.ts` (Keyboard Shortcuts) | Keyboard Shortcuts | the keymap | the filter field narrows the rows |
| `kind-singletons.test.ts` (About) | About | the host's build identity, relayed in the body's context | none of its own; the shell's tab wears the title it published |
| `kind-singletons.test.ts` (Hello) | Hello | its line | none |
| `kind-singletons.test.ts` (devtools) | devtools | the followed Session body's inspection and the shell's log, both relayed | the Telemetry and Log tabs; closing the card stops the relay |
| `kind-gallery-buttons.test.ts` | the maker kinds (gallery, spike, fixture), by `gallery-buttons` | its own sections | the view toggle flips in the body |
