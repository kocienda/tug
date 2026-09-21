/**
 * at0403-find-selection.test.ts — ⌘E turns the selection into the search.
 *
 * ## Why this exists
 *
 * Use Selection for Find is the gesture that removes the copy → ⌘F → paste
 * detour: select a word, press ⌘E, and the find bar is up with that word as
 * the query and the first match already active. It is one command
 * (`find-selection`) reaching two selection models through the responder
 * chain — the Session card reads the DOM selection inside the card, the Text
 * card's editor reads its CM6 range — so the suite drives BOTH, and drives
 * each twice: once summoning the bar and once re-seeding a bar already up.
 *
 * The re-seed half is the load-bearing one. ⌘F is a toggle, and copying its
 * shape here would make the second ⌘E dismiss the very bar the first one
 * opened; ⌘E only ever seeds.
 *
 * ## What it drives, and why not the chord
 *
 * The command is dispatched as the control frame Edit ▸ Find ▸ Use Selection
 * for Find sends (`dispatchControlAction("find-selection")`), which is the
 * production path for ⌘E: the item carries a key equivalent, so AppKit
 * resolves the chord at the menu bar and the web view never sees a keydown.
 * at0168 pins the key equivalent onto the item; at0174 pins the gate going
 * dark where nothing implements find.
 *
 * The selection itself is a real one — a native double-click on a word, the
 * same gesture and the same `window.getSelection()` a user produces.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/command-registry.ts
 * @covers tugdeck/src/components/tugways/tug-find-bar.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 * @covers tugdeck/src/components/tugways/cards/text-card.tsx
 * @covers tugdeck/src/components/tugways/cards/text-card-find-bar.tsx
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.tsx
 * @covers tugapp/Sources/AppDelegate.swift
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 150_000;
const FEED_CODE_OUTPUT = 0x40;
const SID = "c7c0d1ea-0000-4000-8000-000000000403";

const CARD = '[data-card-id="A"]';

// ---- Session card -----------------------------------------------------------

const SESSION_TRANSCRIPT = `${CARD} .session-view-slot`;
const SESSION_BAR = `${CARD} [data-slot="session-card-find-bar"]`;
const SESSION_INPUT = `${SESSION_BAR} [data-testid="session-card-find-input"] .cm-content`;

/** Planted once per seeded reply, so a search on it has two matches. */
const PROBE = "quartzite";

// ---- Text card --------------------------------------------------------------

const TEXT_EDITOR = `${CARD} [data-slot="tug-text-card-editor"] .cm-content`;
const TEXT_BAR = `${CARD} [data-slot="text-card-find-bar"]`;
const TEXT_INPUT = `${TEXT_BAR} [data-testid="text-card-find-input"] .cm-content`;
const TEXT_CHIP = `${TEXT_BAR} [data-slot="find-count"] [data-slot="find-count-value"]`;

// Three `meridian` occurrences, one `epsilon`.
const FILE_BODY = [
  "alpha meridian line one",
  "beta line two",
  "gamma meridian line three",
  "delta meridian line four",
  "epsilon closing line",
].join("\n");

let dir = "";
let filePath = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  dir = mkdtempSync(join(tmpdir(), "at0403-"));
  filePath = join(dir, "fixture.txt");
  writeFileSync(filePath, FILE_BODY);
});

afterAll(() => {
  if (dir !== "" && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

function paneOf(componentId: string) {
  return {
    cards: [{ id: "A", componentId, title: "Card A", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 680 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/**
 * Double-click the first on-screen occurrence of `word` under `rootSelector`,
 * which is how a user selects a word — and the only way to get a real DOM
 * selection into the surface the command reads. The point is measured now,
 * not earlier: both surfaces keep settling after their first paint.
 */
async function selectWord(
  app: App,
  rootSelector: string,
  word: string,
): Promise<void> {
  const measured = await app.evalJS<string>(
    `(function(){
      var root = document.querySelector(${JSON.stringify(rootSelector)});
      if (root === null) return "__NO_ROOT__";
      var box = root.getBoundingClientRect();
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      var offscreen = 0;
      while (walker.nextNode() !== null) {
        var node = walker.currentNode;
        var idx = (node.textContent || "").indexOf(${JSON.stringify(word)});
        if (idx < 0) continue;
        var r = document.createRange();
        r.setStart(node, idx);
        r.setEnd(node, idx + ${word.length});
        var cr = r.getBoundingClientRect();
        if (cr.width <= 0 || cr.height <= 0) continue;
        // Inside the surface's own visible box: a row scrolled out of the
        // scrollport still measures, and clicking its coordinates lands on
        // whatever is actually painted there.
        if (cr.top < box.top + 2 || cr.bottom > box.bottom - 2) { offscreen += 1; continue; }
        if (cr.left < box.left + 2 || cr.right > box.right - 2) { offscreen += 1; continue; }
        var x = cr.left + cr.width / 2, y = cr.top + cr.height / 2;
        var hit = document.elementFromPoint(x, y);
        return JSON.stringify({
          x: x,
          y: y,
          hit: hit === null ? "none" : (hit.tagName + "." + String(hit.className)).slice(0, 80),
        });
      }
      return "__NOT_FOUND__ offscreen=" + offscreen;
    })()`,
  );
  if (!measured.startsWith("{")) {
    throw new Error(`could not locate "${word}" in ${rootSelector}: ${measured}`);
  }
  const point = JSON.parse(measured) as { x: number; y: number; hit: string };
  await app.nativeDoubleClick({ x: point.x, y: point.y });
  try {
    await app.waitForCondition<boolean>(
      `(window.getSelection() || { toString: () => "" }).toString().trim() === ${JSON.stringify(word)}`,
      { timeoutMs: 6000 },
    );
  } catch {
    const got = await app.evalJS<string>(
      `String((window.getSelection() || { toString: () => "" }).toString())`,
    );
    throw new Error(
      `double-click at (${point.x}, ${point.y}) over "${word}" [hit ${point.hit}] selected ${JSON.stringify(got)}`,
    );
  }
}

/** The control frame Edit ▸ Find ▸ Use Selection for Find sends. */
async function useSelectionForFind(app: App): Promise<void> {
  await app.evalJS<void>(`window.__tug.dispatchControlAction("find-selection")`);
}

/** Wait until the bar's query field holds exactly `query`. */
async function waitForQuery(
  app: App,
  inputSelector: string,
  query: string,
): Promise<void> {
  await app.waitForCondition<boolean>(
    `(() => {
      const el = document.querySelector(${JSON.stringify(inputSelector)});
      return el !== null && (el.innerText || "").trim() === ${JSON.stringify(query)};
    })()`,
    { timeoutMs: 8000 },
  );
}

const f = (decoded: Record<string, unknown>) => ({
  op: "ingestFrame" as const,
  feedId: FEED_CODE_OUTPUT,
  decoded: { tug_session_id: SID, ...decoded },
});

async function seedSession(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: paneOf("session"), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 15_000 },
  );
  await app.bindSession("A", { tugSessionId: SID });
  await app.waitForCondition<boolean>(
    `document.querySelector('${CARD} [data-slot="session-telemetry-status-row"]') !== null`,
    { timeoutMs: 8000 },
  );

  // Two committed turns. `quartzite` appears in both, `ridge` only in the
  // first — so a re-seed on it changes the count as well as the query, and it
  // sits on the same line as the match the first search scrolled into view.
  for (const [i, tail] of ["ridge", "mesa"].entries()) {
    await app.driveSession("A", { op: "send", text: `ask ${i}` });
    await app.driveSession(
      "A",
      f({
        type: "assistant_text",
        msg_id: `m${i}`,
        text: `${PROBE} ${tail} sits in reply ${i}.`,
        is_partial: false,
        rev: 0,
        seq: 0,
      }),
    );
    await app.driveSession("A", f({ type: "turn_complete", msg_id: `m${i}`, result: "success" }));
  }
  await app.waitForCondition<boolean>(
    `document.querySelectorAll('${CARD} [data-tug-list-cell-index]').length >= 4`,
    { timeoutMs: 10_000 },
  );
}

/** Ranges painted across both transcript find registries. */
async function waitForPainted(app: App, expected: number): Promise<void> {
  await app.waitForCondition<boolean>(
    `(() => {
      let n = 0;
      for (const name of ['transcript-find-match', 'transcript-find-active']) {
        const hl = CSS.highlights.get(name);
        if (hl) for (const _ of hl) n += 1;
      }
      return n === ${expected};
    })()`,
    { timeoutMs: 8000 },
  );
}

/** The text of the single active transcript match, or "". */
function activeMatchTextExpr(): string {
  return `(() => {
    const hl = CSS.highlights.get('transcript-find-active');
    if (!hl) return "";
    for (const r of hl) return r.toString();
    return "";
  })()`;
}

async function mountTextCard(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({
    state: paneOf("text"),
    cardStates: {
      A: { content: { path: filePath, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
    },
    focusCardId: "A",
  });
  await app.waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(TEXT_EDITOR)});
      return el !== null && el.innerText.indexOf("alpha meridian") !== -1;
    })()`,
    { timeoutMs: 15_000 },
  );
}

describe.skipIf(!SHOULD_RUN)("AT0403: use selection for find", () => {
  test(
    "session card: ⌘E summons the bar on the selected word, then re-seeds it in place",
    async () => {
      const app = await launchTugApp({ testName: "at0403-session" });
      try {
        await seedSession(app);

        // Nothing is searching yet — the bar is not mounted until asked for.
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(SESSION_BAR)}) === null`,
          ),
          "the bar is not mounted before ⌘E",
        ).toBe(true);

        // Select a word in the transcript and make it the search.
        await selectWord(app, SESSION_TRANSCRIPT, PROBE);
        await useSelectionForFind(app);

        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SESSION_BAR)}) !== null`,
          { timeoutMs: 6000 },
        );
        await waitForQuery(app, SESSION_INPUT, PROBE);
        // The search RAN: both occurrences are painted and one is active.
        await waitForPainted(app, 2);
        expect(await app.evalJS<string>(activeMatchTextExpr())).toBe(PROBE);
        // The bar took the caret, as it does on ⌘F, and the seeded query is
        // selected whole so the next keystroke replaces it.
        expect(
          await app.evalJS<boolean>(
            `(() => {
              const input = document.querySelector(${JSON.stringify(SESSION_INPUT)});
              return input !== null && document.activeElement !== null &&
                input.contains(document.activeElement) &&
                (window.getSelection() || { toString: () => "" }).toString() === ${JSON.stringify(PROBE)};
            })()`,
          ),
          "the caret lands in the query field with the seed selected whole",
        ).toBe(true);

        // Second ⌘E, bar already open: it RE-SEEDS. A toggle would have
        // dismissed the bar here, which is the whole reason this half exists.
        await selectWord(app, SESSION_TRANSCRIPT, "ridge");
        await useSelectionForFind(app);
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(SESSION_BAR)}) !== null`,
          ),
          "⌘E never dismisses the bar",
        ).toBe(true);
        await waitForQuery(app, SESSION_INPUT, "ridge");
        await waitForPainted(app, 1);
        expect(await app.evalJS<string>(activeMatchTextExpr())).toBe("ridge");
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0403-session] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "text card: ⌘E searches the editor's selection, and re-seeds an open bar",
    async () => {
      const app = await launchTugApp({ testName: "at0403-text" });
      try {
        await mountTextCard(app);

        // A double-click inside the document selects the word AND promotes
        // the editor to first responder — the same click does both.
        await selectWord(app, TEXT_EDITOR, "meridian");
        await useSelectionForFind(app);

        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(TEXT_BAR)}) !== null`,
          { timeoutMs: 6000 },
        );
        await waitForQuery(app, TEXT_INPUT, "meridian");
        // The search ran through CM6: three matches, landed on THE
        // SELECTION ([B04], user-settled 2026-09-21) — the cursor starts at
        // the anchor rather than past it, so ⌘E lands on the very text the
        // double-click selected. `selectWord` takes the first visible
        // occurrence, which is the one on line 1, so the ordinal is still 1.
        await app.waitForCondition<boolean>(
          `(() => {
            const el = document.querySelector(${JSON.stringify(TEXT_CHIP)});
            return el !== null && (el.textContent || '').trim() === "1 of 3";
          })()`,
          { timeoutMs: 8000 },
        );
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll('${CARD} [data-slot="tug-text-card-editor"] .cm-searchMatch-selected').length`,
          ),
          "the first match is selected in the document",
        ).toBeGreaterThanOrEqual(1);

        // Back into the document for a different word, bar still open.
        await selectWord(app, TEXT_EDITOR, "epsilon");
        await useSelectionForFind(app);
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(TEXT_BAR)}) !== null`,
          ),
          "⌘E never dismisses the bar",
        ).toBe(true);
        await waitForQuery(app, TEXT_INPUT, "epsilon");
        await app.waitForCondition<boolean>(
          `(() => {
            const el = document.querySelector(${JSON.stringify(TEXT_CHIP)});
            return el !== null && (el.textContent || '').trim() === "1 of 1";
          })()`,
          { timeoutMs: 8000 },
        );
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0403-text] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
