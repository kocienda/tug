/**
 * at0223-text-card-find-bar.test.ts — the Text card's bottom-docked find
 * bar ([AT0223]).
 *
 * ## Why this exists
 *
 * The Text card's find bar is the Dev entry's find face on the shared
 * `TugEntryShell`: a CM6 substrate query field above a toolbar whose
 * centred slot holds the shared Case/Word/Grep cluster + count badge and
 * whose trailing slot holds the Z5 pair (outlined ↑ / filled ↓) — no route
 * popup, no status row, no ✕. The engine is the editor's own CodeMirror
 * search (virtualization-proof). ⌘F summons it, Escape dismisses, and the
 * option toggles persist through the GLOBAL find-options preference
 * (`dev.tugapp.find`/`options`).
 *
 * ## Test matrix (one card over a real temp file)
 *
 *   1. ⌘F opens the bar BELOW the editor (DOM order: editor → bar → status
 *      bar) with the shell anatomy (toolbar, cluster, Z5 pair; no route
 *      trigger, no ✕); typing into the focused CM6 field paints matches and
 *      the badge reads "1 of 3"; Enter advances, Shift-Enter retreats, the
 *      filled ↓ button advances; toggling Case narrows the count live;
 *      Escape closes the bar and clears the decorations.
 *   2. The Case toggle survives into a fresh bar (global persistence).
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/cards/text-card-find-bar.tsx
 * @covers tugdeck/src/components/tugways/cards/text-card.tsx
 * @covers tugdeck/src/lib/find-surface.ts
 * @covers tugdeck/src/lib/text-match.ts
 * @covers tugdeck/src/components/tugways/tug-find-cluster.tsx
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.css
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp, type App } from "./_harness";
import { ROUTE_CHOICE } from "./_harness/selectors";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

let dir = "";
let filePath = "";

// Three `meridian` occurrences; exactly one is capital-M.
const FILE_BODY = [
  "alpha meridian line one",
  "beta line two",
  "gamma Meridian line three",
  "delta meridian line four",
  "epsilon closing line",
].join("\n");

beforeAll(() => {
  if (!SHOULD_RUN) return;
  dir = mkdtempSync(join(tmpdir(), "at0223-"));
  filePath = join(dir, "fixture.txt");
  writeFileSync(filePath, FILE_BODY);
});

afterAll(() => {
  if (dir !== "" && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "text", title: "File", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 30, y: 30 },
        size: { width: 780, height: 560 },
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

const EDITOR_CONTENT_SELECTOR =
  '[data-card-id="A"] [data-slot="tug-text-card-editor"] .cm-content';
const BAR_SELECTOR = '[data-card-id="A"] [data-slot="text-card-find-bar"]';
// The query field is a CM6 substrate — clicks / typing land in its content.
const INPUT_SELECTOR = `${BAR_SELECTOR} [data-testid="text-card-find-input"] .cm-content`;
const CHIP_SELECTOR = `${BAR_SELECTOR} [data-slot="find-count"] [data-slot="find-count-value"]`;

async function mountTextCard(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({
    state: deckShape(),
    cardStates: {
      A: { content: { path: filePath, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
    },
    focusCardId: "A",
  });
  await app.waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(EDITOR_CONTENT_SELECTOR)});
      return el !== null && el.innerText.indexOf("alpha meridian") !== -1;
    })()`,
    { timeoutMs: 15_000 },
  );
}

async function openBar(app: App): Promise<void> {
  // ⌘F rides the responder chain — focus the editor, then dispatch the
  // chord synthetically (the keybinding matcher keys on code+modifiers).
  await app.nativeClickAtElement(EDITOR_CONTENT_SELECTOR);
  await app.evalJS<boolean>(
    `(function(){
      var target = document.activeElement || document;
      return target.dispatchEvent(new KeyboardEvent("keydown", {
        code: "KeyF", key: "f", metaKey: true,
        bubbles: true, cancelable: true, composed: true,
      }));
    })()`,
  );
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(BAR_SELECTOR)}) !== null`,
    { timeoutMs: 4000 },
  );
  // The bar focuses its CM6 field on mount — wait for the caret so typed
  // queries land in the field, not the document editor. A text surface is a
  // dom-granted target, so `document.activeElement` IS the truth here; the
  // engine grants it real focus rather than parking the sink.
  await app.waitForCondition<boolean>(
    `(() => {
      const input = document.querySelector(${JSON.stringify(INPUT_SELECTOR)});
      return input !== null && document.activeElement !== null &&
        (input.contains(document.activeElement) || input === document.activeElement);
    })()`,
    { timeoutMs: 4000 },
  );
}

async function waitForChip(app: App, expected: string): Promise<void> {
  await app.waitForCondition<boolean>(
    `(() => {
      const el = document.querySelector(${JSON.stringify(CHIP_SELECTOR)});
      return el !== null && (el.textContent || '').trim() === ${JSON.stringify(expected)};
    })()`,
    { timeoutMs: 6000 },
  );
}

describe.skipIf(!SHOULD_RUN)("AT0223: text card bottom find bar", () => {
  test(
    "⌘F opens the bottom bar; query counts, navigates, narrows on Case, closes on Escape",
    async () => {
      const app = await launchTugApp({ testName: "at0223-bar" });
      try {
        await mountTextCard(app);
        await openBar(app);

        // Placement: the bar sits BETWEEN the editor and the status bar.
        const order = await app.evalJS<boolean>(
          `(() => {
            const bar = document.querySelector(${JSON.stringify(BAR_SELECTOR)});
            const editor = document.querySelector('[data-card-id="A"] [data-slot="tug-text-card-editor"]');
            const status = document.querySelector('[data-card-id="A"] .text-card-status-bar');
            if (!bar || !editor || !status) return false;
            return Boolean(
              (editor.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING) &&
              (bar.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING)
            );
          })()`,
        );
        expect(order, "bar must dock between the editor and the status bar").toBe(true);

        // Anatomy: the shell toolbar with the cluster and the Z5 pair —
        // and neither a route trigger nor a ✕ (the bar is the Dev entry's
        // find face minus Z4A/Z2; Escape is the dismiss gesture).
        const anatomy = JSON.parse(
          await app.evalJS<string>(
            `(() => {
              const bar = document.querySelector(${JSON.stringify(BAR_SELECTOR)});
              return JSON.stringify({
                shell: bar !== null && bar.classList.contains('tug-entry-shell'),
                toolbar: bar?.querySelector('.tug-entry-shell-toolbar') !== null,
                cluster: bar?.querySelector('[data-slot="find-cluster"]') !== null,
                prev: bar?.querySelector('button[aria-label="Find previous"]') !== null,
                next: bar?.querySelector('button[aria-label="Find next"]') !== null,
                route: bar?.querySelector(${JSON.stringify(ROUTE_CHOICE)}) !== null,
                close: bar?.querySelector('button[aria-label="Close find"]') !== null,
              });
            })()`,
          ),
        ) as Record<string, boolean>;
        expect(anatomy.shell, "bar root must be the entry shell").toBe(true);
        expect(anatomy.toolbar).toBe(true);
        expect(anatomy.cluster).toBe(true);
        expect(anatomy.prev).toBe(true);
        expect(anatomy.next).toBe(true);
        expect(anatomy.route, "no Z4A route trigger in the find bar").toBe(false);
        expect(anatomy.close, "no ✕ — Escape dismisses").toBe(false);

        // Query: three case-insensitive hits, first active. The bar focused
        // its CM6 field on mount, so typing lands there directly.
        await app.nativeType("meridian");
        await waitForChip(app, "1 of 3");
        const decorated = await app.evalJS<number>(
          `document.querySelectorAll('[data-card-id="A"] .cm-searchMatch').length`,
        );
        expect(decorated).toBeGreaterThanOrEqual(3);
        // The count badge is visibly painted (not just present in the DOM).
        const badgeVisible = await app.evalJS<boolean>(
          `(() => {
            const badge = document.querySelector(${JSON.stringify(BAR_SELECTOR)} + ' [data-slot="find-count"]');
            if (!badge) return false;
            const cs = getComputedStyle(badge);
            return cs.visibility === 'visible' && badge.getBoundingClientRect().width > 0;
          })()`,
        );
        expect(badgeVisible, "count badge must be visibly painted").toBe(true);
        // Search-as-you-type SELECTED the first match (the document editor
        // wears .cm-searchMatch-selected without any Enter press).
        const selected = await app.evalJS<number>(
          `document.querySelectorAll('[data-card-id="A"] [data-slot="tug-text-card-editor"] .cm-searchMatch-selected').length`,
        );
        expect(selected, "typing must land on the first match").toBeGreaterThanOrEqual(1);

        // Enter advances from the typed-landing first match to the second.
        await app.nativeKey("Return");
        await waitForChip(app, "2 of 3");
        // Shift-Enter retreats…
        await app.nativeKey("Return", ["shift"]);
        await waitForChip(app, "1 of 3");
        // …and the filled ↓ button advances (the pointer twin).
        await app.click(`${BAR_SELECTOR} button[aria-label="Find next"]`);
        await waitForChip(app, "2 of 3");

        // Case toggle narrows to the two lowercase hits, live — and the
        // toggles ride the shared cluster.
        //
        // The ordinal is 2, not 1: an options toggle is a gesture, and a
        // gesture lands where the READER is ([B04], user-settled
        // 2026-09-21). The steps above left the active match on the
        // capital-M hit on line 3, so the anchor is there and the nearest
        // lowercase hit at or after it is line 4's — the last of the two.
        // Narrowing to two matches is what this assertion is about, and
        // that is unchanged.
        await app.click(`${BAR_SELECTOR} button[aria-label="Match case"]`);
        await waitForChip(app, "2 of 2");

        // Wrapping past the last match raises the SHARED wrap indicator —
        // the same `FindSession`-driven overlay the Session card shows (the two
        // surfaces ride one controller, so the affordance cannot diverge).
        await app.nativeKey("Return");
        // The panel portals into the canvas overlay root (it centres on the
        // card but lives at deck level), so the probe is document-wide.
        await app.waitForCondition<boolean>(
          `document.querySelector('.tugx-find-wrap') !== null`,
          { timeoutMs: 5000 },
        );
        await waitForChip(app, "1 of 2");

        // ⌥⇥ from the query caret engages KBF at the field's own stop — the
        // stop PARKS (ring, no caret) — and Escape at that parked text stop
        // grants the caret straight back into the query field ([P12]): the
        // ring says "you are here", Escape says "stop steering". The bar
        // stays open — the grant consumed the Escape before the field's own
        // Escape-closes keymap could see it.
        await app.nativeKey("Tab", ["alt"]);
        await app.waitForCondition<boolean>(
          `(() => {
            const input = document.querySelector(${JSON.stringify(INPUT_SELECTOR)});
            return input !== null && !input.contains(document.activeElement) &&
              document.documentElement.hasAttribute("data-kbf");
          })()`,
          { timeoutMs: 6000 },
        );
        await app.nativeKey("Escape");
        await app.waitForCondition<boolean>(
          `(() => {
            const input = document.querySelector(${JSON.stringify(INPUT_SELECTOR)});
            return input !== null && document.activeElement !== null &&
              input.contains(document.activeElement) &&
              !document.documentElement.hasAttribute("data-kbf");
          })()`,
          { timeoutMs: 6000 },
        );
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(BAR_SELECTOR)}) !== null`,
          ),
          "the grant consumed the Escape — the bar survives it",
        ).toBe(true);

        // Escape closes the bar and clears the decorations.
        await app.nativeClickAtElement(INPUT_SELECTOR);
        await app.nativeKey("Escape");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(BAR_SELECTOR)}) === null`,
          { timeoutMs: 4000 },
        );
        const remaining = await app.evalJS<number>(
          `document.querySelectorAll('[data-card-id="A"] .cm-searchMatch').length`,
        );
        expect(remaining).toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the Case toggle persists into a freshly opened bar (global find options)",
    async () => {
      const app = await launchTugApp({ testName: "at0223-persist" });
      try {
        await mountTextCard(app);
        await openBar(app);
        // Seed: turn Case ON (persists via putFindOptions).
        await app.click(`${BAR_SELECTOR} button[aria-label="Match case"]`);
        await app.waitForCondition<boolean>(
          `(() => {
            const btn = document.querySelector(${JSON.stringify(BAR_SELECTOR)} + ' button[aria-label="Match case"]');
            return btn !== null && btn.getAttribute('aria-pressed') === 'true';
          })()`,
          { timeoutMs: 4000 },
        );
        // Close and reopen: the fresh bar seeds from the persisted options.
        await app.nativeClickAtElement(INPUT_SELECTOR);
        await app.nativeKey("Escape");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(BAR_SELECTOR)}) === null`,
          { timeoutMs: 4000 },
        );
        await openBar(app);
        const pressed = await app.evalJS<string>(
          `(() => {
            const btn = document.querySelector(${JSON.stringify(BAR_SELECTOR)} + ' button[aria-label="Match case"]');
            return btn ? String(btn.getAttribute('aria-pressed')) : 'absent';
          })()`,
        );
        expect(pressed).toBe("true");
        // And the case-sensitive count reflects it immediately.
        await app.nativeType("meridian");
        await waitForChip(app, "1 of 2");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
