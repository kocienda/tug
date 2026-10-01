/**
 * at0663-highlight-registry.test.ts — a highlight name is registered only
 * while it has ranges.
 *
 * ## Why this exists
 *
 * `CSS.highlights` is document-global, and WebKit pays for every name in it at
 * every text paint: it resolves a `::highlight()` style per text box per
 * registered name, whether or not that highlight holds a single range. The
 * transcript find pair and the selection guard's `inactive-selection` used to
 * be registered on first use and left there for the life of the page, on the
 * premise that an empty highlight paints nothing and so costs nothing. It paints
 * nothing; it is not free. At the start of a flow slide on a real deck, the
 * per-name resolution was half of all paint samples.
 *
 * So every name follows the rule `filter-mark-painter.ts` already kept: set on
 * the first range, deleted when the last one goes. This pins the registry, not
 * the saving — no duration is asserted, because the app-wide paint cost was
 * never measured and a timing bar on paint is the kind that rotates.
 *
 * ## What it reads
 *
 *   1. At rest — a bound session card with a transcript, no find, no inactive
 *      selection — the registry is EMPTY.
 *   2. With a find active, both find names are registered, they hold the
 *      matches, and the stylesheet has the `::highlight()` rules that paint
 *      them.
 *   3. Escape closes the find, and the registry is empty again.
 *
 * The inactive-selection half is exercised by at0038 and at0037, which read
 * that highlight's ranges across a deactivation and now read them from a name
 * registered on demand.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/transcript-find-highlighter.ts
 * @covers tugdeck/src/components/tugways/selection-guard.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 150_000;
const FEED_CODE_OUTPUT = 0x40;
const SID = "c7c0d1ea-0000-4000-8000-000000000663";

const CARD = '[data-card-id="A"]';
const TRANSCRIPT = `${CARD} .session-view-slot`;
const FIND_BAR = `${CARD} [data-slot="session-card-find-bar"]`;
const FIND_INPUT = `${FIND_BAR} [data-testid="session-card-find-input"] .cm-content`;

const MATCH = "transcript-find-match";
const ACTIVE = "transcript-find-active";

/** Planted once per seeded reply, so a search on it has two matches. */
const PROBE = "quartzite";

const DECK = {
  cards: [{ id: "A", componentId: "session", title: "Card A", closable: true }],
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

const f = (decoded: Record<string, unknown>) => ({
  op: "ingestFrame" as const,
  feedId: FEED_CODE_OUTPUT,
  decoded: { tug_session_id: SID, ...decoded },
});

/** Every registered name and how many ranges it holds. */
interface Registry {
  size: number;
  names: Record<string, number>;
}

const READ_REGISTRY = `(function () {
  var out = { size: CSS.highlights.size, names: {} };
  CSS.highlights.forEach(function (hl, name) { out.names[name] = hl.size; });
  return out;
})()`;

async function readRegistry(app: App): Promise<Registry> {
  return app.evalJS<Registry>(READ_REGISTRY);
}

/** Whether any loaded stylesheet styles `::highlight(<name>)`. */
async function hasHighlightRule(app: App, name: string): Promise<boolean> {
  return app.evalJS<boolean>(
    `(function (needle) {
      for (var s of Array.from(document.styleSheets)) {
        var rules;
        try { rules = s.cssRules; } catch (e) { continue; }
        for (var r of Array.from(rules)) {
          if (r.cssText.indexOf(needle) !== -1) return true;
        }
      }
      return false;
    })(${JSON.stringify(`::highlight(${name})`)})`,
  );
}

async function seedSession(app: App): Promise<void> {
  await app.seedDeckState({ state: DECK, focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 15_000 },
  );
  await app.bindSession("A", { tugSessionId: SID });
  await app.waitForCondition<boolean>(
    `document.querySelector('${CARD} [data-slot="session-telemetry-status-row"]') !== null`,
    { timeoutMs: 8000 },
  );
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

/**
 * Double-click the first visible occurrence of `word` in the transcript — a
 * real selection, which is what Use Selection for Find reads.
 */
async function selectWord(app: App, word: string): Promise<void> {
  const measured = await app.evalJS<string>(
    `(function(){
      var root = document.querySelector(${JSON.stringify(TRANSCRIPT)});
      if (root === null) return "__NO_ROOT__";
      var box = root.getBoundingClientRect();
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode() !== null) {
        var node = walker.currentNode;
        var idx = (node.textContent || "").indexOf(${JSON.stringify(word)});
        if (idx < 0) continue;
        var r = document.createRange();
        r.setStart(node, idx);
        r.setEnd(node, idx + ${word.length});
        var cr = r.getBoundingClientRect();
        if (cr.width <= 0 || cr.height <= 0) continue;
        if (cr.top < box.top + 2 || cr.bottom > box.bottom - 2) continue;
        if (cr.left < box.left + 2 || cr.right > box.right - 2) continue;
        return JSON.stringify({ x: cr.left + cr.width / 2, y: cr.top + cr.height / 2 });
      }
      return "__NOT_FOUND__";
    })()`,
  );
  if (!measured.startsWith("{")) {
    throw new Error(`could not locate "${word}" in the transcript: ${measured}`);
  }
  const point = JSON.parse(measured) as { x: number; y: number };
  await app.nativeDoubleClick(point);
  await app.waitForCondition<boolean>(
    `(window.getSelection() || { toString: () => "" }).toString().trim() === ${JSON.stringify(word)}`,
    { timeoutMs: 6000 },
  );
}

describe.skipIf(!SHOULD_RUN)("AT0663: the highlight registry holds only names with ranges", () => {
  test(
    "empty at rest, the find pair while a find is up, empty again when it closes",
    async () => {
      const app = await launchTugApp({ testName: "at0663-highlight-registry" });
      try {
        await seedSession(app);

        // ---- 1. At rest.
        const rest = await readRegistry(app);
        note(`at rest: ${JSON.stringify(rest)}`);
        expect(rest.names, "no name is registered with nothing to paint").toEqual({});
        expect(rest.size, "the registry is empty at rest").toBe(0);

        // ---- 2. A find, through Use Selection for Find.
        await selectWord(app, PROBE);
        await app.evalJS<void>(`window.__tug.dispatchControlAction("find-selection")`);
        await app.waitForCondition<boolean>(
          `(() => {
            const el = document.querySelector(${JSON.stringify(FIND_INPUT)});
            return el !== null && (el.innerText || "").trim() === ${JSON.stringify(PROBE)};
          })()`,
          { timeoutMs: 8000 },
        );
        await app.waitForCondition<boolean>(
          `(() => {
            const m = CSS.highlights.get(${JSON.stringify(MATCH)});
            const a = CSS.highlights.get(${JSON.stringify(ACTIVE)});
            return m !== undefined && a !== undefined && m.size + a.size === 2;
          })()`,
          { timeoutMs: 8000 },
        );
        const finding = await readRegistry(app);
        note(`find active: ${JSON.stringify(finding)}`);
        expect(finding.names[MATCH], "the other match is registered under the match name").toBe(1);
        expect(finding.names[ACTIVE], "the active match is registered under the active name").toBe(1);
        expect(
          await app.evalJS<string>(
            `(() => { for (const r of CSS.highlights.get(${JSON.stringify(ACTIVE)})) return r.toString(); return ""; })()`,
          ),
          "the active range is the query",
        ).toBe(PROBE);
        expect(await hasHighlightRule(app, MATCH), "a rule paints the match name").toBe(true);
        expect(await hasHighlightRule(app, ACTIVE), "a rule paints the active name").toBe(true);

        // ---- 3. Escape closes the find, and the names go with their ranges.
        await app.nativeKey("Escape");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FIND_BAR)}) === null`,
          { timeoutMs: 8000 },
        );
        await app.waitForCondition<boolean>(
          `!CSS.highlights.has(${JSON.stringify(MATCH)}) && !CSS.highlights.has(${JSON.stringify(ACTIVE)})`,
          { timeoutMs: 8000 },
        );
        const closed = await readRegistry(app);
        note(`find closed: ${JSON.stringify(closed)}`);
        expect(closed.names, "closing the find unregisters its names").toEqual({});
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0663] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
