/**
 * row-05-chords.test.ts — every chord works from a body and from the shell.
 *
 * The bar's fifth row ([B02] row 5). Two body session cards stand beside a
 * Text card in a four-up flow, and every key is posted the way the user's
 * keyboard posts it: the app active, the session event tap, AppKit's
 * key-equivalent scan and then the first responder's web view ([B04]). With
 * a body holding the keyboard: typing, ⌘K, the Edit chords in its composer
 * (select all, cut, paste, undo, redo), the find chords, turn navigation,
 * the dictation toggle, and the deck chords that move its chrome — fold,
 * move to slot, nudge. With the shell holding the keyboard, in the Text
 * card: typing, undo, and the same deck chords. Every leg asserts the
 * effect in the page that should have received it — a composer's text, a
 * find bar's presence, a scroller's offset, the dictation button's face, a
 * pane's slot or fold in the shell's own deck state — never a delivery.
 *
 * This file is `at0739-body-keys` rewritten onto that delivery and moved
 * under the bar; the DOM `keydown` synthesis and the pid-mode keys that file
 * carried are gone ([B04]).
 *
 * Every other kind that is a body has its own chords, read the same way with
 * its body holding the keyboard: the Overview's composer takes typing and
 * the Edit chords, ⌃⌘[ and ⌃⌘] page its column by post, and ⌘D starts and
 * stops dictation in its composer.
 *
 * @foreground
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugdeck/src/lib/keyboard-yield.ts
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugapp/Sources/TestHarness/NativeEventHandlers.swift
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note } from "../_harness";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import {
  SETTLE_MS,
  bodyOf,
  composerFocused,
  composerText,
  focusBody,
  foldedOf,
  landed,
  paneOf,
  pollFor,
  promptPhase,
  responders,
  sessionPane,
  slotOf,
  spawnStub,
  waitForBody,
} from "./_bodies";
import { kindDeck, standUpKind } from "./_kind-bodies";
import { cardKind, kindsUnderTest, sessionUnderTest } from "./_kinds";

const TEST_NAME = "body-grounding-row-05-chords";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const A = "row05-a";
const B = "row05-b";
const T = "row05-text";
const TEXT_EDITOR = `[data-card-id="${T}"] [data-slot="tug-text-card-editor"] .cm-content`;
const FIND_BAR = '[data-slot="session-card-find-bar"]';
const FIND_INPUT = '[data-testid="session-card-find-input"]';
const DICTATION = '[data-testid="tug-dictation-button"]';

/** Two body cards and a Text card, one per slot of a three-up fit, so all three stand on screen. */
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

/**
 * In a page: where the transcript stands — every overflowing element's
 * offset summed, and the text under the middle of the list view — which a
 * turn's navigation changes one way or the other.
 */
const transcriptStand = `(function () {
  var sum = 0;
  document.querySelectorAll("*").forEach(function (e) { if (e.scrollHeight > e.clientHeight + 4) sum += e.scrollTop; });
  var l = document.querySelector('[data-slot="tug-list-view"]');
  if (l === null) return "no list " + sum;
  var r = l.getBoundingClientRect();
  var el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return Math.round(sum) + " " + (el === null ? "nothing" : (el.textContent || "").slice(0, 60));
})()`;

const findBarShown = `document.querySelector(${JSON.stringify(FIND_BAR)}) !== null`;
/** The find field is a text editor host; its caret is a descendant. */
const findInputFocused = `document.activeElement !== null && document.activeElement.closest(${JSON.stringify(FIND_INPUT)}) !== null`;
const findQuery = `(function () { var el = document.querySelector(${JSON.stringify(FIND_INPUT)}); if (el === null) return ""; return (el.querySelector(".cm-content") || el).textContent || ""; })()`;
const dictationMode = `document.querySelector(${JSON.stringify(DICTATION)})?.getAttribute("data-mode") ?? null`;

describe.skipIf(!SHOULD_RUN)("body-grounding row 5: chords", () => {
  test.skipIf(!kindsUnderTest(5).some((k) => k.componentId === "overview"))(
    "overview: its composer's typing and Edit chords, its paging chords and ⌘D act in its body",
    async () => {
      const card = "row05-overview";
      const kind = cardKind("overview");
      const app = await launchTugApp({ testName: `${TEST_NAME}-overview`, foreground: true, bodies: true });
      try {
        const now = Date.now();
        app.seedLedger({
          overview_posts: Array.from({ length: 30 }, (_, i) => ({
            at_ms: now - (30 - i) * 60_000,
            author: "observer" as const,
            body: `Post ${i + 1}: a line of work narrated, long enough to wrap once in a rail and so give the column something to page.`,
            refs: [],
          })),
        });
        await app.seedDeckState({ state: kindDeck(kind, card, { sessions: [B] }), focusCardId: card });
        const o = await standUpKind(app, kind, card);
        const field = `(document.querySelector(${JSON.stringify(kind.field)}) || { textContent: "" }).textContent`;
        await focusBody(app, card, { composer: false });
        await o.nativeClickAtElement(kind.field!);

        await app.nativeType("hello");
        expect(await pollFor(() => o.evalJS<string>(field), (t) => t.includes("hello"), SETTLE_MS), "typing lands in its composer").toContain("hello");
        await app.nativeKey("a", ["cmd"]);
        await app.nativeKey("x", ["cmd"]);
        expect(await pollFor(() => o.evalJS<string>(field), (t) => !t.includes("hello"), SETTLE_MS), "⌘A ⌘X empties it").not.toContain("hello");
        await app.nativeKey("v", ["cmd"]);
        expect(await pollFor(() => o.evalJS<string>(field), (t) => t.includes("hello"), SETTLE_MS), "⌘V pastes the cut text back").toContain("hello");
        await app.nativeKey("z", ["cmd"]);
        expect(await pollFor(() => o.evalJS<string>(field), (t) => !t.includes("hello"), SETTLE_MS), "⌘Z undoes the paste").not.toContain("hello");
        await app.nativeKey("z", ["cmd", "shift"]);
        expect(await pollFor(() => o.evalJS<string>(field), (t) => t.includes("hello"), SETTLE_MS), "⇧⌘Z redoes it").toContain("hello");

        const before = await o.evalJS<string>(transcriptStand);
        await app.nativeKey("[", ["ctrl", "cmd"]);
        const afterPrev = await pollFor(() => o.evalJS<string>(transcriptStand), (v) => v !== before, 1_500);
        await app.nativeKey("]", ["ctrl", "cmd"]);
        const afterNext = await pollFor(() => o.evalJS<string>(transcriptStand), (v) => v !== afterPrev, 1_500);
        note(`paging the column: ${JSON.stringify(before)} → ⌃⌘[ ${JSON.stringify(afterPrev)} → ⌃⌘] ${JSON.stringify(afterNext)}`);
        expect(afterPrev !== before || afterNext !== afterPrev, "⌃⌘[ or ⌃⌘] pages its column").toBe(true);

        await o.nativeClickAtElement(kind.field!);
        const idle = await o.evalJS<string | null>(dictationMode);
        await app.nativeKey("d", ["cmd"]);
        const live = await pollFor(() => o.evalJS<string | null>(dictationMode), (m) => m !== null && m !== idle, SETTLE_MS);
        note(`dictation in its composer: ${idle} → ⌘D ${live}`);
        expect(live, "⌘D starts dictation in its composer").not.toBe(idle);
        await app.nativeKey("d", ["cmd"]);
        expect(await pollFor(() => o.evalJS<string | null>(dictationMode), (m) => m === idle, 6_000), "⌘D again stops it").toBe(idle);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test.skipIf(!sessionUnderTest(5))(
    "every chord acts in the page that holds the keyboard, body or shell",
    async () => {
      const stubDir = stubDirectory();
      const textDir = mkdtempSync(join(tmpdir(), "tug-row05-text-"));
      const textFile = join(textDir, "notes.txt");
      writeFileSync(textFile, Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
      const app = await launchTugApp({
        testName: TEST_NAME,
        foreground: true,
        bodies: true,
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({
          state: deck(),
          cardStates: { [T]: { content: { path: textFile, anchor: { line: 1, ch: 0 }, scrollTop: 0 } } },
          focusCardId: A,
        });
        // A's stub replays one turn per prompt sent, streamed at a token
        // cadence; the turn leg sends one, which gives the transcript a user
        // cell and a tall assistant cell to page between. Twelve messages is
        // taller than the pane and streams in seconds.
        await spawnStub(app, A, stubDir, 12, 1);
        await spawnStub(app, B, stubDir, 2);
        await waitForBody(app, A);
        await waitForBody(app, B);
        const a = app.body(A);
        const b = app.body(B);

        // ================= With a body holding the keyboard =================
        await focusBody(app, A);
        note(`A focused: ${await responders(app)}`);

        // ---- Typing ----
        await app.nativeType("hello");
        const typed = await pollFor(() => a.evalJS<string | null>(composerText), (t) => t?.includes("hello") === true, SETTLE_MS);
        expect(typed, "typing lands in A's composer").toContain("hello");
        expect(await b.evalJS<string | null>(composerText), "and not in B's").not.toContain("hello");

        // ---- ⌘K: the key card's own chord, from the body's funnel ----
        await a.evalJS(`(document.activeElement && document.activeElement.blur(), true)`);
        expect(await a.evalJS<boolean>(composerFocused), "A's composer is blurred").toBe(false);
        await app.nativeKey("k", ["cmd"]);
        const refocused = await pollFor(() => a.evalJS<boolean>(composerFocused), (v) => v, SETTLE_MS);
        expect(refocused, "⌘K focuses A's composer").toBe(true);

        // ---- Edit chords in the composer: select all, cut, paste, undo, redo ----
        note(
          `Edit items with A's composer focused: selectAll ${JSON.stringify(await app.menuItemState("edit.selectAll"))}; ` +
            `cut ${JSON.stringify(await app.menuItemState("edit.cut"))}; paste ${JSON.stringify(await app.menuItemState("edit.paste"))}`,
        );
        await app.nativeKey("a", ["cmd"]);
        await app.nativeKey("x", ["cmd"]);
        const cut = await pollFor(() => a.evalJS<string | null>(composerText), (t) => t !== null && !t.includes("hello"), SETTLE_MS);
        expect(cut ?? "", "⌘A ⌘X empties A's composer").not.toContain("hello");
        await app.nativeKey("v", ["cmd"]);
        const pasted = await pollFor(() => a.evalJS<string | null>(composerText), (t) => t?.includes("hello") === true, SETTLE_MS);
        expect(pasted, "⌘V pastes the cut text back").toContain("hello");
        await app.nativeKey("z", ["cmd"]);
        const undone = await pollFor(() => a.evalJS<string | null>(composerText), (t) => t !== null && !t.includes("hello"), SETTLE_MS);
        expect(undone ?? "", "⌘Z undoes the paste").not.toContain("hello");
        await app.nativeKey("z", ["cmd", "shift"]);
        const redone = await pollFor(() => a.evalJS<string | null>(composerText), (t) => t?.includes("hello") === true, SETTLE_MS);
        expect(redone, "⇧⌘Z redoes it").toContain("hello");
        note(`edit chords in A: cut ${JSON.stringify(cut)} → paste ${JSON.stringify(pasted)} → undo ${JSON.stringify(undone)} → redo ${JSON.stringify(redone)}`);

        // ---- Find chords: ⌘F opens the body's find bar and focuses it; ⌘G, ⇧⌘G; Escape closes ----
        await app.nativeKey("f", ["cmd"]);
        const barUp = await pollFor(() => a.evalJS<boolean>(findBarShown), (v) => v, SETTLE_MS);
        expect(barUp, "⌘F opens A's find bar").toBe(true);
        const barFocused = await pollFor(() => a.evalJS<boolean>(findInputFocused), (v) => v, SETTLE_MS);
        note(
          `after ⌘F in A: input focused ${barFocused}; A's active element ${await a.evalJS<string>(`document.activeElement ? document.activeElement.tagName + "." + document.activeElement.className + "#" + (document.activeElement.getAttribute("data-testid") || "") : "none"`)}; ` +
            `A's responder ${await a.evalJS<string>("String(window.__tug.getFirstResponderId())")}; A's key card ${await a.evalJS<string>("String(window.__tug.getKeyCardId())")}; ` +
            `find input ${await a.evalJS<string>(`JSON.stringify((function(){ var i = document.querySelector(${JSON.stringify(FIND_INPUT)}); return i ? { tag: i.tagName, focus: i.getAttribute("data-tug-focus"), disabled: i.disabled } : null; })())`)}; host ${await responders(app)}`,
        );
        expect(barFocused, "the find bar's input takes focus").toBe(true);
        await a.evalJS(`(function () {
          var log = (window.__row05log = []);
          var desc = function (el) { return el ? el.tagName + "." + String(el.className).slice(0, 30) : "none"; };
          document.addEventListener("keydown", function (e) { log.push("keydown " + e.key + " at " + desc(document.activeElement)); }, true);
          document.addEventListener("focusin", function (e) { log.push("focusin " + desc(e.target)); }, true);
          document.addEventListener("focusout", function (e) { log.push("focusout " + desc(e.target)); }, true);
          new MutationObserver(function () { if (document.querySelector(${JSON.stringify(FIND_BAR)}) === null) log.push("find bar gone"); }).observe(document.body, { childList: true, subtree: true });
          return true;
        })()`);
        await app.nativeType("message");
        const query = await pollFor(() => a.evalJS<string>(findQuery), (v) => v.includes("message"), SETTLE_MS);
        note(
          `after typing in the find bar: query ${JSON.stringify(query)}; bar ${await a.evalJS<string>(`(function () { var b = document.querySelector(${JSON.stringify(FIND_BAR)}); return b ? b.outerHTML.slice(0, 900) : "none"; })()`)}; ` +
            `active ${await a.evalJS<string>(`document.activeElement ? document.activeElement.tagName + "." + document.activeElement.className + " text=" + JSON.stringify((document.activeElement.textContent || "").slice(0, 40)) : "none"`)}; ` +
            `log ${await a.evalJS<string>("JSON.stringify(window.__row05log.slice(0, 40))")}`,
        );
        expect(query, "typing lands in the find bar").toContain("message");
        await app.nativeKey("g", ["cmd"]);
        await app.nativeKey("g", ["cmd", "shift"]);
        expect(await a.evalJS<boolean>(findBarShown), "⌘G and ⇧⌘G leave the bar standing").toBe(true);
        await app.nativeKey("Escape");
        const barDown = await pollFor(() => a.evalJS<boolean>(findBarShown), (v) => !v, SETTLE_MS);
        expect(barDown, "Escape closes the find bar").toBe(false);
        expect(await b.evalJS<boolean>(findBarShown), "B never showed a find bar").toBe(false);

        // ---- Turn navigation: the transcript pages, one way or the other ----
        // The stub replays one long turn per prompt sent, and a body's
        // transcript is empty until one is: so one prompt first, run to idle,
        // which gives the list two cells to page between. Where it then stands
        // decides which chord has somewhere to go — a list at its bottom pages
        // up, one at its top pages down — so both are pressed and the pair
        // must move it.
        await focusBody(app, A);
        await a.driveSession({ op: "send", text: "turn one" });
        await a.waitForCondition<boolean>(`${promptPhase} !== "idle"`, { timeoutMs: SETTLE_MS }).catch(() => undefined);
        await a.waitForCondition<boolean>(`${promptPhase} === "idle"`, { timeoutMs: 120_000 });
        await focusBody(app, A);
        const beforeTurn = await a.evalJS<string>(transcriptStand);
        await app.nativeKey("[", ["ctrl", "cmd"]);
        const afterPrev = await pollFor(() => a.evalJS<string>(transcriptStand), (v) => v !== beforeTurn, 1_500);
        await app.nativeKey("]", ["ctrl", "cmd"]);
        const afterNext = await pollFor(() => a.evalJS<string>(transcriptStand), (v) => v !== afterPrev, 1_500);
        note(
          `turn navigation in A: ${JSON.stringify(beforeTurn)} → ⌃⌘[ ${JSON.stringify(afterPrev)} → ⌃⌘] ${JSON.stringify(afterNext)}; ` +
            `items ${JSON.stringify(await app.menuItemState("go.previousTurn"))}; ` +
            `transcript ${await a.evalJS<string>(`(function () { var l = document.querySelector('[data-slot="tug-list-view"]'); if (!l) return "none"; var r = l.getBoundingClientRect(); var rows = document.querySelectorAll('[data-testid="session-card-transcript-user-body"]').length; var sc = l.closest("[data-slot]") ; return "box " + Math.round(r.width) + "x" + Math.round(r.height) + " scroll " + l.scrollTop + "/" + l.scrollHeight + " overflow " + getComputedStyle(l).overflowY + " userRows " + rows + " children " + l.children.length + " parentScroll " + (l.parentElement ? l.parentElement.scrollTop + "/" + l.parentElement.scrollHeight + " " + getComputedStyle(l.parentElement).overflowY : "-"); })()`)}`,
        );
        expect(afterPrev !== beforeTurn || afterNext !== afterPrev, "⌃⌘[ or ⌃⌘] pages A's transcript").toBe(true);

        // ---- Dictation toggle: the body's own button changes face ----
        await focusBody(app, A);
        const idle = await a.evalJS<string | null>(dictationMode);
        await app.nativeKey("d", ["cmd"]);
        const live = await pollFor(() => a.evalJS<string | null>(dictationMode), (m) => m !== null && m !== idle, SETTLE_MS);
        note(`dictation in A: ${idle} → ⌘D ${live}`);
        expect(live, "⌘D starts dictation in A").not.toBe(idle);
        expect(await b.evalJS<string | null>(dictationMode), "B's dictation is untouched").toBe(idle);
        await app.nativeKey("d", ["cmd"]);
        const stopped = await pollFor(() => a.evalJS<string | null>(dictationMode), (m) => m === idle, 6_000);
        expect(stopped, "⌘D again stops it").toBe(idle);

        // ---- Deck chords from the body: fold, move to slot, nudge ----
        await focusBody(app, A);
        await app.nativeKey("y", ["ctrl", "cmd"]);
        const folded = await pollFor(() => foldedOf(app, A), (v) => v, SETTLE_MS);
        expect(folded, "⌃⌘Y folds A's pane").toBe(true);
        const hidden = await pollFor(() => bodyOf(app, A), (x) => x?.visible === false, SETTLE_MS);
        expect(hidden?.visible, "the host hides A's folded body").toBe(false);
        await app.nativeKey("y", ["ctrl", "cmd"]);
        const unfolded = await pollFor(() => foldedOf(app, A), (v) => !v, SETTLE_MS);
        expect(unfolded, "⌃⌘Y unfolds it").toBe(false);
        const shownAgain = await pollFor(() => bodyOf(app, A), (x) => x?.visible === true, SETTLE_MS);
        expect(shownAgain?.visible, "the host shows A's body again").toBe(true);

        await focusBody(app, A, { composer: false });
        expect(await slotOf(app, A), "A starts in slot 1").toBe(0);
        await app.nativeKey("2", ["cmd"]);
        const moved = await pollFor(() => slotOf(app, A), (s) => s === 1, SETTLE_MS);
        expect(moved, "⌘2 moves A to slot 2").toBe(1);
        await landed(app, A);
        await app.nativeKey("1", ["cmd"]);
        const back = await pollFor(() => slotOf(app, A), (s) => s === 0, SETTLE_MS);
        expect(back, "⌘1 moves it back").toBe(0);
        await landed(app, A);
        note(
          `before the nudge: shell layout selection ${await app.evalJS<string>("JSON.stringify(window.__tug.getLayoutSelection())")}; shell responder ${await app.evalJS<string>("String(window.__tug.getFirstResponderId())")}; ` +
            `shell focused card ${await app.getFocusedCardId()}; host ${await responders(app)}`,
        );
        await app.nativeKey("]", ["cmd", "alt", "shift"]);
        const nudged = await pollFor(() => slotOf(app, A), (s) => s === 1, SETTLE_MS);
        if (nudged !== 1) {
          note(`the nudge did not move A: slots A ${await slotOf(app, A)} B ${await slotOf(app, B)} T ${await slotOf(app, T)}; host ${await responders(app)}; shell responder ${await app.evalJS<string>("String(window.__tug.getFirstResponderId())")}`);
        }
        expect(nudged, "⇧⌥⌘] nudges A right").toBe(1);
        await landed(app, A);
        await app.nativeKey("[", ["cmd", "alt", "shift"]);
        const nudgedBack = await pollFor(() => slotOf(app, A), (s) => s === 0, SETTLE_MS);
        expect(nudgedBack, "⇧⌥⌘[ nudges it back").toBe(0);
        await landed(app, A);
        note(`deck chords from A: ${await responders(app)}`);

        // ================= With the shell holding the keyboard =================
        await app.nativeClickAtElement(TEXT_EDITOR);
        await app.waitForCondition<boolean>(`document.activeElement !== null && document.activeElement.matches(${JSON.stringify(TEXT_EDITOR)})`, { timeoutMs: SETTLE_MS });
        const shellHolds = await pollFor(() => app.bodies(), (bs) => bs.every((x) => !x.firstResponder), SETTLE_MS);
        expect(shellHolds.every((x) => !x.firstResponder), "no body holds the keyboard while the Text card is focused").toBe(true);
        const aBefore = await a.evalJS<string | null>(composerText);
        await app.nativeType("shell");
        const shellTyped = await pollFor(() => app.evalJS<string>(`document.querySelector(${JSON.stringify(TEXT_EDITOR)})?.textContent ?? ""`), (t) => t.includes("shell"), SETTLE_MS);
        expect(shellTyped, "typing lands in the Text card").toContain("shell");
        expect(await a.evalJS<string | null>(composerText), "and not in A's body").toBe(aBefore);
        note(
          `before ⌘Z in the Text card: shell focused card ${await app.getFocusedCardId()}; shell responder ${await app.evalJS<string>("String(window.__tug.getFirstResponderId())")}; ` +
            `undo item ${JSON.stringify(await app.menuItemState("edit.undo"))}; host ${await responders(app)}`,
        );
        await app.nativeKey("z", ["cmd"]);
        const shellUndone = await pollFor(() => app.evalJS<string>(`document.querySelector(${JSON.stringify(TEXT_EDITOR)})?.textContent ?? ""`), (t) => !t.includes("shell"), SETTLE_MS);
        expect(shellUndone, "⌘Z undoes the typing in the Text card").not.toContain("shell");

        expect(await slotOf(app, T), "the Text card starts in slot 3").toBe(2);
        await app.nativeKey("1", ["cmd"]);
        const tMoved = await pollFor(() => slotOf(app, T), (s) => s === 0, SETTLE_MS);
        expect(tMoved, "⌘1 from the shell moves the Text card to slot 1").toBe(0);
        await Bun.sleep(1_200);
        await app.nativeKey("3", ["cmd"]);
        const tBack = await pollFor(() => slotOf(app, T), (s) => s === 2, SETTLE_MS);
        expect(tBack, "⌘3 moves it back").toBe(2);
        await Bun.sleep(1_200);
        await app.nativeKey("y", ["ctrl", "cmd"]);
        const tFolded = await pollFor(() => foldedOf(app, T), (v) => v, SETTLE_MS);
        expect(tFolded, "⌃⌘Y from the shell folds the Text card").toBe(true);
        await Bun.sleep(1_200);
        await app.nativeKey("y", ["ctrl", "cmd"]);
        const tUnfolded = await pollFor(() => foldedOf(app, T), (v) => !v, SETTLE_MS);
        expect(tUnfolded, "⌃⌘Y unfolds it").toBe(false);
        const aStill = await bodyOf(app, A);
        expect(aStill?.visible, "A's body stood visible through the shell's chords").toBe(true);
        expect(await app.evalJS<boolean>(`document.querySelector(${JSON.stringify(paneOf(A))}) !== null`), "A's pane stands").toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
