/**
 * at0739-body-keys.test.ts — the keyboard reaches a Session card's body.
 *
 * Native key events, posted as the user's keyboard posts them, must reach
 * the body of the key card: typing lands in its composer, and a chord the
 * JS funnel alone answers (⌘K, focus the prompt — `preventDefault`, not menu
 * eligible) acts in the body after its composer is blurred. The shell is
 * not a party to either: the body's web view is the window's first
 * responder, and its own document's funnel answers the chord.
 *
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/body/body-root.tsx
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugapp/Sources/BodyViewController.swift
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import type { BodyViewSnapshot } from "./_harness/client";
import { onTestRunEnd } from "./_harness/test-cleanup";
import { STUB_TRANSCRIPT_DIR_ENV, streamingTranscript, stubDirectory } from "./streaming-stub-fixture";

const TEST_NAME = "at0739-body-keys";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const BODY_CARD = "at0739-a";
const PROMPT_INPUT = '[data-slot="tug-text-editor"] .cm-content';
const BODY_READY_MS = 30_000;
const SETTLE_MS = 3_000;

const oneCard = {
  cards: [{ id: BODY_CARD, componentId: "session", title: "Body", closable: true }],
  panes: [
    {
      id: `${BODY_CARD}-pane`,
      position: { x: 40, y: 40 },
      size: { width: 640, height: 480 },
      cardIds: [BODY_CARD],
      activeCardId: BODY_CARD,
      title: "",
      acceptsFamilies: ["maker"],
      slot: 0,
    },
  ],
  activePaneId: `${BODY_CARD}-pane`,
  imposition: { kind: "four-up", layout: "flow", sidebars: {} },
  hasFocus: true,
};

const composerFocused = `document.activeElement !== null && document.activeElement.matches(${JSON.stringify(PROMPT_INPUT)})`;
const composerText = `(document.querySelector(${JSON.stringify(PROMPT_INPUT)}) || { textContent: null }).textContent`;
const firstResponderJs = `(typeof window.__tug.getFirstResponderId === "function" ? window.__tug.getFirstResponderId() : "(no accessor)")`;

async function pollFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const started = Date.now();
  let last = await read();
  while (!done(last) && Date.now() - started < timeoutMs) {
    await Bun.sleep(50);
    last = await read();
  }
  return last;
}

async function bodyOf(app: App): Promise<BodyViewSnapshot | null> {
  return (await app.bodies()).find((b) => b.cardId === BODY_CARD) ?? null;
}

const CONFIRM_POPOVER = '[data-slot="tug-confirm-popover"]';
const popoverPresent = `document.querySelector(${JSON.stringify(CONFIRM_POPOVER)}) !== null`;
/** The shell's Close popover is the shell's: its Close button is clicked there, and the card goes. */
async function confirmClose(app: App, cardsBefore: number, what: string): Promise<void> {
  const shown = await pollFor(() => app.evalJS<boolean>(popoverPresent), (v) => v, SETTLE_MS);
  const facts = await app.evalJS<unknown>(`(function () {
    var fr = ${firstResponderJs};
    var panes = Array.from(document.querySelectorAll(".tug-pane")).map(function (p) {
      return { pane: p.getAttribute("data-pane-id"), focused: p.getAttribute("data-focused"), body: p.hasAttribute("data-body-card"),
        closeButton: p.querySelector('[data-testid="tug-pane-close-button"]') !== null };
    });
    return { fr: fr, keyCard: window.__tug.getKeyCardId(), panes: panes, cards: window.tugdeck.diag.listCardIds() };
  })()`);
  note(`${what}: Close popover in the shell: ${shown}; shell facts ${JSON.stringify(facts)}`);
  expect(shown, `${what} raises the shell's Close popover for the session card`).toBe(true);
  const rect = await app.evalJS<{ x: number; y: number } | null>(`(function () {
    var root = document.querySelector(${JSON.stringify(CONFIRM_POPOVER)});
    if (root === null) return null;
    var btns = root.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      if ((btns[i].textContent || "").trim() === "Close") { var r = btns[i].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }
    }
    return null;
  })()`);
  expect(rect, `${what}: the popover has a Close button`).not.toBeNull();
  await app.nativeClick(rect!);
  const after = await pollFor(() => app.evalJS<number>(`window.tugdeck.diag.listCardIds().length`), (n) => n < cardsBefore, SETTLE_MS);
  note(`${what}: cards ${cardsBefore} → ${after}`);
  expect(after, `${what} closes the card once confirmed`).toBe(cardsBefore - 1);
}

const OTHER_CARD = "at0739-b";
const twoSideBySide = {
  cards: [
    { id: BODY_CARD, componentId: "session", title: "A", closable: true },
    { id: OTHER_CARD, componentId: "session", title: "B", closable: true },
  ],
  panes: [BODY_CARD, OTHER_CARD].map((cardId, i) => ({
    id: `${cardId}-pane`,
    position: { x: 40 + i * 700, y: 40 },
    size: { width: 640, height: 480 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot: i,
  })),
  activePaneId: `${BODY_CARD}-pane`,
  imposition: { kind: "four-up", layout: "flow", sidebars: {} },
  hasFocus: true,
};

async function spawnStub(app: App, cardId: string, stubDir: string): Promise<void> {
  const tugSessionId = randomUUID();
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-at0739-project-")));
  onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
  writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(streamingTranscript(2, 1)));
  await app.spawnSessionNew(cardId, { tugSessionId, projectDir });
}

describe.skipIf(!SHOULD_RUN)("at0739: the keyboard reaches a body", () => {
  test(
    "typing lands in the body's composer and ⌘K focuses it from the body's own funnel",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({
        testName: TEST_NAME,
        env: { TUG_BODY_VIEWS: "1", [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({ state: oneCard, focusCardId: BODY_CARD });
        const tugSessionId = randomUUID();
        const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-at0739-project-")));
        onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
        writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(streamingTranscript(2, 1)));
        await app.spawnSessionNew(BODY_CARD, { tugSessionId, projectDir });
        const ready = await pollFor(() => bodyOf(app), (b) => b !== null && b.state === "ready" && b.visible, BODY_READY_MS);
        expect(ready?.state, "the card's body reports ready").toBe("ready");

        const body = app.body(BODY_CARD);
        await body.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(PROMPT_INPUT)}) !== null`, {
          timeoutMs: BODY_READY_MS,
        });

        // ---- A click in the composer, then typing ----
        await body.nativeClickAtElement(PROMPT_INPUT);
        await body.waitForCondition<boolean>(composerFocused, { timeoutMs: SETTLE_MS });
        await app.nativeType("hello");
        const typed = await pollFor(() => body.evalJS<string | null>(composerText), (t) => t !== null && t.includes("hello"), SETTLE_MS);
        note(
          `after typing: composer text ${JSON.stringify(typed)}; shell responder ${await app.evalJS<string>(firstResponderJs)}, ` +
            `body responder ${await body.evalJS<string>(firstResponderJs)}, body hasFocus ${await body.evalJS<boolean>("document.hasFocus()")}`,
        );
        expect(typed, "typed text reaches the body's composer").toContain("hello");

        // ---- Blur the composer inside the body, then ⌘K from the keyboard ----
        await body.evalJS(`(document.activeElement && document.activeElement.blur(), true)`);
        expect(await body.evalJS<boolean>(composerFocused), "the composer is blurred").toBe(false);
        await app.nativeKey("k", ["cmd"]);
        const refocused = await pollFor(() => body.evalJS<boolean>(composerFocused), (v) => v, SETTLE_MS);
        note(
          `after ⌘K: composer focused ${refocused}; shell responder ${await app.evalJS<string>(firstResponderJs)}, ` +
            `body responder ${await body.evalJS<string>(firstResponderJs)}`,
        );
        expect(refocused, "⌘K focuses the body's composer").toBe(true);

        // ---- Keys after the shell has had the pointer: click the body again, type more ----
        await app.nativeType(" world");
        const more = await pollFor(() => body.evalJS<string | null>(composerText), (t) => t !== null && t.includes("world"), SETTLE_MS);
        expect(more, "typing after the chord still lands in the body").toContain("world");

        // ---- Activation from the shell: a click on the card's title bar, then keys ----
        await app.nativeClickAtElement(`[data-pane-id="${BODY_CARD}-pane"] [data-testid="tug-pane-title-bar"]`);
        await Bun.sleep(500);
        const held = await pollFor(() => bodyOf(app), (x) => x?.firstResponder === true, SETTLE_MS);
        expect(held?.firstResponder, "the body holds the keyboard after a title-bar activation").toBe(true);
        const afterBar = {
          shellResponder: await app.evalJS<string>(firstResponderJs),
          shellFocusedCard: await app.getFocusedCardId(),
          bodyResponder: await body.evalJS<string>(firstResponderJs),
          bodyActive: await body.evalJS<string>(`document.activeElement ? document.activeElement.tagName + "." + document.activeElement.className : "none"`),
          hostFirstResponder: await app.evalJS<string | null>(`window.__tugMotion && window.__tugMotion.hostFirstResponder ? String(window.__tugMotion.hostFirstResponder()) : null`),
        };
        note(`after the shell title-bar click: ${JSON.stringify(afterBar)}`);
        await app.nativeKey("k", ["cmd"]);
        const barK = await pollFor(() => body.evalJS<boolean>(composerFocused), (v) => v, SETTLE_MS);
        note(`⌘K after the title-bar click: composer focused ${barK}`);
        expect(barK, "⌘K after activating the card from the shell focuses the body's composer").toBe(true);
        await app.nativeType("!");
        const bang = await pollFor(() => body.evalJS<string | null>(composerText), (t) => t !== null && t.includes("!"), SETTLE_MS);
        expect(bang, "typing after a shell activation lands in the body").toContain("!");

        // ---- Deck chords while the body holds the keyboard ----
        const themeBefore = await app.evalJS<string | null>(`getComputedStyle(document.querySelector("[data-deck-canvas-floor]") || document.body).backgroundColor`);
        await app.nativeKey("t", ["cmd", "shift"]);
        const themeAfter = await pollFor(
          () => app.evalJS<string | null>(`getComputedStyle(document.querySelector("[data-deck-canvas-floor]") || document.body).backgroundColor`),
          (t) => t !== themeBefore,
          SETTLE_MS,
        );
        note(`⇧⌘T from the body: theme ${themeBefore} → ${themeAfter}`);
        expect(themeAfter, "a deck chord pressed in the body acts in the shell").not.toBe(themeBefore);

        const frameBefore = (await bodyOf(app))!.frame;
        await app.nativeKey("=", ["cmd"]);
        const frameAfter = await pollFor(() => bodyOf(app), (b) => b !== null && b.frame.width !== frameBefore.width, SETTLE_MS);
        note(`⌘= from the body: body width ${frameBefore.width} → ${frameAfter?.frame.width}`);
        expect(frameAfter?.frame.width, "a zoom chord pressed in the body zooms the deck").not.toBe(frameBefore.width);

        // ---- The body's own funnel: a chord the body page sees first ----
        //
        // The harness's native keys reach AppKit's menu scan before any page;
        // the user's keyboard reaches the key page first. So the page's path
        // is driven as the page sees it: a keydown dispatched in the body's
        // document. ⇧⌘T is the deck's; ⌘W is the pane's. Neither has a
        // handler in the body, so both must come back to the shell.
        const keydownIn = (key: string, code: string, mods: string): string =>
          `(function () { var e = new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)}, ${mods}, bubbles: true, cancelable: true });
             (document.activeElement || document.body).dispatchEvent(e); return e.defaultPrevented; })()`;
        const themeBefore2 = await app.evalJS<string | null>(`getComputedStyle(document.querySelector("[data-deck-canvas-floor]") || document.body).backgroundColor`);
        const preventedT = await body.evalJS<boolean>(keydownIn("T", "KeyT", "metaKey: true, shiftKey: true"));
        const themeAfter2 = await pollFor(
          () => app.evalJS<string | null>(`getComputedStyle(document.querySelector("[data-deck-canvas-floor]") || document.body).backgroundColor`),
          (t) => t !== themeBefore2,
          SETTLE_MS,
        );
        note(`⇧⌘T seen by the body page first (prevented ${preventedT}): theme ${themeBefore2} → ${themeAfter2}`);
        expect(themeAfter2, "a deck chord the body page sees first still acts in the shell").not.toBe(themeBefore2);

        const cardsBefore = await app.evalJS<number>(`window.tugdeck.diag.listCardIds().length`);
        const preventedW = await body.evalJS<boolean>(keydownIn("w", "KeyW", "metaKey: true"));
        note(`⌘W seen by the body page first: prevented ${preventedW}`);
        await confirmClose(app, cardsBefore, "⌘W from the body");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "activating another body card from the shell moves the keyboard to it, placement and re-stacking included",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({
        testName: TEST_NAME,
        env: { TUG_BODY_VIEWS: "1", [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({ state: twoSideBySide, focusCardId: BODY_CARD });
        await spawnStub(app, BODY_CARD, stubDir);
        await spawnStub(app, OTHER_CARD, stubDir);
        const both = await pollFor(
          () => app.bodies(),
          (bs) => [BODY_CARD, OTHER_CARD].every((id) => bs.some((b) => b.cardId === id && b.state === "ready" && b.visible)),
          BODY_READY_MS,
        );
        note(`bodies: ${JSON.stringify(both.map((b) => ({ card: b.cardId, z: (b as { z?: number }).z, visible: b.visible })))}`);
        const a = app.body(BODY_CARD);
        const b = app.body(OTHER_CARD);
        for (const v of [a, b]) {
          await v.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(PROMPT_INPUT)}) !== null`, { timeoutMs: BODY_READY_MS });
        }

        // Type in A, then activate B from the shell and type there; then back to A.
        await a.nativeClickAtElement(PROMPT_INPUT);
        await a.waitForCondition<boolean>(composerFocused, { timeoutMs: SETTLE_MS });
        await app.nativeType("aa");
        expect(await pollFor(() => a.evalJS<string | null>(composerText), (t) => t?.includes("aa") === true, SETTLE_MS)).toContain("aa");

        for (const [view, id, text] of [[b, OTHER_CARD, "bb"], [a, BODY_CARD, "cc"]] as const) {
          await app.nativeClickAtElement(`[data-pane-id="${id}-pane"] [data-testid="tug-pane-title-bar"]`);
          await pollFor(() => app.getFocusedCardId(), (f) => f === id, SETTLE_MS);
          // The keyboard must be the body's before any key is pressed, and
          // stay its: the shell parks its key sink after the activation,
          // and a park that focused would take the keys back.
          await Bun.sleep(500);
          const holder = await pollFor(
            () => app.bodies(),
            (bs) => bs.some((x) => x.cardId === id && x.firstResponder),
            SETTLE_MS,
          );
          note(`${id}: first responder after activation: ${JSON.stringify(holder.map((x) => ({ card: x.cardId, fr: x.firstResponder })))}`);
          expect(holder.some((x) => x.cardId === id && x.firstResponder), `${id}'s body holds the keyboard after activation from the shell`).toBe(true);
          await app.nativeKey("k", ["cmd"]);
          const focused = await pollFor(() => view.evalJS<boolean>(composerFocused), (v) => v, SETTLE_MS);
          note(`${id}: after title-bar activation and ⌘K, composer focused ${focused}; bodies ${JSON.stringify((await app.bodies()).map((x) => ({ card: x.cardId, z: (x as { z?: number }).z })))}`);
          expect(focused, `⌘K reaches ${id} after activating it from the shell`).toBe(true);
          await Bun.sleep(200);
          await app.nativeType(text);
          const got = await pollFor(() => view.evalJS<string | null>(composerText), (t) => t?.includes(text) === true, SETTLE_MS);
          expect(got, `typing reaches ${id} after activating it from the shell`).toContain(text);
        }

        // ---- The Session menu's Close, as the host sends it, with a body key ----
        const before = await app.evalJS<number>(`window.tugdeck.diag.listCardIds().length`);
        await app.dispatchControlAction("close");
        await confirmClose(app, before, `menu Close with ${BODY_CARD} key`);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
