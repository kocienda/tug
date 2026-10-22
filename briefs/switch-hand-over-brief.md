# Switch hand-over: no departing card over the arriving ones

**Purpose:** On a workspace switch onto cards whose pages have not painted, the card being left stays drawn over the arriving cards' faces for one or two frames, and a returning Session card can show a frame with an empty title bar. Both are visible faults; this brief decides how the switch hands the screen from one workspace to the next so neither happens, using only public API.

---

## Purpose {#purpose}

Found while tightening grounding row 44 in the `body-lifecycle-fixups` arc (2026-10-21/22). When you switch to a workspace whose cards were evicted, or were never shown, the card from the workspace you left is still drawn on top of the arriving cards' title bars for a frame or two, then vanishes. Separately, a Session card coming back from eviction sometimes shows a frame with its title bar and slot number blank.

The fixups brief's [B11] tried to close the first by stacking the held departing view beneath the arriving ones. That cannot work (see [F03]). The user decided on 2026-10-22: fix it rather than accept it, and fix it without private WebKit calls, which can be removed or change behaviour at any time.

---

## Evidence {#evidence}

**[F01] The departing view is held for two shell paints, by design.** When a switch takes a shown card down, the placer offers the host a placement that still shows the departing view (`heldForThePaint`, `tugdeck/src/lib/card-placement.ts`). It posts the hide only after two `scheduleAfterPaint` callbacks (`hideNow`). The comment says why: the host applies a hide at once, while the shell's frame for the switch may not have reached the screen yet. **(verified, read)**

**[F02] Every card view stands above the shell page, and a card with no painted page is drawn by the shell.** An arriving card whose page has not painted is drawn by the shell's stand-in face (`body-stand-in.tsx`, `data-body-stand-in`, [D219]), which is shell paint. The departing card's view is a web view, so during the hold it covers the stand-ins wherever the two overlap. **(verified, read and composite)**

**[F03] Lowering the held view's `z` changes nothing.** A held view given a `z` below every view the next placement shows still stood over both arriving stand-ins in row 44's evicted switch. No `z` puts a view below the shell page. **(verified, app-test run, 2026-10-21)**

**[F04] The overlap, measured.** In row 44's evicted switch, the first switched frame at 39–40 ms shows the departing workspace's Text card drawn across both arriving Session cards' title bands. Card B's title band read 4.8 % ink against 9.8–10.3 % settled. **(verified; frames kept by `_row-44.ts` on red)**

**[F05] Dropping the hold shows empty canvas.** With the hold dropped wherever a leaving view overlaps another card the next placement places, the first switched frame at 41 ms read 100 % canvas in both panes. That is the flash [F01]'s hold exists to prevent. One earlier run of the same change happened to show none, so the flash is a race, not a constant. **(verified, two runs)**

**[F06] The host already owns a surface for some arriving cards.** An evicted card whose last frame the host kept comes back under that cover (`covers`, `BodyViewController.swift`). The cover is bounded to 32 MB, kept at 1×, aged, and none is taken under critical pressure. The host places and removes it itself, and reports `covered` to the shell. A card evicted without a cover, and a card never shown, have no host-side surface. **(verified, read; built in `body-lifecycle-fixups`)**

**[F07] A blank-titled Session face shows for a frame on a revival, and it is not the stand-in.** In row 44's evicted switch, card A (warm start) shows a face with its session icon but no masthead and no slot number at 73 ms. That happened in two of four runs. A per-frame sampler in the same run read both shell stand-ins carrying their masthead and title from the first sampled frame (10 ms) until they went away. The host reported A painted and shown only at 247–323 ms. So the blank face is drawn by the host's side, not the shell's stand-in. Whether it is the warm page shown early, or something else, **is not established.** A probe that reads the host's per-card layers (cover, container opacity, `revivedNow`) at that frame would settle it. **(partly verified: stand-ins sampled; source of the blank face inferred)**

**[F08] WebKit has a presentation callback, and it is private.** `WKWebView` responds to `_doAfterNextPresentationUpdate:` on this machine's WebKit, which would let the host hide the departing view once the shell's frame is on screen. It is undocumented SPI. **(verified, 2026-10-22; rejected by [B01])**

**[F09] The stricter row 44 judge is written and waiting.** `row-44-tightening.diff` (kept beside the fixups arc's documents, `.tug/arcs/body-lifecycle-fixups/`) judges each frame against the settled one:
- a pane's canvas share within row 1's 0.5 % of the settled pane's;
- a title band holding at least three quarters of the settled title's ink.

Under it, the first-visit piece passes since the stand-in clips its picture (fixed in `body-lifecycle-fixups`), and the evicted piece fails on [F04] and [F07]. **(verified)**

---

## Decisions {#decisions}

**[B01] No private WebKit calls.** The fix uses public API only. Private selectors can be removed or change behaviour in any WebKit update, and a hand-over that silently falls back would bring the fault back with nothing to say so. Rules out [F08].

**[B02] The hand-over is one host transaction.** Whatever replaces the departing view on screen is a host-owned surface. The host places it in the same `CATransaction` that hides the departing view. The host can order its own layers in one commit; it cannot learn when the shell's frame is on screen ([F01]–[F05]). So the faces that must be on screen when the departing view goes have to be the host's, not the shell's. With that, the two-paint hold of [F01] is no longer needed for a switch, and goes.

**[B03] The host draws every arriving card's face.** Where it holds the card's last frame, it uses the cover ([F06]). Where it holds none (a card evicted with no cover, or never shown), it draws the face the shell's stand-in would draw: the card's chrome and title from the facts the shell already holds for that card ([D219]'s derived facts). The shell's stand-in stays as the floor beneath; the host's face covers it until the card's own page paints, then goes in the transaction that shows the page. How the host draws that face is [Q01].

**[B04] A card's own page never shows a blank title bar.** [F07] is a defect, fixed in the same arc: find what the host shows at the blank frame, and fix it at its source. The arc does not guard it with a looser bar. Fixing the code is the default ending; the bar is row 44's tightened title judge ([B05]).

**[B05] Row 44's tightened judge lands with the fix.** `row-44-tightening.diff` is applied, and both row 44 pieces pass under it. `at0747-no-hole-under-cards`'s arrival census stays green: nothing painted in the shell but a stand-in face. Every placement or hand-over change that the guard would miss carries its own assertion.

*Landed, `3dc927ffe` (2026-10-22).* [Q01] was settled for neither route as written: the shell reads the stand-in into a display list (`lib/face-draw.ts`) of boxes, text runs and icons, and the host draws it (`BodyFaceView`), so the face follows the chrome and the theme with no second implementation and no snapshot to wait on. [Q02] was settled by the placement's shape, not the gesture: a departing view that meets a drawable face is handed over in one transaction, a switch and a tab put behind an unpainted card alike, and one that meets none keeps the two-paint hold (`meetsAFace`). A face retires two host frames after a snapshot with `afterScreenUpdates` answers, under a 250 ms horizon. Since the body-lifecycle second fixups, `placeCards` declares `face` and `faceDraw` on the wire, and a face is read again when its stand-in's facts move.

---

## Open Questions {#open-questions}

- **[Q01] How the host draws a card's face when it holds no cover.** Two public-API routes, each with a cost:
  - **A snapshot of the shell's stand-in** (`WKWebView.takeSnapshot`), taken once the stand-in has painted, and placed as a layer at the card's rect. Pixel-identical to the stand-in by construction. But a snapshot is asynchronous, so the departing view is held until it arrives, and the switch lands that much later. That latency needs measuring, and it needs a bound.
  - **Native chrome** drawn by the host from the card's facts. Ready at once, but a second implementation of the title bar and masthead that has to match the shell's to the pixel, in every theme.

  Settle it by measuring snapshot latency on the harness, and by reading what a native face would need from the shell's chrome. The design spike belongs to the arc's first step.
- **[Q02] Whether a fold, a tab change, or a close needs the same hand-over.** [F01]'s hold also covers a tab put behind another and a view leaving the placement altogether. Today `takenBy` exempts exact-rect overlaps (a tab change), so only switches and closes hold. Whether [B02] should replace the hold everywhere, or only on a switch, depends on [Q01]'s cost. Read it from the hold's callers once [Q01] is settled.

---

## Non-goals {#non-goals}

- **Accepting the overlap.** The user's call (2026-10-22): a visible fault with a fix is fixed.
- **Private WebKit SPI.** [B01], including `_doAfterNextPresentationUpdate:` ([F08]).
- **Retiring the private WebKit calls Tug already makes** (`_features`, `_setEnabled:forFeature:` and `_setWindowOcclusionDetectionEnabled:` in `MainWindow.swift`). The user is tracking those separately; this arc neither adds to nor removes them.
- **Dropping the hold and living with the canvas flash.** Measured in [F05], and it trades one visible fault for another.
- **Stacking the held view beneath the arriving ones.** Measured in [F03]; it cannot work while stand-ins are shell paint.

---

## Exit {#exit}

**An arc.** First steps, in order:
1. Settle [Q01] with a measured spike: snapshot latency on the harness against what a native face needs.
2. Diagnose [F07] with a host-layer probe at the blank frame, and fix it ([B04]).
3. Build the host-drawn face and the one-transaction hand-over for a switch ([B02], [B03]), and remove the switch's two-paint hold.
4. Answer [Q02] for the hold's other callers.
5. Land row 44's tightened judge, and run both row 44 pieces, `at0747`, row 10's switch pieces and row 1 as the verdict ([B05]).
