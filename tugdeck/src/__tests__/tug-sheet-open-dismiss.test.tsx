/**
 * A sheet's open → dismiss → restore, under jsdom.
 *
 * Opening a sheet takes the keyboard into it and dismissing it hands the
 * keyboard back. The `tug-sheet` app-tests read that off two projections, and
 * so does this, over a real `DeckManager` mounted into a jsdom container:
 *
 *   - the engine's focus trap: a trapped mode pushed while the sheet is up,
 *     projected onto `<html>` as `data-focus-mode`, and popped on dismiss
 *     (`at0178`);
 *   - the responder chain: the sheet's content becomes the first responder, so
 *     Escape and ⌘. route to it, and the card it was raised over is the first
 *     responder again once it closes.
 *
 * DOM focus itself is not read: the engine routes the keyboard through its key
 * sink in every state, so `document.activeElement` is the sink both before the
 * dismiss and after it, and says nothing about where the keyboard belongs.
 *
 * @covers tugdeck/src/components/tugways/tug-sheet.tsx
 * @covers tugdeck/src/components/tugways/responder-chain.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import React from "react";

import type { DeckManager } from "../deck-manager";
import type { TugSheetHandle } from "../components/tugways/tug-sheet";
import { errorBannerText, installJsdom, mountDeck, onePaneDeck, settle, unmountDeck } from "./jsdom-deck";

// Installed before any deck module loads; the deck is imported in `beforeAll`.
const substrate = installJsdom();
const { container, win } = substrate;

const COMPONENT = "sheet-probe";
const CARD = "card-1";
const SHEET_RESPONDER = "sheet-probe-sheet";

let manager: DeckManager;
let sheetHandle: TugSheetHandle | null = null;

beforeAll(async () => {
  const { registerCard } = await import("../card-registry");
  const { TugSheet, TugSheetContent } = await import("../components/tugways/tug-sheet");

  function SheetProbe(): React.ReactElement {
    return (
      <div>
        <button type="button" data-probe="opener" onClick={() => sheetHandle?.open()}>
          Open
        </button>
        <TugSheet
          ref={(handle) => {
            sheetHandle = handle;
          }}
          responderId={SHEET_RESPONDER}
        >
          <TugSheetContent title="Probe sheet">
            <button type="button" data-probe="inside">
              Inside
            </button>
          </TugSheetContent>
        </TugSheet>
      </div>
    );
  }

  registerCard({
    componentId: COMPONENT,
    contentFactory: () => <SheetProbe />,
    defaultMeta: { title: "Sheet probe", closable: true },
  });
  manager = await mountDeck(substrate, onePaneDeck(COMPONENT, [CARD]));
});

afterAll(() => unmountDeck(substrate, manager));

// ---- Readings ----

/** The id the responder chain projects onto its one first-responder element. */
function firstResponder(): string | null {
  return (
    win.document.querySelector<HTMLElement>("[data-first-responder]")?.getAttribute("data-first-responder") ??
    null
  );
}

/** The engine's trapped focus mode, projected onto `<html>` while a sheet is up. */
function focusMode(): string | null {
  return win.document.documentElement.getAttribute("data-focus-mode");
}

function sheetEl(): HTMLElement | null {
  return win.document.querySelector<HTMLElement>('[data-slot="tug-sheet"]');
}

function pressEscape(): void {
  (win.document.activeElement ?? win.document.body).dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }),
  );
}

// ---- The sequence ----

describe("tug-sheet open, dismiss, restore", () => {
  test("the deck mounted without an error banner, and at rest", async () => {
    expect(errorBannerText(container)).toBeNull();
    manager.activateCard(CARD);
    await settle();
    container.querySelector<HTMLElement>('[data-probe="opener"]')?.focus();
    expect(sheetEl()).toBeNull();
    expect(focusMode()).toBeNull();
    expect(firstResponder()).toBe(CARD);
  });

  test("opening pushes the trap and makes the sheet the first responder", async () => {
    container.querySelector<HTMLElement>('[data-probe="opener"]')?.click();
    await settle();
    expect(sheetEl()).not.toBeNull();
    expect(focusMode()).not.toBeNull();
    expect(firstResponder()).toBe(SHEET_RESPONDER);
  });

  test("Escape dismisses it, pops the trap, and hands the card back the chain", async () => {
    pressEscape();
    // The close runs an exit, then the trap's pop: two beats.
    await settle();
    await settle();
    expect(sheetEl()).toBeNull();
    expect(focusMode()).toBeNull();
    expect(firstResponder()).toBe(CARD);
  });

  test("the sequence repeats: a second open and dismiss lands the same way", async () => {
    container.querySelector<HTMLElement>('[data-probe="opener"]')?.click();
    await settle();
    expect(firstResponder()).toBe(SHEET_RESPONDER);
    expect(focusMode()).not.toBeNull();
    pressEscape();
    await settle();
    await settle();
    expect(sheetEl()).toBeNull();
    expect(focusMode()).toBeNull();
    expect(firstResponder()).toBe(CARD);
  });
});
