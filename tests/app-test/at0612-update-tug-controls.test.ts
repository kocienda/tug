/**
 * AT0612: the update feature — one pill and one wizard — driven entirely from the bridge:
 * what every control posts, and what progress says.
 *
 * The contract with the host is the whole of what this test speaks: state in
 * on `window.__tugBridge.onUpdateState`, one action name out on
 * `updateAction`, read back through a recorder that swallows it so no click
 * here reaches Sparkle. `[B##]` and `[F##]` are `briefs/update-tug-brief.md`.
 *
 * `at0612-update-tug-pill.test.ts` names the seven claims the update feature
 * rests on and pins the first five; this file pins the rest:
 *
 * - **Every control posts its action, and changes nothing else.** Each stage
 *   offers exactly the controls the flow allows there, and a press posts one
 *   name; `retry` and `resume` survive the `idle` waypoint the host passes
 *   through on the way to their next stage. The two terminal stages, `upToDate`
 *   and `error`, acknowledge with `dismiss` [B04].
 * - **Progress is words on one span, never a render** [L06] (claim 6).
 * - **A download can be stopped, and what that costs is said first** (claim 7):
 *   *Pause*, the bytes named on the download row's own detail line, and
 *   *Resume* on the stopped row.
 *
 * The two were one file until it outgrew the 20 s budget;
 * `update-tug-fixture.ts` holds what they share.
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
  BAR,
  CLOSE,
  PROGRESS,
  ROW_EDGE,
  SHOULD_RUN,
  STEP_ROWS,
  TEST_TIMEOUT_MS,
  WIZARD,
  clearPosted,
  cta,
  elementCount,
  goIdle,
  letTimePass,
  nextReveal,
  postedActions,
  postedOnceIncludes,
  push,
  snapshot,
  stepStatuses,
  ui,
  waitForClickable,
  waitForWizard,
  waitForWizardGone,
  withUpdateDeck,
  type Payload,
} from "./update-tug-fixture";

describe.skipIf(!SHOULD_RUN)("AT0612: what every update control posts, and what progress says", () => {
  test(
    "every control posts its action, the terminal stages dismiss, progress is words on one span, and a stop says its cost",
    () =>
      withUpdateDeck("at0612-update-tug-controls", async (app) => {
        // ---- The controls each stage offers, and what they post ---------
        //
        // A click posts and changes nothing else — the recorder swallows the
        // action, so the wizard stays exactly as it is and the next control is
        // ready to press.
        //
        // `install` appears twice and means two different presses: Download at
        // `available`, Install and Relaunch at `readyToInstall`. Only the
        // second one waits on the Stop-work row, and with nothing running in
        // this deck that row is already done — so the install press is offered
        // and posts `install` with nothing in the way, which is the branch
        // asserted here [B04].
        const controlCases: Array<{
          stage: string;
          over?: Partial<Payload>;
          actions: string[];
        }> = [
          { stage: "idle", actions: ["check"] },
          { stage: "checking", over: { cancellable: true }, actions: ["cancel"] },
          { stage: "available", actions: ["install"] },
          { stage: "downloading", over: { cancellable: true }, actions: ["pause"] },
          { stage: "paused", actions: ["resume"] },
          { stage: "readyToInstall", actions: ["install"] },
          { stage: "error", over: { message: "the feed did not answer" }, actions: ["retry"] },
          { stage: "extracting", actions: [] },
          { stage: "installing", actions: [] },
        ];

        for (const { stage, over, actions } of controlCases) {
          await goIdle(app);
          await push(
            app,
            snapshot(stage, { ...over, revealCount: nextReveal() }),
          );
          await waitForWizard(app, stage);

          if (actions.length === 0) {
            // A stage with nothing to decide offers nothing to press: the two
            // stages the user can only wait through.
            expect(
              await elementCount(app, `${WIZARD} .update-tug-step button`),
            ).toBe(0);
            note(`at0612 controls ${stage}`, "none");
            continue;
          }

          for (const action of actions) {
            await clearPosted(app);
            const target = cta(action);
            await waitForClickable(app, target);
            await ui(app).click(target);
            try {
              await app.waitForCondition<boolean>(
                `window.__at0612.posted.length > 0`,
                { timeoutMs: 10_000 },
              );
            } catch (err) {
              note(
                `at0612 no post from ${stage}/${action}`,
                await ui(app).evalJS<string>(
                  `(function () {
                     var d = document.querySelector(${JSON.stringify(WIZARD)});
                     var t = document.querySelector(${JSON.stringify(target)});
                     return JSON.stringify({
                       wizardStage: d === null ? null : d.getAttribute("data-stage"),
                       targetFound: t !== null,
                       targetText: t === null ? null : (t.textContent || "").trim(),
                       targetDisabled: t === null ? null : t.disabled,
                     });
                   })()`,
                ),
              );
              throw err;
            }
            note(`at0612 posted`, `${stage}/${action}`);
            expect(await postedActions(app)).toEqual([action]);
            // A press posts and nothing more: the wizard it was pressed in is
            // still open, on the stage it was pressed on [B04].
            expect(await elementCount(app, WIZARD)).toBe(1);
          }
        }

        // ---- Retry survives the host's `idle` waypoint ------------------
        //
        // The host answers `retry` by acknowledging the old notice, publishing
        // `dismissed` — a real `idle` snapshot, which the deck really receives
        // — and only then starting the check that lands on `checking`. The
        // wizard closes itself on `idle`, because `idle` is normally the flow
        // being over; read literally that rule takes the whole surface away in
        // answer to the one press that asked for the opposite, and nothing
        // brings it back, since the pill does not show for `checking`.
        //
        // Nothing above catches this: the recorder swallows the action, so no
        // test that only presses Retry ever sees the snapshots the host would
        // have sent. This one plays them.
        await goIdle(app);
        await clearPosted(app);
        await push(
          app,
          snapshot("error", {
            message: "the feed did not answer",
            revealCount: nextReveal(),
          }),
        );
        await waitForWizard(app, "error");
        await waitForClickable(app, cta("retry"));
        await ui(app).click(cta("retry"));
        await app.waitForCondition<boolean>(
          `window.__at0612.posted.length > 0`,
          { timeoutMs: 10_000 },
        );
        expect(await postedActions(app)).toEqual(["retry"]);

        // The waypoint, then the check it was on the way to.
        await push(app, snapshot("idle"));
        await letTimePass(app, 400);
        expect(await elementCount(app, WIZARD)).toBe(1);
        await push(app, snapshot("checking", { cancellable: true }));
        await waitForWizard(app, "checking");
        note("at0612 retry", "survives the idle waypoint and lands on checking");

        // And the suppression is spent: the next `idle` is the flow ending,
        // and it closes the wizard the way every other `idle` does.
        await push(app, snapshot("idle"));
        await waitForWizardGone(app);

        // ---- Stopping a download says what it costs, first ---------------
        //
        // The `file:` spike ruled out a resumable download, so the press
        // throws away what has arrived. That is a thing a user has to be told
        // *before* they press it, so the download row's detail line closes on
        // it while the transfer is still running — one painted span rather than
        // a second line, because a second line would make this row taller than
        // the three beside it. Read from the DOM rather than inferred from the
        // snapshot pushed, because the store subscription is what writes it.
        await goIdle(app);
        await clearPosted(app);
        await push(
          app,
          snapshot("downloading", {
            cancellable: true,
            percent: 25,
            receivedBytes: 12_400_000,
            expectedBytes: 48_100_000,
            revealCount: nextReveal(),
          }),
        );
        await waitForWizard(app, "downloading");
        const cost = await ui(app).evalJS<string>(
          `(function () {
             var el = document.querySelector(${JSON.stringify(PROGRESS)});
             return el === null ? "" : (el.textContent || "").trim();
           })()`,
        );
        note("at0612 stop cost", cost);
        expect(cost).toContain("12.4 MB");
        expect(cost).toContain("stopping discards it");
        // And it has no element of its own to be found under.
        expect(await elementCount(app, `[data-testid="update-tug-stop-cost"]`)).toBe(0);

        // The bar is chrome on the plinth rather than content in the column,
        // which is what lets a row gain one without growing: it is a child of
        // the row's edge strip, and the row's `main` holds no bar at all.
        expect(await elementCount(app, `${STEP_ROWS} ${ROW_EDGE} ${BAR}`)).toBe(1);
        expect(
          await elementCount(app, `${STEP_ROWS} .tug-step-row-main ${BAR}`),
        ).toBe(0);

        // *Pause*, not *Cancel*, which would say the update is being given up
        // rather than the download. The detail line says the bytes go.
        expect(await ui(app).getElementText(cta("pause"))).toContain("Pause");

        await waitForClickable(app, cta("pause"));
        await ui(app).click(cta("pause"));
        await app.waitForCondition<boolean>(
          `window.__at0612.posted.length > 0`,
          { timeoutMs: 10_000 },
        );
        expect(await postedActions(app)).toEqual(["pause"]);

        // The host's answer: the stage the driver publishes when it has
        // cancelled Sparkle's download and kept the update in hand.
        await push(app, snapshot("paused"));
        await waitForWizard(app, "paused");
        // Held, not failed: the second row's dot is the amber one, and the
        // download row's bar is gone because nothing is moving.
        expect(await stepStatuses(app)).toEqual([
          "done",
          "paused",
          "pending",
          "pending",
        ]);
        expect(await elementCount(app, BAR)).toBe(0);
        note("at0612 stopped", (await stepStatuses(app)).join("/"));

        // And the way out of it is Resume, which the host answers with a
        // fresh check — the wizard's own `idle` waypoint suppression, the
        // same one Retry uses, is what keeps the panel standing through it.
        await clearPosted(app);
        await waitForClickable(app, cta("resume"));
        await ui(app).click(cta("resume"));
        await app.waitForCondition<boolean>(
          `window.__at0612.posted.length > 0`,
          { timeoutMs: 10_000 },
        );
        expect(await postedActions(app)).toEqual(["resume"]);
        await push(app, snapshot("idle"));
        await letTimePass(app, 400);
        expect(await elementCount(app, WIZARD)).toBe(1);
        await push(app, snapshot("checking", { cancellable: true }));
        await waitForWizard(app, "checking");
        note("at0612 resume", "posts resume and survives the idle waypoint");
        await push(app, snapshot("idle"));
        await waitForWizardGone(app);

        // ---- The two terminal stages acknowledge, and only those ---------
        //
        // Sparkle will not finish its session without a reply to a notice, so
        // `upToDate` and `error` send `dismiss` on the way out. Every other
        // stage's Close sends nothing, which is what makes closing a pause.
        for (const [stage, label] of [
          ["upToDate", "Done"],
          ["error", "Dismiss"],
        ] as Array<[string, string]>) {
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
          expect(await ui(app).getElementText(CLOSE)).toContain(label);
          await waitForClickable(app, CLOSE);
          await ui(app).click(CLOSE);
          await waitForWizardGone(app);
          expect(await postedOnceIncludes(app, "dismiss")).toEqual(["dismiss"]);
          note(`at0612 terminal ${stage}`, `${label} posts dismiss`);
        }

        // ---- Progress is a bar and a sentence, and never a render [L06] --
        //
        // Both surfaces are painted from one store subscription: the detail
        // line's text and `data-progress`, and the bar's own
        // `aria-valuenow`. Reading the bar through ARIA rather than through
        // a measured width is deliberate — the width is a CSS `calc` over a
        // custom property, and a test that measured pixels would be testing
        // the layout engine. `aria-valuenow` is what the painter *claims*,
        // and it is also what a screen reader is told.
        await goIdle(app);
        await push(
          app,
          snapshot("downloading", {
            percent: null,
            cancellable: true,
            revealCount: nextReveal(),
          }),
        );
        await waitForWizard(app, "downloading");
        // No total yet: no attribute, and a phrase rather than a number,
        // because `null` is not zero.
        expect(
          await ui(app).getElementAttribute(PROGRESS, "data-progress"),
        ).toBeNull();
        expect(await ui(app).getElementText(PROGRESS)).toContain("Starting");
        // And the bar runs its barber pole rather than sitting at a literal
        // 0%: it claims no value and wears no `data-painted`.
        expect(await elementCount(app, BAR)).toBe(1);
        expect(await ui(app).getElementAttribute(BAR, "aria-valuenow")).toBeNull();
        expect(await ui(app).getElementAttribute(BAR, "data-painted")).toBeNull();

        const TOTAL = 48_100_000;
        // Spaced, on purpose. A rate is defined over elapsed time, and the
        // painter's estimator discards intervals under 20 ms rather than
        // dividing by something near zero — so pushes fired back to back
        // (this harness lands three in about 4 ms) measure nothing at all,
        // and a test that ran that fast would be asserting the guard rather
        // than the feature. 150 ms is a slow-ish real download's cadence.
        const SPACING_MS = 150;
        for (const percent of [7, 42, 99]) {
          await new Promise((r) => setTimeout(r, SPACING_MS));
          await push(
            app,
            snapshot("downloading", {
              percent,
              cancellable: true,
              receivedBytes: Math.round((TOTAL * percent) / 100),
              expectedBytes: TOTAL,
            }),
          );
          await ui(app).waitForCondition<boolean>(
            `(document.querySelector(${JSON.stringify(PROGRESS)})
                ?.getAttribute("data-progress")) === ${JSON.stringify(String(percent))}`,
            { timeoutMs: 10_000 },
          );
          const text = await ui(app).getElementText(PROGRESS);
          const rate = await ui(app).getElementAttribute(PROGRESS, "data-rate");
          note(`at0612 progress ${percent}%`, `${text}  [data-rate=${rate}]`);
          // Bytes, not a percent: the bar draws the fraction, and the line
          // says what the fraction cannot ([B06]).
          expect(text).toContain("48.1 MB");
          expect(text).not.toContain(`${percent}%`);

          // The bar moved with it. This is the assertion the whole painted
          // seam exists for — a bar wired through React state would still
          // pass every text assertion above.
          await ui(app).waitForCondition<boolean>(
            `(document.querySelector(${JSON.stringify(BAR)})
                ?.getAttribute("aria-valuenow")) === ${JSON.stringify(String(percent))}`,
            { timeoutMs: 10_000 },
          );
          expect(await ui(app).getElementAttribute(BAR, "data-painted")).not.toBeNull();
          note(`at0612 bar ${percent}%`, "aria-valuenow tracks the transfer");

          // The rate is measured on the deck rather than sent, so it is the
          // one part of the line no host fixture can fake ([B06]). The first
          // sample only anchors, so the rate appears from the second push on.
          if (percent !== 7) {
            expect(Number(rate), "a rate was measured").toBeGreaterThan(0);
            expect(text, "and the line says it").toContain("/s");
            // No time to go beside it, and that is the trade ([B05]): these
            // pushes are `cancellable`, so the line is carrying the stop-cost
            // warning, and all four clauses do not fit the 352px this row gives
            // its detail line — which `at0632` measures. The ETA is what goes,
            // because the bar and the byte count between them imply it and
            // nothing else in the panel says what stopping costs.
            expect(text, "the warning holds its place").toContain(
              "stopping discards it",
            );
            expect(text, "and the ETA is what yielded").not.toContain("left");
          }
        }

        // And with no *Pause* to warn about, the room goes back to the
        // ETA. The warning names a press, so it is there exactly where the
        // press is — which is also what keeps the line inside one row.
        //
        // Two pushes, because the first one goes *backwards* from 99% and a
        // reading that went backwards re-anchors the estimator rather than
        // reporting a negative rate — so the rate this asserts on is measured
        // across the second.
        for (const percent of [50, 60]) {
          await new Promise((r) => setTimeout(r, 150));
          await push(
            app,
            snapshot("downloading", {
              percent,
              cancellable: false,
              receivedBytes: Math.round((TOTAL * percent) / 100),
              expectedBytes: TOTAL,
            }),
          );
          await ui(app).waitForCondition<boolean>(
            `(document.querySelector(${JSON.stringify(PROGRESS)})
                ?.getAttribute("data-progress")) === ${JSON.stringify(String(percent))}`,
            { timeoutMs: 10_000 },
          );
        }
        const uncancellable = await ui(app).getElementText(PROGRESS);
        note("at0612 progress, no stop", uncancellable);
        expect(uncancellable).not.toContain("stopping");
        expect(uncancellable).toContain("left");
        expect(await elementCount(app, cta("pause"))).toBe(0);

        // The panel has not been re-rendered out from under itself: the span
        // that was there at 7% is the span that is there at 99%.
        expect(await elementCount(app, PROGRESS)).toBe(1);
        expect(await elementCount(app, BAR)).toBe(1);
        expect(await elementCount(app, WIZARD)).toBe(1);

        await goIdle(app);
      }),
    TEST_TIMEOUT_MS,
  );
});
