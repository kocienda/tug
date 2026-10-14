/**
 * row-11-lifecycle.test.ts — no body outlives its card, and every body
 * saves before it goes.
 *
 * The bar's eleventh row ([B02] row 11). Four gestures take a body card
 * away, and after each the host's snapshot holds no body for it:
 *
 * - **close** — File › Close on a body card; the shell's destruction
 *   notice sends `bodyDestroy` and the host removes the view.
 * - **close all** — File › Close All Card Tabs on a pane holding a body
 *   card beside a text card; both cards go, and the body with them.
 * - **reload** — ⇧⌘R from inside a body; the host runs every body's save
 *   and destroys them all before the shell navigates
 *   (`saveAndDestroyAll`), and the reloaded shell's restore pass makes
 *   them again, so the draft typed in the body before the reload is the
 *   draft its body shows after it, and its bag is on tugbank disk.
 * - **quit** — the app's own termination path runs each body's
 *   `prepareForTermination` under the one deadline; the draft typed after
 *   the reload reaches disk, and the host's verdict line names the body's
 *   save as ok.
 *
 * The saves are read from the tugbank file the run was launched on, never
 * from the page that wrote them.
 *
 * @foreground
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/body/body-main.ts
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { launchTugApp, note, type App } from "../_harness";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankRead } from "../_harness/tugbank-helpers";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { bodyOf, closeButtonOfPopover, composerText, focusBody, pollFor, popoverPresent, sessionPane, spawnStub, waitForBody } from "./_bodies";

const TEST_NAME = "body-grounding-row-11-lifecycle";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;

const A = "row11-a";
const B = "row11-b";
const T = "row11-text";
const D = "row11-d";
const CARDSTATE = "dev.tugapp.deck.cardstate";
const DRAFT_BEFORE_RELOAD = "row11 draft before reload";
const DRAFT_BEFORE_QUIT = "row11 draft before quit";
const SETTLE_MS = 8_000;
const CARD_IDS = `window.tugdeck.diag.listCardIds()`;
const READY_GEN = `((typeof window.__tug !== "undefined" && typeof window.__tug.getReadyGen === "function") ? window.__tug.getReadyGen() : 0)`;

function deck(): Record<string, unknown> {
  return {
    cards: [
      { id: A, componentId: "session", title: "A", closable: true },
      { id: B, componentId: "session", title: "B", closable: true },
      { id: T, componentId: "text", title: "Text", closable: true },
      { id: D, componentId: "session", title: "D", closable: true },
    ],
    panes: [
      sessionPane(A, 0),
      {
        id: `${B}-pane`,
        position: { x: 40, y: 40 },
        size: { width: 640, height: 480 },
        cardIds: [B, T],
        activeCardId: B,
        title: "",
        acceptsFamilies: ["standard"],
        slot: 1,
      },
      sessionPane(D, 2),
    ],
    activePaneId: `${A}-pane`,
    imposition: { kind: "three-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

/** The cards the host holds a body for, spare excluded. */
async function boundBodies(app: App): Promise<string[]> {
  return (await app.bodies()).map((b) => b.cardId).filter((id): id is string => id !== null).sort();
}

/** No body outlives its card: every bound body belongs to a card the shell lists. */
async function expectBodiesMatchCards(app: App, label: string, expected: string[]): Promise<void> {
  const bound = await pollFor(() => boundBodies(app), (ids) => ids.join() === [...expected].sort().join(), SETTLE_MS);
  const cards = await app.evalJS<string[]>(CARD_IDS);
  note(`${label}: cards ${JSON.stringify(cards)}; bound bodies ${JSON.stringify(bound)}`);
  expect(bound, `${label}: the host holds a body for exactly the body cards left`).toEqual([...expected].sort());
  for (const id of bound) expect(cards, `${label}: ${id}'s body belongs to a card the shell lists`).toContain(id);
}

/**
 * Perform a File-menu close and see it through: a session card whose body
 * does not waive the confirmation raises the shell's popover, whose Close
 * button is clicked, until the card count reaches `want`.
 */
async function closeThrough(app: App, identifier: string, want: number, label: string): Promise<void> {
  const item = await app.performMenuItem(identifier);
  note(`${label}: ${identifier} ${JSON.stringify(item)}`);
  expect(item.found && item.performed, `${label}: ${identifier} performs`).toBe(true);
  for (let round = 0; round < 4; round++) {
    const seen = await pollFor(
      async () => ({ popover: await app.evalJS<boolean>(popoverPresent), cards: await app.evalJS<number>(`${CARD_IDS}.length`) }),
      (r) => r.popover || r.cards <= want,
      SETTLE_MS,
    );
    if (seen.cards <= want) break;
    expect(seen.popover, `${label}: the close either lands or raises the shell's popover`).toBe(true);
    const button = await closeButtonOfPopover(app);
    expect(button, `${label}: the popover has a Close button`).not.toBeNull();
    await app.nativeClick(button!);
    await pollFor(() => app.evalJS<boolean>(popoverPresent), (v) => !v, SETTLE_MS);
  }
  const cards = await pollFor(() => app.evalJS<number>(`${CARD_IDS}.length`), (n) => n <= want, SETTLE_MS);
  expect(cards, `${label}: the cards closed`).toBe(want);
}

/** Type `text` into `cardId`'s composer and see it there. */
async function typeDraft(app: App, cardId: string, text: string): Promise<void> {
  await focusBody(app, cardId, { composer: true });
  await app.nativeType(text);
  const seen = await pollFor(() => app.body(cardId).evalJS<string | null>(composerText), (t) => t?.includes(text) === true, SETTLE_MS);
  expect(seen, `${cardId}'s composer holds the draft`).toContain(text);
}

/** The card's bag on tugbank disk, as one string to search. */
function bagOnDisk(tugbankPath: string, cardId: string): string | null {
  const onDisk = tugbankRead<unknown>(tugbankPath, CARDSTATE, cardId);
  return onDisk === null ? null : JSON.stringify(onDisk.value);
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 11: close, close all, reload and quit", () => {
  test(
    "no body outlives its card, every body saves before a reload and a quit, and the saves are on disk",
    async () => {
      const stubDir = stubDirectory();
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const app = await launchTugApp({
        testName: TEST_NAME,
        foreground: true,
        // Test mode holds every card-state write back and starts every
        // boot empty; the two hatches let the bodies' saves reach the run's
        // own tugbank file, which is the disk this row reads, and let the
        // reloaded shell restore its deck from it, which is the pass that
        // makes the bodies again.
        persistInTestMode: true,
        restoreInTestMode: true,
        env: { TUG_BODY_VIEWS: "1", TUGBANK_PATH: tugbankPath, [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({ state: deck(), focusCardId: A });
        for (const id of [A, B, D]) await spawnStub(app, id, stubDir, 2);
        for (const id of [A, B, D]) await waitForBody(app, id);
        await expectBodiesMatchCards(app, "at the start", [A, B, D]);

        // ---- Close: A goes, and its body with it ----
        await focusBody(app, A, { composer: false });
        await closeThrough(app, "file.closeCard", 3, "close A");
        expect(await pollFor(() => bodyOf(app, A), (b) => b === null, SETTLE_MS), "the host holds no body for A after the close").toBeNull();
        await expectBodiesMatchCards(app, "after closing A", [B, D]);

        // ---- Close all: B's pane empties, the text card and the body card together ----
        await focusBody(app, B, { composer: false });
        await closeThrough(app, "file.closeAllCardTabs", 1, "close all in B's pane");
        expect(await pollFor(() => bodyOf(app, B), (b) => b === null, SETTLE_MS), "the host holds no body for B after close all").toBeNull();
        await expectBodiesMatchCards(app, "after close all", [D]);

        // ---- Reload: D saves, every body goes, the restored D shows the draft ----
        await typeDraft(app, D, DRAFT_BEFORE_RELOAD);
        const genBefore = await app.evalJS<number>(READY_GEN);
        await app.nativeKey("r", ["cmd", "shift"]);
        // Across the navigation: the host destroys every body before the
        // shell goes, and the new shell's restore makes D's again.
        let emptySamples = 0;
        let samples = 0;
        const genAfter = await pollFor(
          async () => {
            samples += 1;
            if ((await boundBodies(app)).length === 0) emptySamples += 1;
            return app.evalJS<number>(READY_GEN).catch(() => genBefore);
          },
          (gen) => gen > genBefore,
          20_000,
        );
        note(`reload: ready generation ${genBefore} → ${genAfter}; ${samples} host samples across it, ${emptySamples} with no bound body`);
        expect(genAfter, "the shell reloaded").toBeGreaterThan(genBefore);
        expect(emptySamples, "the host had destroyed every body before the shell came back").toBeGreaterThan(0);
        const bagAfterReload = bagOnDisk(tugbankPath, D);
        expect(bagAfterReload, "D's bag is on tugbank disk after the reload").not.toBeNull();
        expect(bagAfterReload, "and it carries the draft typed in the body before the reload").toContain(DRAFT_BEFORE_RELOAD);
        const cardsAfterReload = await pollFor(() => app.evalJS<string[]>(CARD_IDS), (ids) => ids.includes(D), SETTLE_MS);
        note(`after the reload the shell lists ${JSON.stringify(cardsAfterReload)}; bodies ${JSON.stringify((await app.bodies()).map((b) => [b.cardId, b.state, b.visible]))}`);
        expect(cardsAfterReload, "the reloaded shell restored D").toContain(D);
        await waitForBody(app, D);
        await expectBodiesMatchCards(app, "after the reload", [D]);
        const restored = await pollFor(() => app.body(D).evalJS<string | null>(composerText), (t) => t?.includes(DRAFT_BEFORE_RELOAD) === true, SETTLE_MS);
        expect(restored, "the restored body shows the draft the old one saved").toContain(DRAFT_BEFORE_RELOAD);

        // ---- Quit: D saves under the termination pipeline ----
        await typeDraft(app, D, DRAFT_BEFORE_QUIT);
        const logPath = app.logPath;
        await app.quitGracefully({ timeoutMs: 20_000 });
        const bagAfterQuit = bagOnDisk(tugbankPath, D);
        expect(bagAfterQuit, "D's bag is on tugbank disk after the quit").not.toBeNull();
        expect(bagAfterQuit, "and it carries the draft typed before the quit").toContain(DRAFT_BEFORE_QUIT);
        const log = logPath === null ? "" : readFileSync(logPath, "utf8");
        const verdict = log.split("\n").filter((line) => line.includes("termination verdicts")).pop() ?? "";
        note(`quit: ${verdict.trim() || "no verdict line in the log"}`);
        expect(verdict, "the termination pipeline reported a verdict").not.toBe("");
        expect(verdict, "the verdict names D's body").toContain(`body:${D}:`);
        expect(verdict, "and D's body saved ok").toMatch(new RegExp(`body:${D}: ok=true`));
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
