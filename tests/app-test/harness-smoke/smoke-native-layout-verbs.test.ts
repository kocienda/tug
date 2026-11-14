/**
 * smoke-native-layout-verbs.test.ts — the keyboard-layout harness verbs, as
 * a host run sees them.
 *
 * Selecting an input source changes the keyboard of every app in the login
 * session, so `selectInputSource` acts only in a lab guest (`TUG_LAB=1`, set by
 * `just lab-app-test`) and refuses everywhere else. This file pins that refusal
 * on the host — where asserting it changes nothing — together with the verbs
 * that are safe anywhere: listing the input sources, declaring a keyboard type,
 * pressing a key by its `KeyboardEvent.code`, and the menu key probe, which
 * records the item a key equivalent reaches instead of performing it.
 *
 * It is skipped inside a lab run, where the refusal would not happen; the lab's
 * own tests exercise the selection.
 *
 * @covers tests/app-test/_harness/
 * @covers tugapp/Sources/TestHarness/
 * @family smoke-native
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "../_harness";
import { LabOnlyError } from "../_harness/errors";
import {
  SHOULD_RUN,
  waitForPaintSettled,
  seedOverlay,
  removeOverlay,
} from "./smoke-native-fixture";

const IN_LAB = process.env.TUG_LAB === "1";

describe.skipIf(!SHOULD_RUN || IN_LAB)("keyboard-layout verbs on the host", () => {
  test("selectInputSource refuses outside the lab; the safe verbs answer", async () => {
    const app = await launchTugApp({ testName: "smoke-native-layout-verbs" });
    const fixtureId = "smoke-native-fx-layout";
    try {
      await waitForPaintSettled(app);

      // Listing is read-only and answers anywhere; the current source is
      // one of the selectable ones.
      const before = await app.inputSources();
      expect(before.current).not.toBeNull();
      expect(before.sources.map((s) => s.id)).toContain(before.current as string);

      // The refusal names the flag, and nothing moved.
      let refusal: unknown = null;
      try {
        await app.selectInputSource("com.apple.keylayout.French");
      } catch (e) {
        refusal = e;
      }
      expect(refusal).toBeInstanceOf(LabOnlyError);
      expect((refusal as Error).message).toContain("TUG_LAB=1");
      expect((await app.inputSources()).current).toBe(before.current);

      // A keyboard type declared, then cleared, answers with what it replaced.
      const iso = await app.setKeyboardType("iso");
      expect(iso.previous).toBeNull();
      expect(iso.current).toBe(41);

      // A key pressed by position arrives as that position, with its
      // modifier, while the ISO declaration is in force.
      await seedOverlay(
        app,
        fixtureId,
        `<input id="smoke-layout-input" type="text" value="hello" style="width: 300px; height: 32px; font-size: 16px;" />`,
      );
      await waitForPaintSettled(app);
      await app.evalJS(`
        window.__smokeLayoutResult = null;
        document.getElementById("smoke-layout-input").addEventListener(
          "keydown",
          function (e) {
            if (/^(Meta|Shift|Alt|Control)(Left|Right)$/.test(e.code)) return;
            // Claimed, as the cmd-a smoke claims its own: an unclaimed ⌘A on a
            // bare input falls through to the no-responder beep.
            if (e.metaKey && e.code === "KeyA") e.preventDefault();
            if (window.__smokeLayoutResult !== null) return;
            window.__smokeLayoutResult = {
              isTrusted: e.isTrusted,
              code: e.code,
              metaKey: e.metaKey,
              shiftKey: e.shiftKey,
            };
          },
          { capture: true },
        );
      `);
      await app.nativeClickAtElement("#smoke-layout-input");
      await app.waitForCondition(
        `document.activeElement === document.getElementById("smoke-layout-input")`,
      );
      await app.nativeKeyCode("KeyA", ["cmd"]);
      await app.waitForCondition("window.__smokeLayoutResult !== null");
      const pressed = await app.evalJS<{
        isTrusted: boolean;
        code: string;
        metaKey: boolean;
        shiftKey: boolean;
      }>("window.__smokeLayoutResult");
      expect(pressed).toEqual({ isTrusted: true, code: "KeyA", metaKey: true, shiftKey: false });

      // The menu key probe: ⌘, held past the deck reaches the menu bar's ⌘,
      // item, which is recorded and not performed.
      await app.evalJS(`
        window.addEventListener("keydown", function (e) {
          if (e.code === "Comma") e.stopPropagation();
        }, true);
      `);
      await app.armMenuKeyProbe();
      await app.nativeKeyCode("Comma", ["cmd"]);
      let fired: Awaited<ReturnType<typeof app.takeMenuKeyFires>> = [];
      const deadline = Date.now() + 2000;
      while (fired.length === 0 && Date.now() < deadline) {
        fired = await app.takeMenuKeyFires();
        if (fired.length === 0) await Bun.sleep(25);
      }
      expect(fired.map((f) => [f.keyEquivalent, f.modifiers])).toEqual([[",", ["cmd"]]]);
      await app.disarmMenuKeyProbe();

      const cleared = await app.setKeyboardType(null);
      expect(cleared.previous).toBe(41);
      expect(cleared.current).toBe(cleared.system);
    } finally {
      try {
        await removeOverlay(app, fixtureId);
      } catch {
        // best-effort cleanup
      }
      await app.close();
    }
  });
});
