/**
 * A page that has yielded the keyboard wears the paint of the page holding it.
 *
 * The Overview engages keyboard-focus mode at rest and seeds its composer's
 * caret, and the mode's paint stands down for a live caret. With bodies the
 * caret is in the Overview's own page while the shell's deck engages the
 * mode, and the shell — which parks nothing while a body holds the keyboard —
 * read its own route as engine-routed and painted `data-kbf` beside the caret
 * (`at0365`). While the shell has yielded, its engine's paint answer is the
 * one the keyboard's body reports (`card.kbfPaint`, for the body the yield
 * names); with no word from it, or no yield, the engine reads its own route
 * as before. The body is a page of the test bus, and the shell's is this
 * page's bus.
 *
 * @covers tugdeck/src/components/tugways/focus-manager.ts
 * @covers tugdeck/src/lib/keyboard-yield.ts
 * @covers tugdeck/src/body/body-publisher.ts
 */
import { afterEach, describe, expect, test } from "bun:test";

import { FocusManager, observeFocusManagerRegistration, registerFocusManager } from "../focus-manager";
import { readKbfPaint } from "@/body/body-publisher";
import { ResponderChainManager } from "../responder-chain";
import { setKeyboardYield } from "@/lib/keyboard-yield";
import { cardKbfPaint } from "@/bus/declarations/card";
import { createTestBus, type TestBus, type TestPage } from "@/bus/test-bus";

const releases: Array<() => void> = [];
let bus: TestBus | null = null;

/** The shell installed as this page's bus, yielded to body `o`, which says `paint`. */
async function yieldedTo(paint: boolean | null): Promise<TestPage> {
  bus = createTestBus();
  bus.install(bus.shell());
  const body = bus.body("o", "overview");
  cardKbfPaint.on(body.bus).set(paint);
  await bus.flush();
  releases.push(setKeyboardYield(() => true, undefined, () => "o"));
  return body;
}

function engaged(): FocusManager {
  const fm = new FocusManager();
  fm.attach(new ResponderChainManager());
  fm.setKbfManual(true);
  return fm;
}

afterEach(() => {
  while (releases.length > 0) releases.pop()?.();
  bus?.dispose();
  bus = null;
});

describe("KBF paint across a keyboard yield", () => {
  test("an engaged, engine-routed page paints when it holds the keyboard", () => {
    const fm = engaged();
    expect(fm.kbfPainting()).toBe(true);
    expect(fm.computeProjection().kbf).toBe(true);
  });

  test("a page that has yielded wears the keyboard page's paint", async () => {
    const fm = engaged();
    const body = await yieldedTo(false);
    expect(fm.kbfPainting()).toBe(false);
    expect(fm.computeProjection().kbf).toBe(false);
    cardKbfPaint.on(body.bus).set(true);
    await bus!.flush();
    expect(fm.kbfPainting()).toBe(true);
  });

  test("with no word from the keyboard's page, the page reads its own route", async () => {
    const fm = engaged();
    await yieldedTo(null);
    expect(fm.kbfPainting()).toBe(true);
  });

  test("a page that holds the keyboard ignores the keyboard page's word", async () => {
    const fm = engaged();
    await yieldedTo(false);
    releases.pop()?.();
    releases.push(setKeyboardYield(() => false, undefined, () => "o"));
    expect(fm.kbfPainting()).toBe(true);
  });

  test("a body says its paint once its engine registers, and hears the registration", async () => {
    expect(readKbfPaint()).toBe(null);
    let heard = 0;
    releases.push(observeFocusManagerRegistration(() => (heard += 1)));
    const fm = engaged();
    registerFocusManager(fm);
    releases.push(() => registerFocusManager(null));
    expect(heard).toBe(1);
    expect(readKbfPaint()).toBe(true);
    await yieldedTo(false);
    expect(readKbfPaint()).toBe(false);
  });

  test("the mode off paints nothing, whatever the keyboard's page says", async () => {
    const fm = engaged();
    fm.setKbfManual(false);
    await yieldedTo(true);
    expect(fm.kbfPainting()).toBe(false);
  });
});
