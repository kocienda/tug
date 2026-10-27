/**
 * at0758-help-menu-opens-help-cards.test.ts — Help ▸ Tug Help and Help ▸
 * Glossary open the bundled documents as rendered help cards.
 *
 * The two items are the app's door to its own documentation, and the whole
 * path is real: the `NSMenuItem` is performed (validation, the action, the
 * `show-card` control), the deck opens a help card keyed by the document,
 * the card's body fetches it from tugcast's `/api/help/{name}` — the bundled
 * `Contents/Resources/docs/` the copy phase put there — and renders it as
 * markdown, so the document's own heading is what shows. Raw markdown would
 * show a `# ` in front of it.
 *
 * Then the keying. Picking Tug Help a second time must bring the card that is
 * already open forward rather than add another, and the Glossary is its own
 * card beside it.
 *
 * Scenario:
 *   1. Perform Help ▸ Tug Help. The active card is a help card holding
 *      `features`, and its body renders the feature guide's heading.
 *   2. Perform Help ▸ Glossary. A second card, holding `glossary`, renders
 *      the glossary's heading.
 *   3. Perform Help ▸ Tug Help again. The card that comes forward is the
 *      first one.
 *
 * @covers tugapp/Sources/MenuBarBuilder.swift
 * @covers tugapp/Sources/AppDelegate.swift
 * @covers tugdeck/src/components/tugways/cards/help-card.tsx
 * @covers tugdeck/src/lib/open-help-in-card.ts
 * @covers tugdeck/src/lib/help-docs.ts
 * @covers tugrust/crates/tugcast/src/help_docs.rs
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import { BODY_READY_MS, bodyOf, settleFor } from "./body-grounding/_bodies";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const HEADING = `[data-slot="help-card"] h1`;

/** Perform a Help item and return the help card it brought forward, with its document. */
async function pick(app: App, identifier: string, doc: string): Promise<string> {
  const performed = await app.performMenuItem(identifier);
  expect(performed.found && performed.performed, `${identifier} performs`).toBe(true);
  // card-dom: shell — the active card and its bag are the deck's record, which is the shell's.
  return app.waitForCondition<string>(
    `(function () {
      var id = window.__tug.getActiveCardId();
      if (id === null) return null;
      var bag = window.__tug.getCardStateBag(id);
      var content = bag && bag.content;
      return content && content.doc === ${JSON.stringify(doc)} ? id : null;
    })()`,
    { timeoutMs: 5_000 },
  );
}

/** The heading the help card's body renders. */
async function headingOf(app: App, cardId: string): Promise<string> {
  const ready = await settleFor(
    () => bodyOf(app, cardId),
    (b) => b !== null && b.state === "ready",
    BODY_READY_MS,
  );
  expect(ready?.state, "the help card's body stands ready").toBe("ready");
  return app.body(cardId).waitForCondition<string>(
    `(function () { var h = document.querySelector(${JSON.stringify(HEADING)}); return h && h.textContent; })()`,
    { timeoutMs: 10_000 },
  );
}

describe.skipIf(!SHOULD_RUN)("at0758 — the Help menu opens the help documents", () => {
  test(
    "Tug Help and Glossary each open a rendered help card, keyed by document",
    async () => {
      const app = await launchTugApp({ testName: "at0758-help-menu" });
      try {
        const features = await pick(app, "help.tugHelp", "features");
        const featuresHeading = await headingOf(app, features);
        note(`Tug Help heading: ${JSON.stringify(featuresHeading)}`);
        expect(featuresHeading).toBe("Tug: what it does and how to use it");

        const glossary = await pick(app, "help.glossary", "glossary");
        expect(glossary, "the glossary is its own card").not.toBe(features);
        const glossaryHeading = await headingOf(app, glossary);
        note(`Glossary heading: ${JSON.stringify(glossaryHeading)}`);
        expect(glossaryHeading).toBe("Tug glossary");

        const again = await pick(app, "help.tugHelp", "features");
        expect(again, "a second Tug Help brings the open card forward").toBe(features);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
