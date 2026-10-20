/**
 * AT0612: the update feature — one pill and one wizard — driven entirely from the bridge:
 * what lights the pill, and what raises and lowers the wizard.
 *
 * ## What this pins
 *
 * Tug's update presentation is exactly two things. A **pill** at the window's top
 * centre that says an update exists and nothing else, and **UpdateTug**, an
 * app-modal wizard walking Check / Download / Stop work in flight / Install and
 * relaunch. There is no badge, no inline dialog, no collapsed and expanded size,
 * and no collapse control: this file is the rewrite that followed their
 * deletion, and the old surface's claims are gone from it rather than relaxed.
 *
 * The contract with the host is unchanged and is still the whole of what this
 * test speaks: state in on `window.__tugBridge.onUpdateState`, one action name
 * out on `updateAction`. No Sparkle, no updater, no feed, no network. Every
 * stage the driver can report is injected as a snapshot and the deck is required
 * to draw it.
 *
 * `[B##]` and `[F##]` are `briefs/update-tug-brief.md`, which decided the
 * replacement; `update-surface-anchor [B##]` is the arc that put the anchor at
 * the top centre, and the anchor is the one thing this rewrite inherits intact.
 *
 * Seven claims are worth naming, because they are what the arc rests on and what a
 * plausible refactor would quietly lose:
 *
 * 1. **A scheduled find opens nothing.** An update that arrives without anybody
 *    asking lights the pill and stops there. Nothing takes the app modal, and
 *    nothing takes focus [B03].
 * 2. **The pill says one thing.** *Tug v0.9.0 is available*, in every live stage —
 *    it never narrates the flow it is standing next to [B02] [F08]. It shows for
 *    `available` through `installing` and for nothing else: not for a check in
 *    flight, not for a check that found nothing, not for a failure.
 * 3. **Two doors, both only raising.** A pill click opens the wizard; a bumped
 *    `revealCount` opens it in every stage, `idle` included, and the same count
 *    replayed opens nothing [B01] [B06].
 * 4. **Closing is pause.** Close posts nothing, the host's stage is untouched,
 *    and reopening lands on the step the flow is actually on — the wizard holds
 *    no flow state of its own [B04]. The two terminal stages are the exception,
 *    and about Sparkle rather than about the wizard: `upToDate` and `error`
 *    acknowledge with `dismiss`.
 * 5. **Four rows, always, and the dot says where the flow is** [B02]. Unpacking
 *    is the download row's detail phase rather than a row of its own, and a
 *    failure lands on the row that was waiting rather than on a row the
 *    snapshot never named.
 * 6. **Progress is words on one span, never a render** [L06]. The span that is
 *    there at 7% is the span that is there at 99%.
 * 7. **A download can be stopped, and what that costs is said first.** Sparkle's
 *    download cannot be picked up where it left off, so the button is *Stop for
 *    Now* rather than *Pause*, the download row's own detail line names the
 *    bytes and closes on what stopping does to them, and the stopped row offers
 *    *Resume* rather than a failure. The warning has no element of its own: a
 *    second line would have made that row taller than the three beside it, which
 *    `at0632` measures.
 *
 * This file pins claims 1 to 5 and the pill's `x`;
 * `at0612-update-tug-controls.test.ts` pins what every control posts, the
 * terminal stages' `dismiss`, and claims 6 and 7. The two were one file until
 * it outgrew the 20 s budget; `update-tug-fixture.ts` holds what they share.
 *
 * The actions are read back through a recorder standing in for the host's
 * `updateAction` message handler — which is also what keeps this file from
 * driving a real install: no click here reaches Sparkle. The recorder swallows
 * the action rather than forwarding it, so nothing ever pushes the deck back to
 * `idle` on its own; every stage this test stands in, it stands in until the
 * next snapshot is pushed.
 *
 * The one thing deliberately not pinned here is the with-turns branch of the
 * *Stop work in flight* row. The row derives from the deck, and this deck has
 * no session mid-turn — so what this file pins is the other half, which is the
 * common one: the row reads done, and *Install and Relaunch* is there and posts
 * `install` with no confirm in the way. That the install button is absent while
 * a turn exists, and comes back when the last one ends, is pinned on
 * `deriveUpdateRows` in `tugdeck/src/components/tugways/__tests__/update-tug-rows.test.ts`,
 * where the deck's answer is an argument [B08].
 *
 * @covers tugdeck/src/components/tugways/update-tug.tsx
 * @covers tugdeck/src/components/tugways/update-tug-rows.tsx
 * @covers tugdeck/src/components/tugways/update-tug.css
 * @covers tugdeck/src/components/chrome/update-pill.tsx
 * @covers tugdeck/src/components/chrome/update-pill.css
 * @covers tugdeck/src/components/tugways/tug-step-row.tsx
 * @covers tugdeck/src/components/tugways/tug-step-row.css
 * @covers tugdeck/src/lib/live-turns-store.ts
 * @covers tugdeck/src/lib/update-store.ts
 * @covers tugdeck/src/lib/update-tug-request-store.ts
 * @covers tugdeck/src/lib/transfer-rate.ts
 * @covers tugdeck/src/components/tugways/internal/tug-progress-bar.tsx
 * @covers tugdeck/src/components/tugways/internal/tug-progress-bar.css
 * @covers tugapp/Sources/UpdateState.swift
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import {
  CLOSE,
  PILL,
  PILL_ANCHOR,
  PILL_HIDE,
  SHOULD_RUN,
  STEP_ROWS,
  TEST_TIMEOUT_MS,
  WIZARD,
  anchoredBox,
  centreX,
  checkDetail,
  clearPosted,
  elementCount,
  goIdle,
  letTimePass,
  nextReveal,
  postedActions,
  push,
  reveal,
  snapshot,
  stepKeys,
  stepLabels,
  stepStatuses,
  waitForClickable,
  waitForPill,
  waitForWizard,
  waitForWizardGone,
  withUpdateDeck,
} from "./update-tug-fixture";

describe.skipIf(!SHOULD_RUN)("AT0612: the update pill, and what raises and lowers the wizard", () => {
  test(
    "a find only lights the pill, both doors only raise the wizard, closing is pause, and the x only hides",
    () =>
      withUpdateDeck("at0612-update-tug-pill", async (app) => {
        // ---- The old surface is gone, not hidden ------------------------
        //
        // The badge, the inline dialog and the collapse control were deleted
        // rather than suppressed, so their test ids must not resolve in any
        // state. A re-mount of the old component behind a flag would pass
        // every behavioural assertion below and fail here.
        await goIdle(app);
        for (const gone of [
          `[data-testid="update-badge"]`,
          `[data-testid="update-dialog"]`,
          `[data-testid="update-collapse"]`,
          `.tugx-update-overlay`,
        ]) {
          expect(await elementCount(app, gone)).toBe(0);
        }

        // ---- Idle says nothing at all -----------------------------------
        expect(await elementCount(app, PILL_ANCHOR)).toBe(0);
        expect(await elementCount(app, WIZARD)).toBe(0);

        // ---- A scheduled find lights the pill and opens nothing [B03] ----
        //
        // This is the claim the whole feature is built around: an update that
        // nobody asked for never takes the app modal. It is asserted for the
        // unsolicited case AND for the user-initiated one, because
        // `userInitiated` used to be the flag that opened the old surface by
        // itself, and the wizard deliberately does not read it — the menu item
        // bumps the reveal count instead [B06].
        const beforeFocus = await app.getActiveElement();
        for (const userInitiated of [false, true]) {
          await goIdle(app);
          await push(app, snapshot("available", { userInitiated }));
          await waitForPill(app, "available");
          expect(await elementCount(app, WIZARD)).toBe(0);
          expect(await postedActions(app)).toEqual([]);
        }
        // And nothing took focus on the way in.
        expect(await app.getActiveElement()).toEqual(beforeFocus);
        note("at0612 scheduled find", "pill only, wizard closed, focus unmoved");

        // ---- The pill shows for a live update, and for nothing else [B02]
        //
        // `checking` has found nothing yet, `upToDate` found nothing at all,
        // and `error` has no update to say is available. Each of the three is
        // reached from idle so the previous stage's pill cannot linger into
        // the assertion.
        const pillStages: Array<[string, boolean]> = [
          ["checking", false],
          ["available", true],
          ["downloading", true],
          ["extracting", true],
          ["readyToInstall", true],
          ["installing", true],
          ["upToDate", false],
          ["error", false],
        ];
        for (const [stage, lit] of pillStages) {
          await goIdle(app);
          await push(app, snapshot(stage, { message: "the feed did not answer" }));
          if (lit) {
            await waitForPill(app, stage);
            // One sentence, and it is the same sentence in every live stage:
            // which update exists, never what is happening to it [F08].
            expect(await app.getElementText(PILL)).toContain(
              "Tug v0.9.0 is available",
            );
          } else {
            await letTimePass(app, 400);
            expect(await elementCount(app, PILL_ANCHOR)).toBe(0);
          }
        }
        note(
          "at0612 pill stages",
          JSON.stringify(pillStages.filter((p) => p[1]).map((p) => p[0])),
        );

        // ---- One anchor, top centre of the window -----------------------
        //
        // Inherited from the update-surface-anchor arc and the one thing this
        // rewrite keeps intact. Measured rather than read off the CSS:
        // `width: fit-content` under auto margins is the whole mechanism, and
        // a rule that computes to anything else — a stray `right:`, a
        // transform, a `flex-end` — shows up here as a centre that is not the
        // window's.
        await goIdle(app);
        await push(app, snapshot("available"));
        await waitForPill(app, "available");
        const pillBox = await anchoredBox(app, PILL_ANCHOR);
        note("at0612 anchor", JSON.stringify(pillBox));
        expect(
          Math.abs(centreX(pillBox) - pillBox.windowWidth / 2),
        ).toBeLessThanOrEqual(1);
        // Pinned to the top edge, not dropped below it. Pinned down to the
        // pixel on purpose: the offset this replaced was `--tug-chrome-height`
        // plus a gap, which is a *card's* title-bar height applied to an
        // overlay root that covers the whole window and has no chrome above it
        // — so the pill cleared a bar that was not there and floated in the
        // canvas gap. A tolerance band is what let that read as passing, and an
        // exact zero is the only assertion that says "against the edge".
        expect(pillBox.top).toBe(0);

        // The label is not clipped. The label rides its own span so a narrow
        // window ellipsizes rather than clips, and that span hides its
        // overflow — with a line box exactly the font size, the bottom of the
        // `g` in *Tug* was being cut off. Measured as overflow rather than read
        // off the line-height, because what matters is whether any ink is
        // outside the box that clips it, and that is the thing a later change
        // to the font or the pill's metrics would break.
        const labelOverflow = await app.evalJS<{
          scrollHeight: number;
          clientHeight: number;
        }>(
          `(function () {
             var el = document.querySelector('${PILL} .tugx-update-pill-text');
             if (el === null) return null;
             return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
           })()`,
        );
        note("at0612 pill label", JSON.stringify(labelOverflow));
        expect(labelOverflow.scrollHeight).toBeLessThanOrEqual(
          labelOverflow.clientHeight,
        );

        // The `x` is inside the pill, not hanging off it. It used to be a bare
        // sibling beyond the fill's right edge, floating over whatever the
        // canvas had at that spot and reading as a second, unrelated object.
        // Measured as containment in the painted box, which is the fact the
        // eye is actually reporting.
        const hideInside = await app.evalJS<{
          fill: { left: number; right: number; top: number; bottom: number };
          hide: { left: number; right: number; top: number; bottom: number };
        }>(
          `(function () {
             var fill = document.querySelector('.tugx-update-pill');
             var hide = document.querySelector(${JSON.stringify(PILL_HIDE)});
             if (fill === null || hide === null) return null;
             var f = fill.getBoundingClientRect();
             var h = hide.getBoundingClientRect();
             return {
               fill: { left: f.left, right: f.right, top: f.top, bottom: f.bottom },
               hide: { left: h.left, right: h.right, top: h.top, bottom: h.bottom },
             };
           })()`,
        );
        note("at0612 pill hide", JSON.stringify(hideInside));
        expect(hideInside.hide.left).toBeGreaterThanOrEqual(
          hideInside.fill.left,
        );
        expect(hideInside.hide.right).toBeLessThanOrEqual(
          hideInside.fill.right,
        );
        expect(hideInside.hide.top).toBeGreaterThanOrEqual(hideInside.fill.top);
        expect(hideInside.hide.bottom).toBeLessThanOrEqual(
          hideInside.fill.bottom,
        );

        // ---- Door one: the pill opens the wizard [B01] -------------------
        //
        // And the pill goes away while it is open, because the two say the
        // same thing and the wizard says it better.
        await clearPosted(app);
        await waitForClickable(app, PILL);
        await app.click(PILL);
        await waitForWizard(app, "available");
        expect(await elementCount(app, PILL_ANCHOR)).toBe(0);
        // Opening is not a decision: nothing crossed the bridge.
        expect(await postedActions(app)).toEqual([]);
        note("at0612 pill door", "click opens the wizard, pill stands down");

        // ---- Closing is pause [B04] -------------------------------------
        //
        // Close posts nothing on a non-terminal stage, the host's stage is
        // untouched — so the pill comes straight back, still saying an update
        // is available.
        await waitForClickable(app, CLOSE);
        expect(await app.getElementText(CLOSE)).toContain("Close");
        await app.click(CLOSE);
        await waitForWizardGone(app);
        await waitForPill(app, "available");
        expect(await postedActions(app)).toEqual([]);

        // ---- Door two: a bumped reveal opens it in EVERY stage [B06] -----
        //
        // `idle` included. That is not a curiosity: the Tug-menu item is
        // enabled in every stage and opens the wizard on its Check row when
        // there is no flow at all, which is the whole of what the menu item
        // does now.
        for (const stage of [
          "idle",
          "checking",
          "available",
          "downloading",
          "extracting",
          "readyToInstall",
          "installing",
          "upToDate",
          "error",
        ]) {
          await goIdle(app);
          await clearPosted(app);
          await push(
            app,
            snapshot(stage, {
              message: "the feed did not answer",
              revealCount: nextReveal(),
            }),
          );
          await waitForWizard(app, stage);
          // A reveal posts nothing back: it is the host asking to be looked
          // at, not a decision.
          expect(await postedActions(app)).toEqual([]);
        }
        note("at0612 reveal door", `opened in 9 stages, last count ${reveal}`);

        // The same count again is the replay a reload gets, and it is inert:
        // a wizard the user closed stays closed.
        await goIdle(app);
        await push(app, snapshot("available", { revealCount: nextReveal() }));
        await waitForWizard(app, "available");
        await waitForClickable(app, CLOSE);
        await app.click(CLOSE);
        await waitForWizardGone(app);
        // No bump: `snapshot` carries the standing count, which is exactly the
        // number the deck has already acted on.
        await push(app, snapshot("available", { userInitiated: true }));
        await letTimePass(app, 500);
        expect(await elementCount(app, WIZARD)).toBe(0);
        note("at0612 replay", "the same count re-read opens nothing");

        // ---- Four rows, always, and the dot says where the flow is [B02]
        //
        // Unpacking is the download row's detail phase rather than a fourth
        // row: the user named four steps, and "Verifying the signature…" is a
        // sentence about the download rather than a step anybody can act on.
        //
        // The third column is the deck's row, and on this deck it has one
        // answer: nothing is mid-turn, so it is pending until the download
        // lands and done from there. Its other branch is a unit test.
        const stepCases: Array<[string, string[]]> = [
          ["idle", ["active", "pending", "pending", "pending"]],
          ["checking", ["busy", "pending", "pending", "pending"]],
          ["available", ["done", "active", "pending", "pending"]],
          ["downloading", ["done", "busy", "pending", "pending"]],
          ["extracting", ["done", "busy", "pending", "pending"]],
          ["readyToInstall", ["done", "done", "done", "active"]],
          ["installing", ["done", "done", "done", "busy"]],
          ["upToDate", ["done", "pending", "pending", "pending"]],
          // A failure lands on the row that was waiting. Reached from idle,
          // that row is Check — the snapshot never says which step failed, so
          // a red dot anywhere else would assert something nobody reported.
          ["error", ["error", "pending", "pending", "pending"]],
        ];
        for (const [stage, statuses] of stepCases) {
          await goIdle(app);
          await push(
            app,
            snapshot(stage, {
              message: "the feed did not answer",
              revealCount: nextReveal(),
            }),
          );
          await waitForWizard(app, stage);
          expect(await elementCount(app, STEP_ROWS)).toBe(4);
          expect(await stepKeys(app)).toEqual([
            "check",
            "download",
            "stop-work",
            "relaunch",
          ]);
          // The labels are the same four in every stage and carry no version:
          // the panel's title says which update this is, and a label that grew
          // and shrank with the version number was the one row that reflowed.
          expect(await stepLabels(app)).toEqual([
            "Check for an update",
            "Download the update",
            "Stop work in flight",
            "Install and relaunch",
          ]);
          const read = await stepStatuses(app);
          note(`at0612 steps ${stage}`, JSON.stringify(read));
          expect(read).toEqual(statuses);
        }
        // No bar survived the rewrite, in any stage. Addressed by variant
        // rather than by `role="progressbar"`: every step row's dot is a
        // `TugProgressIndicator` and carries that role too, so the role alone
        // would be counting the very rows the bar was replaced by.
        expect(await elementCount(app, `[data-variant="bar"]`)).toBe(0);
        expect(
          await elementCount(app, `${WIZARD} [data-variant="pulsing-dot"]`),
        ).toBe(4);

        // ---- The check row says which Tug you are running ---------------
        //
        // The one fact the panel could not otherwise give them: the title says
        // which flow they are in, never which version is on disk. Same sentence
        // shape at every stage that has something to say — what you have, then
        // what that means for you.
        const detailCases: Array<[string, string]> = [
          ["idle", "You have Tug v0.8.10. Look for a newer version."],
          ["available", "You have Tug v0.8.10. Tug v0.9.0 is available."],
          ["upToDate", "You have the latest version, Tug v0.8.10."],
        ];
        for (const [stage, detail] of detailCases) {
          await goIdle(app);
          await push(app, snapshot(stage, { revealCount: nextReveal() }));
          await waitForWizard(app, stage);
          const read = await checkDetail(app);
          note(`at0612 check detail ${stage}`, read);
          expect(read).toBe(detail);
        }

        // ---- Close then reopen lands on the same step [B04] --------------
        //
        // The wizard holds no flow state of its own: it is a reading of the
        // host's snapshot, so what it shows after a close and a reopen is
        // whatever the flow has reached — here, unchanged, which is the case
        // a wizard with its own step counter would get wrong.
        await goIdle(app);
        await push(app, snapshot("readyToInstall", { revealCount: nextReveal() }));
        await waitForWizard(app, "readyToInstall");
        const beforeClose = await stepStatuses(app);
        await clearPosted(app);
        await waitForClickable(app, CLOSE);
        await app.click(CLOSE);
        await waitForWizardGone(app);
        // Paused, not dismissed: Sparkle was answered nothing and the pill is
        // back, so the update is exactly as live as it was.
        expect(await postedActions(app)).toEqual([]);
        await waitForPill(app, "readyToInstall");
        await waitForClickable(app, PILL);
        await app.click(PILL);
        await waitForWizard(app, "readyToInstall");
        expect(await stepStatuses(app)).toEqual(beforeClose);
        note("at0612 reopen", JSON.stringify(beforeClose));

        // And a stage that moved while the wizard was shut is where it lands.
        await waitForClickable(app, CLOSE);
        await app.click(CLOSE);
        await waitForWizardGone(app);
        await push(app, snapshot("installing", { revealCount: nextReveal() }));
        await waitForWizard(app, "installing");
        expect(await stepStatuses(app)).toEqual(["done", "done", "done", "busy"]);

        // ---- The pill's `x` hides, and hides only -----------------------
        //
        // It answers Sparkle nothing — no action crosses the bridge — so the
        // update stays as live as it was and the host's stage is untouched.
        // `dismiss` could not have done this job: it is already a Sparkle
        // reply, and it ends the session.
        await goIdle(app);
        await push(app, snapshot("available"));
        await waitForPill(app, "available");
        await clearPosted(app);
        await waitForClickable(app, PILL_HIDE);
        await app.click(PILL_HIDE);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PILL_ANCHOR)}) === null`,
          { timeoutMs: 10_000 },
        );
        expect(await postedActions(app)).toEqual([]);

        // A hidden pill stays hidden across a stage transition: a hide the
        // next transition undid would be worth nothing at the stages a user
        // reaches for it.
        await push(app, snapshot("readyToInstall"));
        await letTimePass(app, 500);
        expect(await elementCount(app, PILL_ANCHOR)).toBe(0);
        expect(await postedActions(app)).toEqual([]);

        // The menu door still works over a hidden pill — which is the case
        // hiding has to leave intact, since the pill is the only other way in.
        await push(app, snapshot("readyToInstall", { revealCount: nextReveal() }));
        await waitForWizard(app, "readyToInstall");
        await waitForClickable(app, CLOSE);
        await app.click(CLOSE);
        await waitForWizardGone(app);

        // And the host saying there is nothing to say, then something new,
        // brings the pill back: hidden belongs to this flow, not to the deck.
        await goIdle(app);
        await push(app, snapshot("available"));
        await waitForPill(app, "available");
        note("at0612 hide", "x hides for this flow, posts nothing, survives the next stage");

        await goIdle(app);
      }),
    TEST_TIMEOUT_MS,
  );
});
