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
| `row-17-crossing-*.test.ts` (bullseye, sidebars and kinds-resize each way; new-card; split) | Bullseye, a column split and a new card beside the body card (⌘N's action) carry it with its chrome, to a new size where the box changes: `crossingReady` within a display period of the first moving beat, the content box and its bottom strip never the floor, the transcript pinned to its bottom before and after, and the container's top corners square. | ✓ | ✓ |
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
| `row-38-evicted.test.ts` | A sibling whose body critical memory pressure evicted comes back when its tab is chosen: cold, and with no cover, since critical pressure takes no snapshot, so under its stand-in until it paints, with no frame of canvas or bare window, its draft and its last turn back, and its cold time recorded. | ✓ | n/a: Session-only by construction |
| `row-38-evicted-no-cover.test.ts` | An eviction whose snapshot never answers goes on without a cover at the snapshot's deadline, and the card comes back under its stand-in until its page paints: the host never shows it before the paint, and no frame of the reveal shows the floor's grid or the bare window. | ✓ | n/a: Session-only by construction |
| `row-38-close-evicting.test.ts` | A card closed with a save while its eviction waits on its snapshot, its page busy past the snapshot's deadline, is removed by the close alone: the host abandons the eviction for the close, keeps no cover for the card and never reports it evicted. | ✓ | n/a: Session-only by construction |
| `row-39-evict-after.test.ts` | A body hidden past the reader's `evictAfterMs`, shortened in the shell as the Layout card writes it, is evicted by the clock alone — not before the delay, and leaving the spare — and its card comes back ready and shown with its draft. | ✓ | n/a: Session-only by construction |
| `row-40-ask-redelivered.test.ts` | A question a command-line caller asked, standing in a sibling's dialog when critical pressure evicts it, leaves the caller blocked while the card has no body and stands again in the card's new page when its tab is chosen; answered there, the caller exits with the chosen value. | ✓ | n/a: Session-only by construction |
| `row-41-fold-pressed.test.ts` | A folded card is a shown card — every card draws its folded form in its own page — so critical pressure while it is folded takes the spare and never its body, and the unfold carries that same body from its strip to its open box, holding row 9's carried bar. | ✓ | n/a: every kind folds the same way, shown at its strip |
| `row-42-bodies-row.test.ts` | The Layout card's Bodies row reads the deck's bodies by tier from the shell's census, a parked workspace's card counted hidden, its Pressure row reads the host's last pressure event with its time (none since launch, then a warning, then normal), the warning takes the hidden body and the warm spare stands through it, and its Release row stands at fifteen minutes and shows a delay pressed on it. | n/a: the Layout card's own rows | n/a: the Layout card's own rows |
| `row-43-bodiless-phase.test.ts` | A parked Session card streaming a turn: its row's dot in a Cards body runs while the card's body is dormant and after it is evicted, and stills when the turn ends on tugcast unheard by any page of the card. | ✓ | n/a: Session-only by construction |
| `row-43-bodiless-closed.test.ts` | A parked Session card streaming a turn whose session is closed on tugcast while its body is dormant: its row's dot in a Cards body stills on the ledger row's closed state, though no turn's end was ever stamped. | ✓ | n/a: Session-only by construction |
| `row-44-switch-*.test.ts` (evicted, first-visit) | A workspace switch onto cards whose pages have not painted — two Session cards the clock evicted, and two Text cards never shown — read frame by frame from the first switched frame until every new page has painted: no pane shows the floor, title band or box, and each evicted card's title band holds its title. The evicted cards come back under the host's last frame; the never-shown ones wear the face the shell stands in (`body-stand-in.tsx`), whose title lands with the page that computes it. | ✓ | n/a: a Text card stands for every kind |
| `floor-host.test.ts` | The host draws the canvas floor: its colour and grid match the page's own by composite at zoom 0.8, 1.0 and 1.25, and it never shows before the window's reveal. | ✓ | — |

A row's file lands with the step that builds the row; a file not yet here is a
row not yet green.

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
