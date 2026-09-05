/**
 * at0522-empty-session-close.test.ts — an empty Session card closes without
 * asking; one holding an unsent message says so.
 *
 * ## What this gates
 *
 * The Session card's registration carries `confirmClose: true` because a
 * transcript cannot be recovered once the card is gone. A card that has
 * never attached to a session has no transcript, and "Close Card?" over a
 * blank picker is a guard with nothing behind it. The card answers for
 * itself through `registerCardCloseAdvice`, live at close time.
 *
 *   - **A (unattached waives):** a single Session card on its picker closes
 *     on the X with no confirm popover, ever, not even a flash. Fails if
 *     the advisor never registers, if the pane reads the registration's
 *     static `confirmClose` instead of asking, or if the restore-pass gate
 *     leaves the card looking permanently unsettled.
 *   - **B (attached-but-unsent waives):** a bound session with an empty
 *     transcript and an empty composer closes the same way. This is the
 *     branch that reads the session store rather than the picker state.
 *   - **C (a draft stands, and speaks):** type into the composer of that
 *     same bound card and the X now raises the confirm, worded for what it
 *     would take. The draft lives only in the editor — waiving over it
 *     would be silent data loss — and a generic "Close Card?" would not
 *     tell the user why a card they think is empty is arguing.
 *   - **D (the count rule survives):** two Session cards in one pane still
 *     get "Close 2 Tabs?". That guard is about discarding N tabs at once,
 *     which no card's emptiness answers.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/card-close-advice.ts
 * @covers tugdeck/src/lib/session-card-close-advice.ts
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";
import type { App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CONFIRM_POPOVER_SELECTOR = '[data-slot="tug-confirm-popover"]';
const PICKER_OPEN = 'document.querySelector(".session-card-picker-form") !== null';
const COMPOSER_SELECTOR = '[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content';

/** The copy the card supplies when a draft is all that stands to be lost. */
const DRAFT_MESSAGE = "Close Card? The message you haven't sent goes with it.";

function pause(ms: number): Promise<void> {
  return new Promise<void>((resolve) =>
    (
      globalThis as unknown as {
        setTimeout: (fn: () => void, ms: number) => unknown;
      }
    ).setTimeout(() => resolve(), ms),
  );
}

function paneCloseButtonSelector(paneId: string): string {
  return `.tug-pane[data-pane-id="${paneId}"] [data-testid="tug-pane-close-button"]`;
}

function deckShape(cardIds: readonly string[]) {
  return {
    cards: cardIds.map((id) => ({
      id,
      componentId: "session",
      title: "Session",
      closable: true,
    })),
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 860, height: 640 },
        cardIds: [...cardIds],
        activeCardId: cardIds[0],
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/** The popover's text, or null when no popover stands. */
function popoverTextScript(): string {
  return `(function(){
    var el = document.querySelector(${JSON.stringify(CONFIRM_POPOVER_SELECTOR)});
    return el === null ? null : el.textContent;
  })()`;
}

async function seedCards(app: App, cardIds: readonly string[]): Promise<void> {
  await app.seedDeckState({
    state: deckShape(cardIds),
    focusCardId: cardIds[0]!,
  });
  const registered = cardIds
    .map((id) => `window.__tug.assertHostRootRegistered(${JSON.stringify(id)})`)
    .join(" && ");
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && ${registered}`,
  );
}

describe.skipIf(!SHOULD_RUN)(
  "AT0522: an empty Session card waives its close confirm",
  () => {
    test(
      "case A — an unattached Session card's X closes the pane with no popover",
      async () => {
        const app = await launchTugApp({ testName: "at0522-a-unattached" });
        try {
          await seedCards(app, ["A"]);
          // An UNBOUND session card presents its picker — the state the
          // waiver speaks for.
          await app.waitForCondition<boolean>(PICKER_OPEN, { timeoutMs: 8000 });

          await app.nativeClickAtElement(paneCloseButtonSelector("p1"));

          await app.waitForCondition<boolean>(
            `document.querySelector('[data-pane-id="p1"]') === null`,
            { timeoutMs: 4000 },
          );
          const popoverText = await app.evalJS<string | null>(popoverTextScript());
          expect(
            popoverText,
            "an unattached Session card should not raise a close confirm",
          ).toBeNull();
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "case B — a bound session with an empty transcript and composer closes immediately",
      async () => {
        const app = await launchTugApp({ testName: "at0522-b-attached-unsent" });
        try {
          await seedCards(app, ["A"]);
          // A bound card with no frames flowing: attached, never spoken to.
          await app.bindSession("A");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)}) !== null`,
            { timeoutMs: 8000 },
          );

          await app.nativeClickAtElement(paneCloseButtonSelector("p1"));

          await app.waitForCondition<boolean>(
            `document.querySelector('[data-pane-id="p1"]') === null`,
            { timeoutMs: 4000 },
          );
          const popoverText = await app.evalJS<string | null>(popoverTextScript());
          expect(
            popoverText,
            "a session that was never sent a message has nothing to confirm over",
          ).toBeNull();
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "case C — an unsent draft keeps the confirm and words it",
      async () => {
        const app = await launchTugApp({ testName: "at0522-c-unsent-draft" });
        try {
          await seedCards(app, ["A"]);
          await app.bindSession("A");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)}) !== null`,
            { timeoutMs: 8000 },
          );

          // Type into the composer — the draft lives only in the editor.
          await app.nativeClickAtElement(COMPOSER_SELECTOR);
          await app.waitForCondition<boolean>(
            `document.activeElement !== null && document.activeElement.matches(${JSON.stringify(COMPOSER_SELECTOR)})`,
            { timeoutMs: 4000 },
          );
          await app.nativeType("half a thought");
          await app.waitForCondition<boolean>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)});
              return el !== null && el.textContent.indexOf("half a thought") !== -1;
            })()`,
            { timeoutMs: 4000 },
          );

          await app.nativeClickAtElement(paneCloseButtonSelector("p1"));
          // Past the popover-flash window, so this reads a popover that holds.
          await pause(300);

          const popoverText = await app.evalJS<string | null>(popoverTextScript());
          expect(
            popoverText,
            "an unsent draft must not be discarded silently",
          ).not.toBeNull();
          expect(popoverText).toContain(DRAFT_MESSAGE);
          const panePresent = await app.evalJS<boolean>(
            `document.querySelector('[data-pane-id="p1"]') !== null`,
          );
          expect(panePresent, "the pane waits on the confirm").toBe(true);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "case D — two empty Session cards in one pane still confirm 'Close 2 Tabs?'",
      async () => {
        const app = await launchTugApp({ testName: "at0522-d-multi-still-confirms" });
        try {
          await seedCards(app, ["A", "B"]);
          await app.waitForCondition<boolean>(PICKER_OPEN, { timeoutMs: 8000 });

          await app.nativeClickAtElement(paneCloseButtonSelector("p1"));
          await pause(300);

          const popoverText = await app.evalJS<string | null>(popoverTextScript());
          expect(
            popoverText,
            "a multi-tab pane keeps its whole-pane confirm",
          ).not.toBeNull();
          expect(popoverText).toContain("Close 2 Tabs?");
          const panePresent = await app.evalJS<boolean>(
            `document.querySelector('[data-pane-id="p1"]') !== null`,
          );
          expect(panePresent, "the pane waits on the confirm").toBe(true);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
