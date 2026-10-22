/**
 * row-11-lifecycle.test.ts — no body outlives its card, and every body
 * saves before it goes.
 *
 * The bar's eleventh row ([B02] row 11). Four gestures take a body card
 * away, and after each the host's snapshot holds no body for it:
 *
 * - **close** — File › Close on a body card holding a draft, so the shell's
 *   popover asks and Close is clicked; the shell's destruction notice sends
 *   `bodyDestroy` and the host removes the view. A rail asks too, and any
 *   other kind closes at once.
 * - **close all** — File › Close All Card Tabs on a pane holding a body
 *   card with a draft beside a text card; the shell asks, and both cards
 *   go, the body with them.
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
 * from the page that wrote them. And every bound body says which kind of
 * card it holds — at the start and after the reload made it again — so a
 * body brought back is bound to mount its card's kind, not a guess.
 *
 * Every other kind that is a body is closed, reloaded and quit the same
 * way; a rail holds no tabs, so Close All is the Session card's here. What
 * a rail kind types into its own field before the reload is in its field
 * after it, and its body's save is in the quit's verdict.
 *
 * A Text card holding unsaved edits is a body whose close guard the shell
 * cannot read in its own document. So two gestures that destroy it are read
 * against a dirty Text body: its pane's close puts the Save sheet up in the
 * body, and Cancel keeps the card; and a workspace delete confirmed in a
 * Cards body over the workspace holding it goes back to that workspace and
 * asks in the Text body, and Cancel keeps the workspace. Neither writes the
 * file.
 *
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/body/body-main.ts
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App, type BodyApp } from "../_harness";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankRead } from "../_harness/tugbank-helpers";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { bodyOf, closePopoverPage, closePopoverUp, composerText, focusBody, pollFor, sessionPane, spawnStub, waitForBody } from "./_bodies";
import { kindDeck, standUpKind } from "./_kind-bodies";
import { cardKind, kindPane, kindSidebars, kindsUnderTest, sessionUnderTest } from "./_kinds";

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
const X = "row11-x";
const ORIGINAL = "alpha\nbeta\n";
const TEXT_EDITOR = '[data-slot="tug-text-card-editor"] .cm-content';
const SHEET_CANCEL = '[data-testid="file-save-sheet-cancel"]';
const CONFIRM_OK = '[data-slot="tug-confirm-popover"] [data-slot="tug-confirm-confirm"]';
const present = (selector: string): string => `document.querySelector(${JSON.stringify(selector)}) !== null`;
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
  // Each body holds its own card's kind: the shell's deck says which.
  const deckKinds = new Map(
    await app.evalJS<Array<[string, string]>>("window.tugdeck.diag.getDeckState().cards.map(function (c) { return [c.id, c.componentId]; })"),
  );
  for (const b of (await app.bodies()).filter((x) => x.cardId !== null)) {
    expect(b.componentId, `${label}: ${b.cardId}'s body holds its card's kind`).toBe(deckKinds.get(b.cardId!) ?? "a card the deck holds");
  }
}

/**
 * Perform a File-menu close and see it through to `want` cards. `asks` is
 * the close's one right outcome: a Session card holding a draft does not
 * waive the confirmation, a rail always asks (`tug-pane.tsx`'s
 * `paneConfirmClose`), and so does a pane of several tabs, so the shell's
 * popover rises and its confirm button is clicked; any other card closes at
 * once. The popover stands in `cardId`'s own page, where its pane's chrome
 * is drawn, and is read and pressed there.
 */
async function closeThrough(app: App, cardId: string, identifier: string, want: number, label: string, asks: boolean): Promise<void> {
  const item = await app.performMenuItem(identifier);
  note(`${label}: ${identifier} ${JSON.stringify(item)}`);
  expect(item.found && item.performed, `${label}: ${identifier} performs`).toBe(true);
  const seen = await pollFor(
    async () => ({ popover: await closePopoverUp(app, cardId), cards: await app.evalJS<number>(`${CARD_IDS}.length`) }),
    (r) => r.popover || r.cards <= want,
    SETTLE_MS,
  );
  note(`${label}: popover ${seen.popover}, cards ${seen.cards}`);
  expect(seen.popover, asks ? `${label}: the close raises its Close popover` : `${label}: the close lands without asking`).toBe(asks);
  if (asks) {
    const page = await closePopoverPage(app, cardId);
    expect(page !== null && (await page.evalJS<boolean>(present(CONFIRM_OK))), `${label}: the popover has a confirm button`).toBe(true);
    await page!.nativeClickAtElement(CONFIRM_OK);
    await pollFor(() => closePopoverUp(app, cardId), (v) => !v, SETTLE_MS);
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
  for (const kind of kindsUnderTest(11)) {
    if (kind.componentId === "session") continue;
    test(
      `${kind.componentId}: no body outlives its card, and its body is made again by a reload and saves before a quit`,
      async () => {
        const K = `row11-${kind.componentId}`;
        const K2 = `row11-${kind.componentId}-again`;
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: `${TEST_NAME}-${kind.componentId}`,
          persistInTestMode: true,
          restoreInTestMode: true,
          env: { TUGBANK_PATH: tugbankPath },
        });
        try {
          // ---- close ----
          // The Session card A beside it is a body too: every card is one.
          await app.seedDeckState({ state: kindDeck(kind, K, { sessions: [A] }), focusCardId: K });
          await standUpKind(app, kind, K);
          await expectBodiesMatchCards(app, "at the start", [K, A]);
          await app.dispatchControlAction("focus-session-card", { cardId: K });
          await closeThrough(app, K, "file.closeCard", 1, `close ${K}`, kind.rail);
          expect(await pollFor(() => bodyOf(app, K), (b) => b === null, SETTLE_MS), "the host holds no body for the card after the close").toBeNull();
          await expectBodiesMatchCards(app, "after the close", [A]);

          // ---- reload ----
          await app.seedDeckState({ state: kindDeck(kind, K2, { sessions: [A] }), focusCardId: K2 });
          const k = await standUpKind(app, kind, K2);
          const draft = "row11 kind draft before reload";
          if (kind.field !== undefined) {
            await k.nativeClickAtElement(kind.field);
            await app.nativeType(draft);
            const typed = await pollFor(() => k.evalJS<string>(`(document.querySelector(${JSON.stringify(kind.field)}) || { textContent: "" }).textContent`), (t) => t.includes(draft), SETTLE_MS);
            expect(typed, "its field holds the draft").toContain(draft);
          }
          const genBefore = await app.evalJS<number>(READY_GEN);
          await app.nativeKey("r", ["cmd", "shift"]);
          let emptySamples = 0;
          const genAfter = await pollFor(
            async () => {
              if ((await boundBodies(app)).length === 0) emptySamples += 1;
              return app.evalJS<number>(READY_GEN).catch(() => genBefore);
            },
            (gen) => gen > genBefore,
            20_000,
          );
          expect(genAfter, "the shell reloaded").toBeGreaterThan(genBefore);
          expect(emptySamples, "the host had destroyed every body before the shell came back").toBeGreaterThan(0);
          const listed = await pollFor(() => app.evalJS<string[]>(CARD_IDS), (ids) => ids.includes(K2), SETTLE_MS);
          expect(listed, "the reloaded shell restored the card").toContain(K2);
          const again = await standUpKind(app, kind, K2);
          await expectBodiesMatchCards(app, "after the reload", [K2, A]);
          if (kind.field !== undefined) {
            const restored = await pollFor(() => again.evalJS<string>(`(document.querySelector(${JSON.stringify(kind.field)}) || { textContent: "" }).textContent`), (t) => t.includes(draft), SETTLE_MS);
            expect(restored, "the body made again shows the draft the old one saved").toContain(draft);
          }

          // ---- quit ----
          await app.quitGracefully({ timeoutMs: 20_000 });
          const log = app.tugappLog();
          const verdict = log.split("\n").filter((line) => line.includes("termination verdicts")).pop() ?? "";
          note(`quit: ${verdict.trim() || "no verdict line in the log"}`);
          expect(verdict, "the verdict names the card's body").toContain(`body:${K2}:`);
          expect(verdict, "and its body saved ok").toMatch(new RegExp(`body:${K2}: ok=true`));
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  }

  test(
    "a dirty Text body asks before its pane closes and before a Cards body deletes its workspace, and Cancel keeps both",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "tug-row11-guard-"));
      const file = join(dir, "notes.md");
      writeFileSync(file, ORIGINAL);
      const app = await launchTugApp({ testName: `${TEST_NAME}-text-guard` });
      try {
        await app.seedDeckState({
          state: {
            cards: [
              { id: X, componentId: "text", title: "Text", closable: true },
              { id: "row11-cards", componentId: "cards", title: "Workspaces", closable: true },
            ],
            panes: [kindPane("text", X, 0), kindPane("cards", "row11-cards", 0)],
            activePaneId: `${X}-pane`,
            imposition: { kind: "one-up", layout: "flow", sidebars: kindSidebars(["cards"]) },
            hasFocus: true,
          },
          cardStates: { [X]: { content: { path: file, anchor: { line: 1, ch: 0 }, scrollTop: 0 } } },
          focusCardId: X,
        });
        const text = await standUpKind(app, cardKind("text"), X);
        await standUpKind(app, cardKind("cards"), "row11-cards");
        await pollFor(() => text.evalJS<string>(`(document.querySelector(${JSON.stringify(TEXT_EDITOR)}) || { innerText: "" }).innerText`), (t) => t.includes("alpha"), SETTLE_MS);
        await text.nativeClickAtElement(TEXT_EDITOR);
        await app.nativeType("EDIT ");
        const typed = await pollFor(() => text.evalJS<string>(`document.querySelector(${JSON.stringify(TEXT_EDITOR)}).innerText`), (t) => t.includes("EDIT"), SETTLE_MS);
        expect(typed, "the Text body holds an unsaved edit").toContain("EDIT");

        // ---- The pane's close: the Save sheet in the body, Cancel keeps the card ----
        // The pane's chrome is drawn in the card's own page, and its close button is pressed there.
        await text.nativeClickAtElement(`[data-testid="tug-pane-close-button"]`);
        const asked = await pollFor(() => text.evalJS<boolean>(present(SHEET_CANCEL)), (v) => v, SETTLE_MS);
        expect(asked, "the pane's close puts the Save sheet up in the Text body").toBe(true);
        await text.nativeClickAtElement(SHEET_CANCEL);
        await pollFor(() => text.evalJS<boolean>(present(SHEET_CANCEL)), (v) => !v, SETTLE_MS);
        await Bun.sleep(300);
        expect(await app.evalJS<string[]>(CARD_IDS), "Cancel keeps the card").toContain(X);
        expect(readFileSync(file, "utf8"), "and writes nothing").toBe(ORIGINAL);

        // ---- A workspace delete from a Cards body: fronted, asked, Cancel keeps it ----
        const home = await app.evalJS<string>("window.tugdeck.diag.getSpaces().activeSpaceId");
        await app.evalJS<string>(`window.tugdeck.lab.createSpace("Away")`);
        await pollFor(() => app.evalJS<string>("window.tugdeck.diag.getSpaces().activeSpaceId"), (id) => id !== home, SETTLE_MS);
        const shown = await pollFor(
          () => app.bodies(),
          (bodies) => bodies.some((b) => b.componentId === "cards" && b.state === "ready" && b.visible),
          SETTLE_MS,
        );
        const awayCards: BodyApp = app.body(shown.find((b) => b.componentId === "cards" && b.state === "ready" && b.visible)!.cardId!);
        await app.dispatchControlAction("delete-space", { spaceId: home });
        await pollFor(() => awayCards.evalJS<boolean>(present(CONFIRM_OK)), (v) => v, SETTLE_MS);
        await awayCards.nativeClickAtElement(CONFIRM_OK);
        const askedAgain = await pollFor(() => text.evalJS<boolean>(present(SHEET_CANCEL)), (v) => v, 15_000);
        expect(askedAgain, "the confirmed delete asks in the Text body").toBe(true);
        expect(await app.evalJS<string>("window.tugdeck.diag.getSpaces().activeSpaceId"), "with its workspace fronted").toBe(home);
        await text.nativeClickAtElement(SHEET_CANCEL);
        await Bun.sleep(500);
        const after = await app.evalJS<{ activeSpaceId: string; spaces: { id: string }[] }>("window.tugdeck.diag.getSpaces()");
        note(`after the cancelled delete: ${JSON.stringify(after)}`);
        expect(after.spaces.map((s) => s.id), "Cancel keeps the workspace").toContain(home);
        expect(await app.evalJS<string[]>(CARD_IDS), "and the card").toContain(X);
        expect(readFileSync(file, "utf8"), "and writes nothing").toBe(ORIGINAL);
      } finally {
        await app.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test.skipIf(!sessionUnderTest(11))(
    "no body outlives its card, every body saves before a reload and a quit, and the saves are on disk",
    async () => {
      const stubDir = stubDirectory();
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const app = await launchTugApp({
        testName: TEST_NAME,
        // Test mode holds every card-state write back and starts every
        // boot empty; the two hatches let the bodies' saves reach the run's
        // own tugbank file, which is the disk this row reads, and let the
        // reloaded shell restore its deck from it, which is the pass that
        // makes the bodies again.
        persistInTestMode: true,
        restoreInTestMode: true,
        env: { TUGBANK_PATH: tugbankPath, [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({ state: deck(), focusCardId: A });
        for (const id of [A, B, D]) await spawnStub(app, id, stubDir, 2);
        for (const id of [A, B, D]) await waitForBody(app, id);
        await expectBodiesMatchCards(app, "at the start", [A, B, D, T]);

        // ---- Close: A holds a draft, so the shell asks; Close, and A goes with its body ----
        await typeDraft(app, A, "row11 draft in A");
        await focusBody(app, A, { composer: false });
        await closeThrough(app, A, "file.closeCard", 3, "close A", true);
        expect(await pollFor(() => bodyOf(app, A), (b) => b === null, SETTLE_MS), "the host holds no body for A after the close").toBeNull();
        await expectBodiesMatchCards(app, "after closing A", [B, D, T]);

        // ---- Close all: B holds a draft, so the shell asks; B's pane empties, the text card and the body card together ----
        await typeDraft(app, B, "row11 draft in B");
        await focusBody(app, B, { composer: false });
        await closeThrough(app, B, "file.closeAllCardTabs", 1, "close all in B's pane", true);
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
        await app.quitGracefully({ timeoutMs: 20_000 });
        const bagAfterQuit = bagOnDisk(tugbankPath, D);
        expect(bagAfterQuit, "D's bag is on tugbank disk after the quit").not.toBeNull();
        expect(bagAfterQuit, "and it carries the draft typed before the quit").toContain(DRAFT_BEFORE_QUIT);
        const log = app.tugappLog();
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
