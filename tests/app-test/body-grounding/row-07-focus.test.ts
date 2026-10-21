/**
 * row-07-focus.test.ts — the keyboard follows the card: click, chord,
 * surfaces, and the close that hands it on.
 *
 * The bar's seventh row ([B02] row 7). Two body session cards and a Text
 * card stand in a three-up fit, all on screen. A click inside a body — the host's hit test
 * handing the pointer to the body's page, whose `pointerdown` asks the
 * shell to activate its card — makes that body the window's first
 * responder, and so does the Focus Card chord; typing then lands in that
 * body's composer and in no other page. A click in the Text card's body
 * takes the keyboard there, and to no other body. The Close popover, in the
 * page that draws the card's chrome, and the body's own surfaces (the
 * slash-command popup, the session picker) take focus while they stand and
 * give it back when they go. And closing the
 * key card hands the keyboard to the next card's body.
 *
 * Every assertion is the host's word on which web view is first responder
 * (`bodies`), the shell's word on its focused card, and the text in the
 * page that should have received it ([B04]).
 *
 * Every other kind that is a body is read the same way beside a Session body
 * and a Text card: a click in it, the Focus Card chord, typing into its own
 * field where it has one, the Close popover, and the close that hands the
 * keyboard to the card focused before it. The slash popup and the session
 * picker are the Session card's own surfaces.
 *
 * @foreground activation
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/body/body-publisher.ts
 * @covers tugdeck/src/lib/keyboard-yield.ts
 * @covers tugapp/Sources/BodyViewController.swift
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App, type BodyApp } from "../_harness";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import {
  PROMPT_INPUT,
  SETTLE_MS,
  bodyOf,
  closePopoverPage,
  closePopoverUp,
  composerFocused,
  composerText,
  focusBody,
  pollFor,
  pressCloseOfPopover,
  responders,
  sessionPane,
  spawnStub,
  waitForBody,
} from "./_bodies";
import { kindDeck, standUpKind } from "./_kind-bodies";
import { cardKind, kindsUnderTest, sessionUnderTest, type CardKind } from "./_kinds";

const TEST_NAME = "body-grounding-row-07-focus";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const A = "row07-a";
const B = "row07-b";
const T = "row07-text";
/** In the Text card's own body. */
const TEXT_EDITOR = '[data-slot="tug-text-card-editor"] .cm-content';
const SLASH_POPUP = '[data-slot="tug-completion-menu"]';
/** In a page: the slash-command popup stands and is shown (it is hidden, not removed, when it closes). */
const slashPopupShown = `(function () {
  var p = document.querySelector(${JSON.stringify(SLASH_POPUP)});
  if (p === null) return false;
  if (getComputedStyle(p).display === "none") return false;
  return p.getBoundingClientRect().height > 0;
})()`;
const PICKER = '[data-slot="tug-sheet"]';

function deck(): Record<string, unknown> {
  return {
    cards: [
      { id: A, componentId: "session", title: "A", closable: true },
      { id: B, componentId: "session", title: "B", closable: true },
      { id: T, componentId: "text", title: "Text", closable: true },
    ],
    panes: [
      sessionPane(A, 0),
      sessionPane(B, 1),
      {
        id: `${T}-pane`,
        position: { x: 40, y: 40 },
        size: { width: 640, height: 480 },
        cardIds: [T],
        activeCardId: T,
        title: "",
        acceptsFamilies: ["standard"],
        slot: 2,
      },
    ],
    activePaneId: `${A}-pane`,
    imposition: { kind: "three-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

/** `deck` with the Text card standing in the band's next slot. */
function withText(deck: Record<string, unknown>): Record<string, unknown> {
  const panes = deck.panes as Array<Record<string, unknown>>;
  const slot = panes.filter((p) => typeof p.slot === "number").length;
  return {
    ...deck,
    cards: [...(deck.cards as unknown[]), { id: T, componentId: "text", title: "Text", closable: true }],
    panes: [...panes, { id: `${T}-pane`, position: { x: 40, y: 40 }, size: { width: 640, height: 480 }, cardIds: [T], activeCardId: T, title: "", acceptsFamilies: ["standard"], slot }],
  };
}

/** Typing lands in `kind`'s own field in `page`, and not in `other`'s composer. */
async function typesInto(app: App, page: BodyApp, kind: CardKind, text: string, other: BodyApp): Promise<void> {
  const fieldText = `(document.querySelector(${JSON.stringify(kind.field)}) || { textContent: "" }).textContent`;
  await app.nativeType(text);
  const landed = await pollFor(() => page.evalJS<string>(fieldText), (t) => t.includes(text), SETTLE_MS);
  expect(landed, `typing lands in the ${kind.componentId} card's field`).toContain(text);
  expect(await other.evalJS<string | null>(composerText), "and not in B's composer").not.toContain(text);
}

/** The host says exactly `cardId`'s body holds the keyboard, or no body does for `null`; the spare is never counted. */
async function expectHolder(app: App, cardId: string | null, label: string, timeoutMs = SETTLE_MS): Promise<void> {
  const bodies = await pollFor(
    async () => (await app.bodies()).filter((x) => x.cardId !== null),
    (bs) => bs.every((x) => x.firstResponder === (cardId !== null && x.cardId === cardId)),
    timeoutMs,
  );
  const focused = cardId === null ? await app.getFocusedCardId() : await pollFor(() => app.getFocusedCardId(), (id) => id === cardId, SETTLE_MS);
  note(`${label}: ${JSON.stringify(bodies.map((x) => ({ card: x.cardId, fr: x.firstResponder })))}; shell focused card ${focused}`);
  for (const x of bodies) {
    const should = cardId !== null && x.cardId === cardId;
    expect(x.firstResponder, `${label}: ${x.cardId}'s body ${should ? "holds" : "does not hold"} the keyboard`).toBe(should);
  }
  if (cardId !== null) expect(focused, `${label}: the shell's focused card`).toBe(cardId);
}

/**
 * The Close popover holds the keyboard while it stands: in the card's own
 * page, the card's body is the window's first responder; in the shell's, no
 * body holds the keyboard. The popover's buttons refuse DOM focus — its trap
 * takes the keys — so the Escape that follows is what proves they reach it.
 */
async function expectPopoverHoldsKeyboard(app: App, cardId: string): Promise<void> {
  const page = await closePopoverPage(app, cardId);
  expect(page, "the Close popover stands").not.toBeNull();
  if (page === app) {
    const shellHolds = await pollFor(() => app.bodies(), (bs) => bs.every((x) => !x.firstResponder), SETTLE_MS);
    expect(shellHolds.every((x) => !x.firstResponder), "the shell holds the keyboard while its popover stands").toBe(true);
    return;
  }
  await expectHolder(app, cardId, "with the popover up");
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 7: focus", () => {
  for (const kind of kindsUnderTest(7)) {
    if (kind.componentId === "session") continue;
    test(
      `${kind.componentId}: a click and the chord make its body first responder, the Close popover takes and returns focus, and closing hands on`,
      async () => {
        const card = `row07-${kind.componentId}`;
        const stubDir = stubDirectory();
        const textDir = mkdtempSync(join(tmpdir(), "tug-row07-text-"));
        const textFile = join(textDir, "notes.txt");
        writeFileSync(textFile, "one\ntwo\nthree\n");
        const app = await launchTugApp({ testName: `${TEST_NAME}-${kind.componentId}`, foreground: true, env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir } });
        try {
          await app.seedDeckState({
            state: withText(kindDeck(kind, card, { sessions: [B] })),
            cardStates: { [T]: { content: { path: textFile, anchor: { line: 1, ch: 0 }, scrollTop: 0 } } },
            focusCardId: card,
          });
          const k = await standUpKind(app, kind, card);
          await spawnStub(app, B, stubDir, 2);
          await waitForBody(app, B);
          const b = app.body(B);
          const t = await standUpKind(app, cardKind("text"), T);

          // ---- A click in its body makes it key; typing lands in its field ----
          await b.nativeClickAtElement(PROMPT_INPUT);
          await expectHolder(app, B, "after a click in B's composer");
          await k.nativeClickAtElement(kind.field ?? kind.root);
          await expectHolder(app, card, `after a click in the ${kind.componentId} card`);
          if (kind.field !== undefined) await typesInto(app, k, kind, "kk", b);

          // ---- A click in the Text card's body takes the keyboard there ----
          await t.nativeClickAtElement(TEXT_EDITOR);
          await expectHolder(app, T, "after a click in the Text card");

          // ---- The Focus Card chord brings it back: it stands to the Text card's right ----
          await app.nativeKey("ArrowRight", ["alt", "cmd"]);
          await expectHolder(app, card, "after ⌥⌘→ from the Text card");

          // ---- The Close popover takes focus and gives it back ----
          await app.nativeKey("w", ["cmd"]);
          const asked = await pollFor(() => closePopoverUp(app, card), (v) => v, SETTLE_MS);
          if (asked) {
            await expectPopoverHoldsKeyboard(app, card);
            await app.nativeKey("Escape");
            expect(await pollFor(() => closePopoverUp(app, card), (v) => v === false, SETTLE_MS), "Escape dismisses it").toBe(false);
            await expectHolder(app, card, "after the popover");
          }

          // ---- Closing the key card hands the keyboard to the card focused before ----
          await app.dispatchControlAction("focus-session-card", { cardId: B });
          await expectHolder(app, B, "B focused before the close");
          await app.dispatchControlAction("focus-session-card", { cardId: card });
          await expectHolder(app, card, "the card focused again before the close");
          const cardsBefore = await app.evalJS<number>(`window.tugdeck.diag.listCardIds().length`);
          const closeItem = await app.performMenuItem("file.closeCard");
          expect(closeItem.found && closeItem.performed, "File › Close performs").toBe(true);
          if (await pollFor(() => closePopoverUp(app, card), (v) => v, 1_000)) await pressCloseOfPopover(app, card);
          const cardsAfter = await pollFor(() => app.evalJS<number>(`window.tugdeck.diag.listCardIds().length`), (n) => n < cardsBefore, SETTLE_MS);
          expect(cardsAfter, "the card closes").toBe(cardsBefore - 1);
          expect(await pollFor(() => bodyOf(app, card), (x) => x === null, SETTLE_MS), "the host holds no body for it").toBeNull();
          await expectHolder(app, B, "after closing the card", 8_000);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  }

  test.skipIf(!sessionUnderTest(7))(
    "click and chord make a body first responder, typing lands there alone, surfaces take and return focus, and closing hands on",
    async () => {
      const stubDir = stubDirectory();
      const textDir = mkdtempSync(join(tmpdir(), "tug-row07-text-"));
      const textFile = join(textDir, "notes.txt");
      writeFileSync(textFile, "one\ntwo\nthree\n");
      const app = await launchTugApp({
        testName: TEST_NAME,
        foreground: true,
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({
          state: deck(),
          cardStates: { [T]: { content: { path: textFile, anchor: { line: 1, ch: 0 }, scrollTop: 0 } } },
          focusCardId: A,
        });
        await spawnStub(app, A, stubDir, 2);
        await spawnStub(app, B, stubDir, 2);
        await waitForBody(app, A);
        await waitForBody(app, B);
        const a = app.body(A);
        const b = app.body(B);
        const t = await standUpKind(app, cardKind("text"), T);
        await focusBody(app, A);
        await expectHolder(app, A, "at the start");

        // ---- A click inside B's body activates B ----
        note(
          `B's frame ${JSON.stringify((await bodyOf(app, B))?.frame)}; B's composer in B's viewport ` +
            `${await b.evalJS<string>(`JSON.stringify((document.querySelector(${JSON.stringify(PROMPT_INPUT)}) || document.body).getBoundingClientRect())`)}; ` +
            `B's viewport ${await b.evalJS<string>("window.innerWidth + 'x' + window.innerHeight")}; shell viewport ${await app.evalJS<string>("window.innerWidth + 'x' + window.innerHeight")}`,
        );
        await b.nativeClickAtElement(PROMPT_INPUT);
        await expectHolder(app, B, "after a click in B's composer");
        await b.waitForCondition<boolean>(composerFocused, { timeoutMs: SETTLE_MS });
        await app.nativeType("bb");
        const inB = await pollFor(() => b.evalJS<string | null>(composerText), (t) => t?.includes("bb") === true, SETTLE_MS);
        expect(inB, "typing lands in B's composer").toContain("bb");
        expect(await a.evalJS<string | null>(composerText), "and not in A's").not.toContain("bb");

        // ---- The Focus Card chord activates A ----
        await app.nativeKey("ArrowLeft", ["alt", "cmd"]);
        await expectHolder(app, A, "after ⌥⌘← from B");
        await app.nativeKey("k", ["cmd"]);
        await a.waitForCondition<boolean>(composerFocused, { timeoutMs: SETTLE_MS });
        await app.nativeType("aa");
        const inA = await pollFor(() => a.evalJS<string | null>(composerText), (t) => t?.includes("aa") === true, SETTLE_MS);
        expect(inA, "typing lands in A's composer").toContain("aa");
        expect(await b.evalJS<string | null>(composerText), "and not in B's").not.toContain("aa");

        // ---- A click in the Text card's body takes the keyboard there ----
        await t.nativeClickAtElement(TEXT_EDITOR);
        await expectHolder(app, T, "after a click in the Text card");
        await app.nativeType("tt");
        const inT = await pollFor(() => t.evalJS<string>(`document.querySelector(${JSON.stringify(TEXT_EDITOR)})?.textContent ?? ""`), (s) => s.includes("tt"), SETTLE_MS);
        expect(inT, "typing lands in the Text card's body").toContain("tt");
        expect(await a.evalJS<string | null>(composerText), "and not in A's body").not.toContain("tt");
        expect(await b.evalJS<string | null>(composerText), "nor in B's").not.toContain("tt");

        // ---- The body's own surfaces: the slash popup, the session picker ----
        await a.nativeClickAtElement(PROMPT_INPUT);
        await expectHolder(app, A, "after a click in A's composer");
        await a.evalJS(`(function () { var v = document.querySelector(${JSON.stringify(PROMPT_INPUT)}); if (v) { v.focus(); document.execCommand("selectAll"); document.execCommand("delete"); } return true; })()`);
        await app.nativeKey("a", ["cmd"]);
        await app.nativeKey("Backspace");
        const picked = await app.performMenuItem("session.commandPicker");
        note(`Session › Open Command Picker: ${JSON.stringify(picked)}`);
        const popup = await pollFor(() => a.evalJS<boolean>(slashPopupShown), (v) => v, SETTLE_MS);
        note(
          `after Open Command Picker in A: popup ${popup}; composer text ${JSON.stringify(await a.evalJS<string | null>(composerText))}; composer focused ${await a.evalJS<boolean>(composerFocused)}; ` +
            `tooltips ${await a.evalJS<string>(`JSON.stringify(Array.from(document.querySelectorAll(".cm-tooltip")).map(function (t) { return t.className; }))`)}; ` +
            `commandPicker item ${JSON.stringify(await app.menuItemState("session.commandPicker"))}; host ${await responders(app)}`,
        );
        expect(popup, "Open Command Picker opens the slash-command popup in A").toBe(true);
        expect(await a.evalJS<boolean>(composerFocused), "A's composer keeps focus").toBe(true);
        await expectHolder(app, A, "after the slash popup");
        // The popup stands until the "/" it completes goes; this row reads
        // focus, so the draft is emptied here and the popup follows it. That
        // Escape closes it from the keyboard is row 12's assertion ([F17]).
        await a.evalJS(`(function () { var v = document.querySelector(${JSON.stringify(PROMPT_INPUT)}); if (v) { v.focus(); document.execCommand("selectAll"); document.execCommand("delete"); } return true; })()`);
        const popupDown = await pollFor(() => a.evalJS<boolean>(slashPopupShown), (v) => !v, SETTLE_MS);
        expect(popupDown, "the popup goes with the draft").toBe(false);

        const picker = await app.performMenuItem("session.resume");
        note(`Session › Resume: ${JSON.stringify(picker)}`);
        if (picker.found && picker.performed) {
          const shown = await pollFor(() => a.evalJS<boolean>(`document.querySelector(${JSON.stringify(PICKER)}) !== null`), (v) => v, SETTLE_MS);
          expect(shown, "the session picker opens in A").toBe(true);
          const inPicker = await pollFor(
            () => a.evalJS<boolean>(`(function () { var p = document.querySelector(${JSON.stringify(PICKER)}); return p !== null && document.activeElement !== null && p.contains(document.activeElement); })()`),
            (v) => v,
            SETTLE_MS,
          );
          expect(inPicker, "the picker takes focus").toBe(true);
          await app.nativeKey("Escape");
          const gone = await pollFor(() => a.evalJS<boolean>(`document.querySelector(${JSON.stringify(PICKER)}) !== null`), (v) => !v, SETTLE_MS);
          expect(gone, "Escape closes the picker").toBe(false);
          await expectHolder(app, A, "after the picker");
        }

        // ---- The Close popover, in A's own page, takes focus and gives it back ----
        // A's session is bound but empty (a stub plays only when prompted), and
        // an empty Session card closes without asking. An unsent draft is what
        // the confirm protects, so A gets one; it stands through the close below.
        await a.nativeClickAtElement(PROMPT_INPUT);
        await app.nativeType("draft");
        const draft = await pollFor(() => a.evalJS<string | null>(composerText), (t) => t?.includes("draft") === true, SETTLE_MS);
        expect(draft, "the draft lands in A").toContain("draft");
        await app.nativeKey("w", ["cmd"]);
        expect(await pollFor(() => closePopoverUp(app, A), (v) => v, SETTLE_MS), "⌘W raises A's Close popover").toBe(true);
        await expectPopoverHoldsKeyboard(app, A);
        await app.nativeKey("Escape");
        expect(await pollFor(() => closePopoverUp(app, A), (v) => v === false, SETTLE_MS), "Escape dismisses it").toBe(false);
        await expectHolder(app, A, "after the popover");
        await app.nativeType("!");
        const bang = await pollFor(() => a.evalJS<string | null>(composerText), (t) => t?.includes("!") === true, SETTLE_MS);
        expect(bang, "typing after the popover lands in A").toContain("!");

        // ---- Closing the key card hands the keyboard to the next card ----
        // The deck hands the keyboard to the card focused before: make that
        // B — a click in B, then the chord back to A — so the hand-off lands
        // in a body.
        await b.nativeClickAtElement(PROMPT_INPUT);
        await expectHolder(app, B, "B focused before the close");
        await app.nativeKey("ArrowLeft", ["alt", "cmd"]);
        await expectHolder(app, A, "A focused again before the close");
        const cardsBefore = await app.evalJS<number>(`window.tugdeck.diag.listCardIds().length`);
        const closeItem = await app.performMenuItem("file.closeCard");
        note(`File › Close with A key: ${JSON.stringify(closeItem)}`);
        expect(closeItem.found && closeItem.performed, "File › Close performs").toBe(true);
        // A still holds its draft, so the close asks; the popover's Close
        // button answers it.
        const raised = await pollFor(
          async () => ({ popover: await closePopoverUp(app, A), cards: await app.evalJS<number>(`window.tugdeck.diag.listCardIds().length`) }),
          (r) => r.popover || r.cards < cardsBefore,
          SETTLE_MS,
        );
        note(`after File › Close: popover ${raised.popover}, cards ${cardsBefore} → ${raised.cards}`);
        expect(raised.popover, "File › Close over A's draft raises the popover").toBe(true);
        expect(await pressCloseOfPopover(app, A), "the popover's Close button is pressed").toBe(true);
        const cardsAfter = await pollFor(() => app.evalJS<number>(`window.tugdeck.diag.listCardIds().length`), (n) => n < cardsBefore, SETTLE_MS);
        expect(cardsAfter, "A closes").toBe(cardsBefore - 1);
        const gone = await pollFor(() => bodyOf(app, A), (x) => x === null, SETTLE_MS);
        expect(gone, "the host holds no body for A").toBeNull();
        // The close reflows B and T through a settle, which hides and re-shows
        // B's body; the keyboard lands in it at the land.
        await expectHolder(app, B, "after closing A", 8_000);
        await app.nativeKey("k", ["cmd"]);
        await b.waitForCondition<boolean>(composerFocused, { timeoutMs: SETTLE_MS });
        await app.nativeType("next");
        const inNext = await pollFor(() => b.evalJS<string | null>(composerText), (t) => t?.includes("next") === true, SETTLE_MS);
        expect(inNext, "typing lands in B, the next card").toContain("next");
        note(`at the end: ${await responders(app)}`);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
