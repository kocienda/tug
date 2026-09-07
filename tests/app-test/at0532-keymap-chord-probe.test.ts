/**
 * at0532-keymap-chord-probe.test.ts — asking what a chord means, without
 * binding it.
 *
 * The probe exists because the only way to ask before it was to borrow a
 * row's Change button, which left the user one keystroke from rebinding a
 * command they had opened purely to interrogate. So the claim this file pins
 * is a conjunction, and the second half is the point:
 *
 *   1. the probe really owns the keyboard while it listens — a chord that
 *      currently MEANS something is read rather than fired; and
 *   2. nothing moved. No override was written, and the chord it just reported
 *      on still belongs to the command it belonged to before.
 *
 * The observable for (1) is the same one AT0182 uses for the row capture: the
 * host parks every menu key equivalent while a capture is armed, so a menu
 * item going chordless and coming back is the arming and disarming seen from
 * outside the web view. That also pins "one press, one answer" — the probe
 * disarms itself, so the parked menu comes back with no gesture from the test.
 *
 * `view.zoomOut` is the subject for AT0182's reasons: unconditionally
 * present, holding a chord the registry states, in a menu that rebuilds on
 * every open.
 *
 * The pane's rendering is not asserted beyond the testids the pane publishes
 * for exactly this purpose — the verdict's text is the feature, so its text
 * is read, and nothing else about the DOM is.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/cards/settings-keymap-probe.ts
 * @covers tugdeck/src/components/tugways/use-chord-capture.ts
 * @covers tugdeck/src/components/tugways/cards/settings-keymap-body.tsx
 * @covers tugdeck/src/components/tugways/cards/settings-keymap-rows.ts
 * @covers tugdeck/src/components/tugways/chord-capture-state.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const COMMAND = 1 << 20;

async function waitKeyEquivalent(
  app: App,
  identifier: string,
  want: string,
  timeoutMs = 8000,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: string | undefined;
  while (Date.now() < deadline) {
    const state = await app.menuItemState(identifier);
    last = state.found ? state.keyEquivalent : undefined;
    if (last === want) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

/** The verdict line's text, or `""` while the strip has nothing to say. */
async function verdictText(app: App): Promise<string> {
  return app.evalJS<string>(
    `document.querySelector('[data-testid="settings-keymap-probe-verdict"]')?.textContent ?? ""`,
  );
}

/**
 * How many command rows the list currently holds. The probe row carries its
 * own testid rather than the `keymap-row-` prefix, so it is never counted as
 * a search result.
 */
async function rowCount(app: App): Promise<number> {
  return app.evalJS<number>(
    `document.querySelectorAll('[data-testid^="keymap-row-"]').length`,
  );
}

async function openKeyboardCard(app: App): Promise<void> {
  await app.waitForCondition<boolean>(
    `typeof window.__tug !== "undefined" && typeof window.tugdeck !== "undefined"`,
  );
  await app.evalJS(
    `window.__tug.dispatchControlAction("show-keyboard-shortcuts", {})`,
  );
  await app.waitForCondition<boolean>(
    `document.querySelector('[data-testid="settings-keymap-probe"]') !== null`,
    { timeoutMs: 8000 },
  );
}

/**
 * Arm the probe and wait until the menu bar is actually parked.
 *
 * The park is a message hop, not a synchronous write, so pressing a chord
 * before it lands would test AppKit's key-equivalent scan rather than the
 * probe. AT0182 waits on the same signal for the same reason.
 */
async function armProbe(app: App): Promise<void> {
  await app.click('[data-testid="settings-keymap-probe-arm"]');
  await app.waitForCondition<boolean>(
    `document.querySelector('[data-testid="settings-keymap-probe"] [data-testid="keymap-capture"]') !== null`,
    { timeoutMs: 6000 },
  );
  expect(
    await waitKeyEquivalent(app, "view.zoomOut", ""),
    "arming the probe parks the menu bar's key equivalents",
  ).toBe("");
}

describe.skipIf(!SHOULD_RUN)("AT0532: the Keyboard pane's chord probe", () => {
  test(
    "a bound chord is reported and the list narrows to it — and nothing is rebound",
    async () => {
      const app = await launchTugApp({ testName: "at0532-taken" });
      try {
        await openKeyboardCard(app);

        const allRows = await rowCount(app);
        expect(allRows, "the pane starts unnarrowed").toBeGreaterThan(1);
        expect(
          await waitKeyEquivalent(app, "view.zoomOut", "-"),
          "Zoom Out starts on ⌘-",
        ).toBe("-");

        await armProbe(app);

        // ⌘- is Zoom Out's own live chord. Pressing it mid-probe has to land
        // in the reader rather than zooming the page — which is the whole
        // reason the probe shares the row capture's arming.
        await app.nativeKey("-", ["cmd"]);
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="settings-keymap-probe-verdict"]') !== null`,
          { timeoutMs: 6000 },
        );

        const verdict = await verdictText(app);
        expect(verdict, "the verdict names the chord").toContain("-");
        expect(verdict, "the verdict names the command that has it").toContain(
          "Zoom Out",
        );

        // One press, one answer: the probe disarmed itself, so the parked
        // menu bar comes back with no gesture from the test.
        expect(
          await waitKeyEquivalent(app, "view.zoomOut", "-"),
          "the probe disarmed on its own answer and unparked the menu bar",
        ).toBe("-");
        expect(
          await app.evalJS<boolean>(
            `document.querySelector('[data-testid="settings-keymap-probe"] [data-testid="keymap-capture"]') === null`,
          ),
          "the reader is gone, so nothing is still swallowing keys",
        ).toBe(true);

        // The second half of "what has this chord": the row itself.
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="keymap-row-zoom-out"]') !== null`,
          { timeoutMs: 6000 },
        );
        const narrowed = await rowCount(app);
        expect(narrowed, "the list narrowed to the claimant").toBeLessThan(
          allRows,
        );

        // The claim the whole feature rests on: asking changed nothing. Zoom
        // Out still holds its own chord, at its own modifier mask.
        const state = await app.menuItemState("view.zoomOut");
        expect(state.found ? state.keyEquivalent : undefined).toBe("-");
        expect(
          state.found ? state.modifierMask : undefined,
          "no override was written by asking",
        ).toBe(COMMAND);
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0532-taken] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "arming is exclusive: the probe and a row capture cannot both be up",
    async () => {
      // Two armed readers both see the same keydown, and `chordCaptureState`
      // is a COUNT rather than a lock — so nothing downstream would have
      // caught this. The pane holds one arming slot, and the exclusivity is
      // that slot rather than two flags that have to agree.
      const app = await launchTugApp({ testName: "at0532-exclusive" });
      try {
        await openKeyboardCard(app);
        await app.type('[data-testid="settings-keymap-filter"] input', "Zoom Out");
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="keymap-arm-zoom-out"]') !== null`,
          { timeoutMs: 8000 },
        );

        // Arm a command row's Change, then reach for Test.
        await app.click('[data-testid="keymap-arm-zoom-out"]');
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="keymap-row-zoom-out"] [data-testid="keymap-capture"]') !== null`,
          { timeoutMs: 6000 },
        );
        await app.click('[data-testid="settings-keymap-probe-arm"]');
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="settings-keymap-probe"] [data-testid="keymap-capture"]') !== null`,
          { timeoutMs: 6000 },
        );
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll('[data-testid="keymap-capture"]').length`,
          ),
          "arming the probe closed the row's capture",
        ).toBe(1);

        // And back the other way.
        await app.click('[data-testid="keymap-arm-zoom-out"]');
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="keymap-row-zoom-out"] [data-testid="keymap-capture"]') !== null`,
          { timeoutMs: 6000 },
        );
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll('[data-testid="keymap-capture"]').length`,
          ),
          "arming a row closed the probe's capture",
        ).toBe(1);

        // The surviving reader is the one that gets the chord — and it is a
        // rebind capture, so the chord lands pending rather than as a verdict.
        await app.nativeKey("y", ["cmd", "ctrl"]);
        await app.waitForCondition<boolean>(
          `(document.querySelector('[data-testid="keymap-capture"] [data-pending="true"]')?.textContent ?? "").includes("Y")`,
          { timeoutMs: 6000 },
        );
        expect(
          await app.evalJS<boolean>(
            `document.querySelector('[data-testid="settings-keymap-probe-verdict"]') === null`,
          ),
          "the disarmed probe read nothing, so it has no verdict to show",
        ).toBe(true);

        await app.click('[data-testid="keymap-capture-cancel"]');
        expect(
          await waitKeyEquivalent(app, "view.zoomOut", "-"),
          "cancelling leaves the keymap where it was",
        ).toBe("-");
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0532-exclusive] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an unclaimed chord reads free and leaves the list alone",
    async () => {
      const app = await launchTugApp({ testName: "at0532-free" });
      try {
        await openKeyboardCard(app);
        const allRows = await rowCount(app);

        await armProbe(app);

        // ⌃⌥⌘J: nothing in the shipped table claims it. A free verdict is the
        // answer the user came for, and it narrows nothing — there is no row
        // to show, and emptying the list would read as "no results" rather
        // than as "yes, take it".
        await app.nativeKey("j", ["cmd", "alt", "ctrl"]);
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="settings-keymap-probe-verdict"]') !== null`,
          { timeoutMs: 6000 },
        );

        const verdict = await verdictText(app);
        expect(verdict, "an unclaimed chord reads free").toContain("free");
        expect(
          await app.evalJS<string>(
            `document.querySelector('[data-testid="settings-keymap-probe-verdict"]')?.getAttribute("data-kind") ?? ""`,
          ),
        ).toBe("free");

        expect(
          await rowCount(app),
          "a free verdict narrows nothing",
        ).toBe(allRows);
        expect(
          await waitKeyEquivalent(app, "view.zoomOut", "-"),
          "the menu bar is unparked and untouched",
        ).toBe("-");
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0532-free] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
