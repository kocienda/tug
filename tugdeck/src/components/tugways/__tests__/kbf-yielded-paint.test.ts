/**
 * A page that has yielded the keyboard wears the paint of the page holding it.
 *
 * The Overview engages keyboard-focus mode at rest and seeds its composer's
 * caret, and the mode's paint stands down for a live caret. With bodies the
 * caret is in the Overview's own page while the shell's deck engages the
 * mode, and the shell — which parks nothing while a body holds the keyboard —
 * read its own route as engine-routed and painted `data-kbf` beside the caret
 * (`at0365`). While the shell has yielded, its engine's paint answer is the
 * one the keyboard's body reports (`lib/yielded-kbf-paint.ts`); with no word
 * from it, or no yield, the engine reads its own route as before.
 *
 * @covers tugdeck/src/components/tugways/focus-manager.ts
 * @covers tugdeck/src/lib/yielded-kbf-paint.ts
 * @covers tugdeck/src/body/body-publisher.ts
 */
import { afterEach, describe, expect, test } from "bun:test";

import { FocusManager, observeFocusManagerRegistration, registerFocusManager } from "../focus-manager";
import { kbfPaintTelemetry } from "@/body/body-publisher";
import { ResponderChainManager } from "../responder-chain";
import { setKeyboardYield } from "@/lib/keyboard-yield";
import { setYieldedKbfPaintSource } from "@/lib/yielded-kbf-paint";

const releases: Array<() => void> = [];

function engaged(): FocusManager {
  const fm = new FocusManager();
  fm.attach(new ResponderChainManager());
  fm.setKbfManual(true);
  return fm;
}

afterEach(() => {
  while (releases.length > 0) releases.pop()?.();
});

describe("KBF paint across a keyboard yield", () => {
  test("an engaged, engine-routed page paints when it holds the keyboard", () => {
    const fm = engaged();
    expect(fm.kbfPainting()).toBe(true);
    expect(fm.computeProjection().kbf).toBe(true);
  });

  test("a page that has yielded wears the keyboard page's paint", () => {
    const fm = engaged();
    let theirs: boolean | null = false;
    releases.push(setKeyboardYield(() => true));
    releases.push(setYieldedKbfPaintSource(() => theirs));
    expect(fm.kbfPainting()).toBe(false);
    expect(fm.computeProjection().kbf).toBe(false);
    theirs = true;
    expect(fm.kbfPainting()).toBe(true);
  });

  test("with no word from the keyboard's page, the page reads its own route", () => {
    const fm = engaged();
    releases.push(setKeyboardYield(() => true));
    releases.push(setYieldedKbfPaintSource(() => null));
    expect(fm.kbfPainting()).toBe(true);
  });

  test("a page that holds the keyboard ignores the source", () => {
    const fm = engaged();
    releases.push(setKeyboardYield(() => false));
    releases.push(setYieldedKbfPaintSource(() => false));
    expect(fm.kbfPainting()).toBe(true);
  });

  test("a body says its paint once its engine registers, and hears the registration", () => {
    expect(kbfPaintTelemetry()).toEqual({});
    let heard = 0;
    releases.push(observeFocusManagerRegistration(() => (heard += 1)));
    const fm = engaged();
    registerFocusManager(fm);
    releases.push(() => registerFocusManager(null));
    expect(heard).toBe(1);
    expect(kbfPaintTelemetry()).toEqual({ kbfPaint: 1 });
    releases.push(setKeyboardYield(() => true));
    releases.push(setYieldedKbfPaintSource(() => false));
    expect(kbfPaintTelemetry()).toEqual({ kbfPaint: 0 });
  });

  test("the mode off paints nothing, whatever the keyboard's page says", () => {
    const fm = engaged();
    fm.setKbfManual(false);
    releases.push(setKeyboardYield(() => true));
    releases.push(setYieldedKbfPaintSource(() => true));
    expect(fm.kbfPainting()).toBe(false);
  });
});
