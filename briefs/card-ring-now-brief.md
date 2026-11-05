# The accent ring lights in the press's own frame, from every sidebar door

**Purpose:** Pressing a row in the Workspaces card or a place in the Layout card is meant to answer with an accent ring on the border of the card it names. Today the ring arrives at once, late, or not at all, and which of the three you get depends on things the reader cannot see. The ring must light immediately, every time, from both doors.

---

## Purpose {#purpose}

The user's report: "When I begin interacting with a card by clicking in the workspace or layout sidebar cards, the card's border must highlight immediately. Right now, sometimes the border highlights as it should, sometimes it does so after a delay, and sometimes it doesn't highlight at all. Border highlight must happen right away."

The highlight in question is the **accent ring** — the one-shot `.tug-pane-flash` ring the deck draws on a card's border to say "here it is" ([P04]). It is not the pane's active look (`data-focused`: title-bar ink, shadow, the recede), which is a different mechanism with its own path, and which this brief leaves untouched. The two were conflated once in this investigation and had to be teased apart; the finding below is about the ring alone.

---

## Evidence {#evidence}

**[F01] The ring is its own mechanism, separate from activation.** The accent border is `.tug-pane-flash::before` (`tugdeck/src/components/tugways/tug-pane.css:1252`): a pre-drawn inset `box-shadow` in the accent colour whose only moving property is `opacity`, run by `tug-pane-border-flash` for `--tugx-card-flash-duration` (1750 ms). `tugdeck/src/lib/flash-pane-border.ts` toggles the class, restarts a mid-run ring by seeking its animation to 0, and keeps at most one ring lit on the deck. Nothing in the activation path (`DeckManager.activateCard`, `pane-focus-controller.ts`, `data-focused`) draws it. **(verified)**

**[F02] A card's page draws the ring; the shell only decides.** Under per-card web views ([D216]) the shell's `.tug-pane` is a paintless stand-in. `flashPaneBorder` therefore asks the relay installed in `tugdeck/src/lib/body-shell.ts:600–612` whether a body draws the pane, and if so sends `card.flash { lit }` over the bus; the body's handler (`tugdeck/src/body/body-verbs.ts:114`) runs `flashPaneFrame` on its own `.tug-pane.body-chrome-frame`. That hop is one wire trip with no deferral in it. **(verified)**

**[F03] Workspaces row: the ring is parked on the settle, which is the whole of "now vs. late".** The row dispatches `focus-session-card`, a `registry` command (`command-registry.ts:2636`), so it runs in the shell: `raiseCard`, then `flashPaneBorderOnSettle(pane.id)` (`tugdeck/src/action-dispatch.ts:1171–1172`). That function reads `data-imposer-settling` on the shell canvas at call time. The settle arm is a **sync** store subscriber (`settle-engine.ts:2406`, label `canvas-arm`), so the mark is already on in the same task whenever the raise moved anything — a strip slide, a reveal, a z-raise with a tween — and the flash is then parked on `IMPOSER_SETTLE_END`, a few hundred milliseconds away. A raise that moves nothing finds no mark and rings at once. The reader sees "immediate" or "delayed" according to whether their press happened to move the arrangement. **(verified by reading; not timed)**

**[F04] The parking was a deliberate design, and its cost argument no longer holds.** `flashPaneBorderOnSettle`'s own comment cites [B05] of the motion work: the ring runs for nearly two seconds, the settle for a few hundred ms, and a ring that started in the click's frame would run its first third over the motion it announces. At the time the keyframes walked `box-shadow`, a full-pane repaint per frame. The ring is now a static layer whose keyframes move `opacity` alone (`tug-pane.css:1226–1240`), compositor-only, so starting it inside the motion costs the motion nothing. What remains of [B05] is an aesthetic preference, and the user has ruled on it. **(verified)**

**[F05] Workspaces row: the "never" cases are consequences of the parking.** A second flash request while one is parked drops the first (`dropPendingFlash`), and a settle whose end notice does not reach the parked listener leaves it parked for good — the one path that takes the settling mark off without a notice is the canvas's own unmount teardown (`settle-engine.ts:2457`), covered by `deck-canvas.tsx` calling `dropPendingFlash`. With nothing parked, neither can happen. **(verified by reading)**

**[F06] Layout miniature: the ring never lights, by construction.** A press on a place runs in the Layout card's own page: `raiseCard(store, cardId)` then `flashCardPane(store, cardId)` (`tugdeck/src/components/layout/use-miniature-gestures.ts:308–309`; the same pair in `layout-card.tsx:1204–1205`, and `flashSlot` from `goToSlot`). The raise crosses to the shell — the body deck's `activateCard` dispatches `deckActivateCard` for a card not its own (`body-card-deck.ts:443`). The flash does not: `store` is the body's arrangement view, whose panes are the shell's, so the pane is found — and then `paneFrame(paneId)` queries **the Layout body's document**, which holds only its own frame, and that under the id `body-pane-<cardId>` (`arrangementSnapshot`, `body-arrangement.ts:150`), not the shell's pane id. Null; one retry after the commit; null again; silence. `flashVacantSlot` queries `.tug-slot-vacancy` in the same document and finds nothing. The only Layout gesture that rings is a *refused drop*, because that one goes to the shell through `miniatureCommit` → `flashCard` (`body-shell.ts:596`, `miniature-bus.ts:106`). **(verified by reading)**

**[F07] No test covers a ring from a sidebar body's press.** `at0466-go-to-slot` and `at0547-directional-card-focus` are the two app-tests that `@covers` `flash-pane-border.ts`; both ring from shell-originated chords and both are green (last runs 2026-10-31 and 2026-11-03). `tests/app-test/card-chrome-fixture.ts` already supplies `ringedCards` and `waitForRing`, which read the ring across body pages via `app.body(card)`. **(verified)**

---

## Decisions {#decisions}

**[B01] The ring lights in the press's own task, never parked on a settle.** `focusSessionCard` calls `flashPaneBorder` directly. `flashPaneBorderOnSettle` has that one caller and is deleted, with `dropPendingFlash`, its teardown call in `deck-canvas.tsx`, and the prose in `tug-pane.css` and `flash-pane-border.ts` that rests on it. This reverses [B05]'s overlap rule for the ring on the user's instruction ([F04]): the ring is compositor-only, the overlap costs the motion nothing, and the deck's answer to a gesture must not wait on the deck's own motion. The one-shot deferred retry for a pane that is in the store but not yet in the DOM (`retryAfterCommit`) is a different wait and stays.

**[B02] The ring is a deck verb a body asks the shell for, like activation.** `DeckView` gains `flashCard(cardId)` and `flashSlot(slot)`; the shell's deck answers them with `flashCardPane` and `flashSlot` on itself, and the body's view dispatches a shell-owned bus action beside `deckActivateCard` (`bus/declarations/verbs.ts`), handled in `body-shell.ts` next to the `deckActivateCard` handler. The Layout card's press, `goToSlot`, and the drag's refused-drop answer call the view, not the module, so one route serves them all and `miniature-bus`'s private `flashCard` relay can go. In a body page the module functions become unreachable from arrangement code; a body never queries another card's frame in its own document again ([F06]).

**[B03] The shell → body `card.flash` relay stays as it is.** It is one wire trip, synchronous at both ends ([F02]), and it is the path the two green tests already prove. The fix removes what sits in front of it; it does not redesign it.

**[B04] Activation is out of scope.** `data-focused`, `pane-focus-controller.ts`, the body's `focused` context and its deferral are untouched. The pane's active look has its own path and its own timing; the user's report was about the ring, and a change that moved both would make the proof of either unreadable.

**[B05] The proof is an app-test that presses from the body and reads the ring in the target.** One file: from `app.body(<Workspaces card>)` press a session row, and from `app.body(<Layout card>)` press a place, each on a still deck and on a flow deck where the raise slides the strip, and `waitForRing` on the target with a tight bound — a frame or two, not the fixture's default two seconds. It carries `@covers` for `flash-pane-border.ts`, `action-dispatch.ts`, `use-miniature-gestures.ts` and `body-shell.ts`. It goes red first under `tugtool file probe` with the fix reversed, in both halves: the Workspaces half red on the flow deck (late), the Layout half red on both (never).

---

## Non-goals {#non-goals}

- **Making the pane's active look (`data-focused`) land sooner.** A separate mechanism with a separate deferral ([B04]). If it needs work it gets its own brief.
- **Keeping the settle-parked flash as an option.** A ring that sometimes waits is the defect; there is no setting under which the reader wants it.
- **A ring on a Layout drop that rearranges.** A drop rearranges and does not activate (`use-miniature-gestures.ts` header); it rings only when refused, and that stays.
- **Redrawing the ring in the shell over a body.** The shell's stand-in paints nothing by design ([D216]); the body draws the ring and that is right.

---

## Exit {#exit}

An arc. The shape it starts from:

1. `focusSessionCard` rings now; `flashPaneBorderOnSettle` and `dropPendingFlash` removed with their call sites and prose ([B01]).
2. `flashCard`/`flashSlot` on `DeckView`, a shell-owned bus action, the shell handler, and the Layout card's callers moved onto the view ([B02]); `miniature-bus`'s `flashCard` option retired.
3. The app-test of [B05], red first by probe, then green; `at0466` and `at0547` re-run as the regression check on the shell-originated doors.

Steps 1 and 2 are independent; the test lands last because it proves both.
