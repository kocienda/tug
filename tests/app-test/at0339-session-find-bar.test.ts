/**
 * at0339-session-find-bar.test.ts — transcript find is a ⌘F bar above Z2
 * ([AT0339]).
 *
 * ## Why this exists
 *
 * Find used to be a *submission*: `!find <query>` ran through the composer's
 * submit path, which is why it needed a dissolve-on-next-submit rule and an
 * Escape-when-empty rule living inside the prompt entry. Those are gone
 * ([D122]); the bar owns the search for exactly as long as it is open. This
 * suite drives the door, not the engine — match correctness is at0271's job.
 *
 * ## Test matrix
 *
 *   1. ⌘F opens the bar with the caret in the query field; typing a term
 *      paints both matches and actives one of them.
 *   2. ⌘G advances and ⇧⌘G retreats, from the query field — and Return /
 *      ⇧Return do the same, but only while the caret is IN the field: back in
 *      the composer Return is submit again. The keys follow the caret.
 *   3. ⌘F toggles, from the composer AND from inside the bar. The second is
 *      the load-bearing half: ⌘F lands the caret in the query field, so the
 *      second press of any real toggle attempt comes from inside the bar.
 *   4. Escape closes the bar and dissolves the highlights; ⌘G while closed is
 *      inert (nothing repaints).
 *   5. A second ⌘F reopens with the previous query pre-filled AND fully
 *      selected — the standard macOS behavior that makes clear-on-close
 *      painless.
 *   6. Find and Changes are mutually exclusive: ⌃⌘C with the bar open raises
 *      the Changes shade and dismisses the bar, and ⌘F leaves Changes again.
 *   7. The bar's controls are stops in the CARD's one focus cycle, at the
 *      orders its position on screen implies (after the Z4 toolbar, before
 *      the Z2 cells) — not a walk of their own. `Tab` out of an EMPTY field
 *      enters that cycle at the field's own seat and steps, so an empty
 *      composer and an empty query field both move the keyboard along the
 *      order ⌥⇥ already walks.
 *   8. Dismissing the bar while the keyboard is on one of its controls hands
 *      the caret back to the composer.
 *   9. The empty-Tab rule with the bar CLOSED — the ordinary card. Tab and
 *      ⇧Tab in an empty composer enter the cycle from either side; a
 *      non-empty composer takes Tab back and indents.
 *
 * A second test covers what the bar owes the rest of the focus language, which
 * the door-opening test above says nothing about:
 *
 *  10. **Arrows leave the query field.** The bar's stops live in the card's
 *      trapped cycle, which the document keyboard pipeline cannot walk — so
 *      without the host's arrow handoff a released arrow has nowhere to go and
 *      the field becomes a dead end for the keyboard. Down and Up out of an
 *      empty query field must both move the ring OUT of the bar.
 *  11. **One lit default button.** With the bar open the deck shows two entry
 *      shells, each with a Return button, and only the one holding the caret
 *      may read as live. The composer's submit gives up its fill when the caret
 *      is in the query field and takes it back when the caret returns.
 *  12. **The query field is an editor like any other** — same font size as the
 *      composer, which it only gets by inheriting the card's editor settings.
 *
 * @covers tugdeck/src/components/tugways/tug-find-bar.tsx
 * @covers tugdeck/src/components/tugways/tug-entry-shell.css
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 * @covers tugdeck/src/components/tugways/keybinding-map.ts
 * @covers tugdeck/src/lib/commit-mode-controller.ts
 * @covers tugdeck/src/components/tugways/use-cycle-mode.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;
const FEED_CODE_OUTPUT = 0x40;
const SID = "c7c0d1ea-0000-4000-8000-000000000339";

/** A term planted twice in the seeded turn, so a search has two matches. */
const PROBE = "findbarprobe";

const CARD = '[data-card-id="A"]';
// Scoped to the prompt entry deliberately: once the bar is open the card holds
// TWO `tug-text-editor`s, and the bar's comes first in DOM order — an unscoped
// selector silently retargets every "click the composer" step at the query
// field, which makes a ⌘F-from-outside-the-bar assertion test nothing.
const EDITOR = `${CARD} [data-slot="tug-prompt-entry"] [data-slot="tug-text-editor"] .cm-content`;
const FIND_BAR = `${CARD} [data-slot="session-card-find-bar"]`;
const FIND_INPUT = `${FIND_BAR} [data-testid="session-card-find-input"] .cm-content`;
const STATUS_BAR = `${CARD} [data-slot="session-card-status-bar"]`;
const VIEW_SLOT = `${CARD} .session-view-slot`;

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
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

const f = (decoded: Record<string, unknown>) => ({
  op: "ingestFrame" as const,
  feedId: FEED_CODE_OUTPUT,
  decoded: { tug_session_id: SID, ...decoded },
});

/** Synthetic chord at the active element — a posted ⌘ chord can be eaten by
 *  macOS before it reaches the WebView (the at0088 / at0221 precedent). */
async function chord(
  app: App,
  code: string,
  key: string,
  mods: { meta?: boolean; shift?: boolean; ctrl?: boolean; alt?: boolean } = {},
): Promise<void> {
  // All four flags are spelled: `chordMatchesEvent` matches exactly, so an
  // undeclared modifier dispatches as false and the chord reaches nothing.
  await app.evalJS<boolean>(
    `(function(){
      var t = document.activeElement || document;
      return t.dispatchEvent(new KeyboardEvent("keydown", {
        code: ${JSON.stringify(code)},
        key: ${JSON.stringify(key)},
        metaKey: ${mods.meta === true},
        shiftKey: ${mods.shift === true},
        ctrlKey: ${mods.ctrl === true},
        altKey: ${mods.alt === true},
        bubbles: true,
        cancelable: true,
        composed: true,
      }));
    })()`,
  );
}

/** Total painted ranges across both find highlight registries. */
async function paintedCount(app: App): Promise<number> {
  return app.evalJS<number>(
    `(() => {
      let n = 0;
      for (const name of ['transcript-find-match', 'transcript-find-active']) {
        const hl = CSS.highlights.get(name);
        if (hl) for (const _ of hl) n += 1;
      }
      return n;
    })()`,
  );
}

async function waitForPaintedCount(app: App, expected: number): Promise<void> {
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

/** The text of the single active match, or "" when nothing is active. */
async function activeMatchText(app: App): Promise<string> {
  return app.evalJS<string>(
    `(() => {
      const hl = CSS.highlights.get('transcript-find-active');
      if (!hl) return "";
      for (const r of hl) return r.toString();
      return "";
    })()`,
  );
}

/** Which transcript row (list cell index) holds the active match. */
async function activeMatchRow(app: App): Promise<number> {
  return app.evalJS<number>(
    `(() => {
      const hl = CSS.highlights.get('transcript-find-active');
      if (!hl) return -1;
      for (const r of hl) {
        const el = r.startContainer.parentElement;
        const cell = el ? el.closest('[data-tug-list-cell-index]') : null;
        return cell ? Number(cell.getAttribute('data-tug-list-cell-index')) : -1;
      }
      return -1;
    })()`,
  );
}

/** List-cell index of the active match, or -1 — the expression form, for
 *  waits that need it inline. */
const activeRowExpr = `(() => {
  const hl = CSS.highlights.get('transcript-find-active');
  if (!hl) return -1;
  for (const r of hl) {
    const el = r.startContainer.parentElement;
    const cell = el ? el.closest('[data-tug-list-cell-index]') : null;
    return cell ? Number(cell.getAttribute('data-tug-list-cell-index')) : -1;
  }
  return -1;
})()`;

// The card's ONE focus cycle and the orders the find bar occupies in it. The
// bar is not a walk of its own: its controls sit between the Z4 toolbar
// (0…7) and the Z2 status cells (12…), which is where the bar sits on screen.
const CYCLE_GROUP = "session-prompt-cycle";
const FIND_ORDER_QUERY = 8;
const FIND_ORDER_OPTIONS = 9;
const FIND_ORDER_PREVIOUS = 10;
const FIND_ORDER_NEXT = 11;
const EDITOR_ORDER = 19;

/** Backspaces `clearComposer` presses — comfortably over the longest string
 *  this suite types into the composer. */
const COMPOSER_CLEAR_KEYSTROKES = 20;

/** The authored `group:order` of whatever currently holds the keyboard. */
const FOCUS_KEY_EXPR = `(document.querySelector("[data-key-view]")?.getAttribute("data-tug-focus-key") || "")`;

const queryFieldHasCaret = `(() => {
  const input = document.querySelector(${JSON.stringify(FIND_INPUT)});
  return input !== null && document.activeElement !== null &&
    (input.contains(document.activeElement) || input === document.activeElement);
})()`;

/** Empty the composer, whatever it holds. */
/**
 * Empty the composer with plain Backspaces rather than ⌘A. ⌘A is a
 * chain-routed action and does not reliably reach this editor from a headless
 * gesture (the at0287 chain-first-responder limit); Backspace is a bare key
 * the focused substrate always gets, and an extra one on an empty doc is a
 * no-op — so a bounded run is deterministic where the chord is not.
 */
async function clearComposer(app: App): Promise<void> {
  await app.nativeClickAtElement(EDITOR);
  await new Promise((r) => setTimeout(r, 200));
  for (let i = 0; i < COMPOSER_CLEAR_KEYSTROKES; i++) {
    await app.nativeKey("Backspace");
  }
  // The entry root's `data-empty` bridge is the designed emptiness probe —
  // an empty editor still renders placeholder text into `textContent`.
  // The entry root's `data-empty` bridge is the designed emptiness probe — an
  // empty editor still renders placeholder text into `textContent`.
  await app.waitForCondition<boolean>(
    `document.querySelector('${CARD} [data-slot="tug-prompt-entry"]')?.getAttribute("data-empty") === "true"`,
    { timeoutMs: 4000 },
  );
}

async function seedSession(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 15_000 },
  );
  await app.bindSession("A", { tugSessionId: SID });
  await app.waitForCondition<boolean>(
    `document.querySelector('${CARD} [data-slot="session-telemetry-status-row"]') !== null`,
    { timeoutMs: 8000 },
  );

  // Two committed turns, each carrying one occurrence of the probe.
  for (const [i, tail] of ["alpha", "omega"].entries()) {
    await app.driveSession("A", { op: "send", text: `ask ${i}` });
    await app.driveSession("A", f({
      type: "assistant_text",
      msg_id: `m${i}`,
      text: `${PROBE} ${tail} sits in reply ${i}.`,
      is_partial: false,
      rev: 0,
      seq: 0,
    }));
    await app.driveSession("A", f({
      type: "turn_complete",
      msg_id: `m${i}`,
      result: "success",
    }));
  }
  await app.waitForCondition<boolean>(
    `document.querySelectorAll('${CARD} [data-tug-list-cell-index]').length >= 4`,
    { timeoutMs: 10_000 },
  );
}

describe.skipIf(!SHOULD_RUN)("AT0339: the ⌘F transcript find bar", () => {
  test(
    "⌘F toggles, ⌘G cycles, Escape closes and clears, a reopen resumes the query, and Changes excludes it",
    async () => {
      const app = await launchTugApp({ testName: "at0339-session-find-bar" });
      try {
        await seedSession(app);

        // The bar is not mounted until asked for.
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(FIND_BAR)}) === null`,
          ),
          "the find bar starts closed",
        ).toBe(true);

        // --- 1. ⌘F opens it with the caret in the query field. ---
        await app.nativeClickAtElement(EDITOR);
        await chord(app, "KeyF", "f", { meta: true });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FIND_BAR)}) !== null`,
          { timeoutMs: 8000 },
        );
        await app.waitForCondition<boolean>(queryFieldHasCaret, {
          timeoutMs: 8000,
        });

        // It docks between the transcript view slot and Z2 — the [D97]
        // geometry: below the slot's bottom edge, above the status bar.
        const geometry = await app.evalJS<{
          slotBottom: number;
          barTop: number;
          barBottom: number;
          statusTop: number;
        } | null>(
          `(function(){
            var slot = document.querySelector(${JSON.stringify(VIEW_SLOT)});
            var bar = document.querySelector(${JSON.stringify(FIND_BAR)});
            var status = document.querySelector(${JSON.stringify(STATUS_BAR)});
            if (!slot || !bar || !status) return null;
            return {
              slotBottom: slot.getBoundingClientRect().bottom,
              barTop: bar.getBoundingClientRect().top,
              barBottom: bar.getBoundingClientRect().bottom,
              statusTop: status.getBoundingClientRect().top,
            };
          })()`,
        );
        expect(geometry).not.toBeNull();
        expect(geometry!.barTop).toBeGreaterThanOrEqual(geometry!.slotBottom - 1);
        expect(geometry!.barBottom).toBeLessThanOrEqual(geometry!.statusTop + 1);

        // Typing paints both matches, one of them active.
        await app.nativeType(PROBE);
        await waitForPaintedCount(app, 2);
        expect(await activeMatchText(app)).toBe(PROBE);
        const firstRow = await activeMatchRow(app);
        expect(firstRow).toBeGreaterThanOrEqual(0);

        // --- 2. ⌘G advances, ⇧⌘G retreats — from the query field. ---
        await chord(app, "KeyG", "g", { meta: true });
        await app.waitForCondition<boolean>(
          `(() => {
            const hl = CSS.highlights.get('transcript-find-active');
            if (!hl) return false;
            for (const r of hl) {
              const el = r.startContainer.parentElement;
              const cell = el ? el.closest('[data-tug-list-cell-index]') : null;
              return cell !== null &&
                Number(cell.getAttribute('data-tug-list-cell-index')) !== ${firstRow};
            }
            return false;
          })()`,
          { timeoutMs: 6000 },
        );
        await chord(app, "KeyG", "g", { meta: true, shift: true });
        await app.waitForCondition<boolean>(
          `(() => {
            const hl = CSS.highlights.get('transcript-find-active');
            if (!hl) return false;
            for (const r of hl) {
              const el = r.startContainer.parentElement;
              const cell = el ? el.closest('[data-tug-list-cell-index]') : null;
              return cell !== null &&
                Number(cell.getAttribute('data-tug-list-cell-index')) === ${firstRow};
            }
            return false;
          })()`,
          { timeoutMs: 6000 },
        );

        // --- 2b. Return follows the caret. In the query field it is the ↓
        //         button's twin and advances the match; back in the composer
        //         it is submit again and the match does not move. ---
        await app.nativeKey("Enter");
        await app.waitForCondition<boolean>(
          `${activeRowExpr} !== ${firstRow}`,
          { timeoutMs: 6000 },
        );
        await app.nativeKey("Enter", ["shift"]);
        await app.waitForCondition<boolean>(
          `${activeRowExpr} === ${firstRow}`,
          { timeoutMs: 6000 },
        );

        await app.nativeClickAtElement(EDITOR);
        await app.nativeType("not a search");
        await app.nativeKey("Enter");
        await new Promise((r) => setTimeout(r, 800));
        expect(
          await activeMatchRow(app),
          "Return in the composer submits; it must not walk the search",
        ).toBe(firstRow);
        await app.nativeClickAtElement(FIND_INPUT);
        await app.waitForCondition<boolean>(queryFieldHasCaret, {
          timeoutMs: 8000,
        });

        // --- 3. ⌘F toggles, INCLUDING from inside the bar. ⌘F lands the caret
        //        in the query field, so the second press is always "from
        //        inside" — a toggle that declined to fire there would be
        //        unreachable by the gesture everyone actually makes. ---
        await chord(app, "KeyF", "f", { meta: true });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FIND_BAR)}) === null`,
          { timeoutMs: 8000 },
        );
        await waitForPaintedCount(app, 0);

        // …and from the composer too, both directions.
        await app.nativeClickAtElement(EDITOR);
        await chord(app, "KeyF", "f", { meta: true });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FIND_BAR)}) !== null`,
          { timeoutMs: 8000 },
        );
        await app.nativeClickAtElement(EDITOR);
        await chord(app, "KeyF", "f", { meta: true });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FIND_BAR)}) === null`,
          { timeoutMs: 8000 },
        );

        // --- 4. Escape closes and dissolves; ⌘G while closed is inert. ---
        await app.nativeClickAtElement(EDITOR);
        await chord(app, "KeyF", "f", { meta: true });
        await app.waitForCondition<boolean>(queryFieldHasCaret, {
          timeoutMs: 8000,
        });
        await waitForPaintedCount(app, 2);
        await app.nativeKey("Escape");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FIND_BAR)}) === null`,
          { timeoutMs: 8000 },
        );
        await waitForPaintedCount(app, 0);

        await chord(app, "KeyG", "g", { meta: true });
        await new Promise((r) => setTimeout(r, 600));
        expect(
          await paintedCount(app),
          "⌘G with the bar closed must repaint nothing",
        ).toBe(0);

        // --- 5. A second ⌘F resumes the query, pre-filled and selected. ---
        await app.nativeClickAtElement(EDITOR);
        await chord(app, "KeyF", "f", { meta: true });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FIND_BAR)}) !== null`,
          { timeoutMs: 8000 },
        );
        await app.waitForCondition<boolean>(queryFieldHasCaret, {
          timeoutMs: 8000,
        });
        expect(
          (
            await app.evalJS<string>(
              `(document.querySelector(${JSON.stringify(FIND_INPUT)})?.textContent || "").trim()`,
            )
          ),
          "the remembered query is pre-filled",
        ).toBe(PROBE);
        // Selected whole, so the next keystroke replaces it.
        expect(
          await app.evalJS<string>(
            `(window.getSelection()?.toString() || "")`,
          ),
          "the pre-filled query is fully selected",
        ).toBe(PROBE);
        await waitForPaintedCount(app, 2);

        // --- 6. Find and Changes are mutually exclusive — one at a time. ---
        await app.nativeClickAtElement(EDITOR);
        await chord(app, "KeyC", "c", { meta: true, ctrl: true });
        await app.waitForCondition<boolean>(
          `document.querySelector('${CARD} .session-view-slot[data-active-view="changes"]') !== null`,
          { timeoutMs: 8000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FIND_BAR)}) === null`,
          { timeoutMs: 8000 },
        );

        // …and back the other way: ⌘F leaves Changes.
        await chord(app, "KeyF", "f", { meta: true });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FIND_BAR)}) !== null`,
          { timeoutMs: 8000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector('${CARD} .session-view-slot[data-active-view="changes"]') === null`,
          { timeoutMs: 8000 },
        );

        // --- 7. The bar's controls are stops in the CARD's one cycle, in the
        //        card's own reading order — between the Z4 toolbar and the Z2
        //        status cells, which is where the bar physically sits. The
        //        door into that walk from a caret is ⌥⇥ ([P07]/[P09]): a Tab
        //        in a CM6 caret belongs to the editor, empty or not — the
        //        emptiness-conditioned handoff is one of the three ambient
        //        mechanisms the mode division deleted. ---
        await app.waitForCondition<boolean>(queryFieldHasCaret, {
          timeoutMs: 8000,
        });
        // The reopen seeded the remembered query SELECTED, but clear it
        // explicitly — an empty field is what makes Tab a movement key.
        await app.nativeKey("a", ["cmd"]);
        await app.nativeKey("Backspace");
        // An empty CM6 doc renders its placeholder widget, so the placeholder's
        // presence is the emptiness probe — `textContent` would read the
        // placeholder's own text and never be "".
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FIND_INPUT)} + " .cm-placeholder") !== null`,
          { timeoutMs: 4000 },
        );

        // The bar's stops are a contiguous run INSIDE the card's one group,
        // sitting between the Z4 toolbar and the editor text stop — exactly
        // the seat its position on screen implies. (The Z2 telemetry cells
        // are authored stops too but stamp no `data-tug-focus-key`, so they
        // are absent from this registry read and asserted by slot below.)
        //
        // Orders 2 and 3 — the Session and Project chips — are absent on the
        // transcript route by design: both names already read in the pane
        // title bar, so the Z4B diet dropped them from the strip. The run is
        // a seat allocation, not a dense sequence; the chips keep their
        // numbers for the routes that still render them.
        expect(
          await app.evalJS<string>(
            `Array.from(document.querySelectorAll('${CARD} [data-tug-focus-key]'))
               .map(e => e.getAttribute('data-tug-focus-key'))
               .filter(k => k.indexOf(${JSON.stringify(`${CYCLE_GROUP}:`)}) === 0)
               .map(k => Number(k.split(':')[1]))
               .sort((a, b) => a - b).join(",")`,
          ),
          "the find bar's four stops occupy 8…11 in the card's cycle group",
          // 12 is the minimize control at the leading edge of Z2 ([B03]) —
          // one below the five cells, which moved up to 13…17 to seat it, and
          // deliberately NOT the find bar's 11: the bar it replaced existed
          // only while minimized, and this control stands in both forms.
          // 4 and 6 are gaps by design: slot 4 is the off-code-route chip
          // (Cwd / Changes, never mounted on the code route this fixture
          // seeds) and slot 6's Effort chip merged into the AI chip in the
          // Z4B diet. The constants keep their places — the grid describes
          // the SHAPE of the toolbar row — and the walk skips what is not
          // mounted.
        ).toBe(`0,1,5,7,8,9,10,11,12,${EDITOR_ORDER}`);

        // ⌥⇥ engages the cycle AT the query field's own seat — entering keeps
        // the key view where the keyboard already is, and the landing is a
        // MOVEMENT, so the field's stop parks: ring, no caret ([P12]).
        await app.nativeKey("Tab", ["alt"]);
        await app.waitForCondition<boolean>(
          `${FOCUS_KEY_EXPR} === ${JSON.stringify(`${CYCLE_GROUP}:${FIND_ORDER_QUERY}`)}`,
          { timeoutMs: 6000 },
        );

        for (const order of [
          FIND_ORDER_OPTIONS,
          FIND_ORDER_PREVIOUS,
          FIND_ORDER_NEXT,
        ]) {
          await app.nativeKey("Tab");
          await app.waitForCondition<boolean>(
            `${FOCUS_KEY_EXPR} === ${JSON.stringify(`${CYCLE_GROUP}:${order}`)}`,
            { timeoutMs: 6000 },
          );
        }

        // Past the bar's last stop the walk carries straight on into the Z2
        // row — its minimize control first ([B03]), then the status cells.
        // This is the assertion that separates "participates in the card's
        // order" from "has an order of its own": a private walk would have
        // wrapped back to the query field here.
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-key-view]')?.closest('[data-slot="session-minimize-control"]') !== null`,
          { timeoutMs: 6000 },
        );
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-key-view]')?.getAttribute('data-slot') === "tug-status-cell"`,
          { timeoutMs: 6000 },
        );

        // ⇧Tab walks back into the bar the same way — not a one-way door.
        await app.nativeKey("Tab", ["shift"]);
        await app.nativeKey("Tab", ["shift"]);
        await app.waitForCondition<boolean>(
          `${FOCUS_KEY_EXPR} === ${JSON.stringify(`${CYCLE_GROUP}:${FIND_ORDER_NEXT}`)}`,
          { timeoutMs: 6000 },
        );

        // --- 7b. A text stop the walk ARRIVES at is PARKED — ring, no caret
        //         ([P12]). Walking back to the query field must NOT hand the
        //         field the caret (that is the grant's job: Return, Escape, or
        //         a printable), so the next Tab still belongs to the walk and
        //         moves on rather than falling through to `indentWithTab` and
        //         typing a tab character into the query. ---
        await app.nativeKey("Tab", ["shift"]);
        await app.nativeKey("Tab", ["shift"]);
        await app.nativeKey("Tab", ["shift"]);
        await app.waitForCondition<boolean>(
          `${FOCUS_KEY_EXPR} === ${JSON.stringify(`${CYCLE_GROUP}:${FIND_ORDER_QUERY}`)}`,
          { timeoutMs: 6000 },
        );
        expect(
          await app.evalJS<boolean>(queryFieldHasCaret),
          "a walked-to text stop parks — the ring, not the caret",
        ).toBe(false);
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(
          `${FOCUS_KEY_EXPR} === ${JSON.stringify(`${CYCLE_GROUP}:${FIND_ORDER_OPTIONS}`)}`,
          { timeoutMs: 6000 },
        );
        // …and nothing was typed on the way out: the placeholder still stands,
        // which it would not if a tab character had landed in the doc.
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(FIND_INPUT)} + " .cm-placeholder") !== null`,
          ),
          "Tab out of a tabbed-into query field moves without typing into it",
        ).toBe(true);

        // Park the ring back on the bar for the dismissal below.
        await app.nativeKey("Tab");
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(
          `${FOCUS_KEY_EXPR} === ${JSON.stringify(`${CYCLE_GROUP}:${FIND_ORDER_NEXT}`)}`,
          { timeoutMs: 6000 },
        );

        // --- 8. Dismissing while the keyboard is on a find control hands the
        //        caret back to the composer — a surface that goes away owes
        //        the keyboard somewhere to land. ⌘F is the dismissal here
        //        because Escape at a cycle stop belongs to the cycle (it
        //        ascends out of it), which is the language working, not a gap.
        await chord(app, "KeyF", "f", { meta: true });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FIND_BAR)}) === null`,
          { timeoutMs: 8000 },
        );
        await app.waitForCondition<boolean>(
          `(() => {
            const el = document.querySelector(${JSON.stringify(EDITOR)});
            return el !== null && el.contains(document.activeElement);
          })()`,
          { timeoutMs: 8000 },
        );

        // --- 9. The same doors with the bar CLOSED, in the ordinary card. A
        //        Tab in the composer's caret belongs to the composer, empty or
        //        not — the emptiness-conditioned handoff is deleted. ⌥⇥ is the
        //        door: it engages the cycle AT the editor's own stop, which
        //        parks ([P12] movement), and Escape at that parked text stop
        //        grants the caret straight back rather than leaving the
        //        keyboard nowhere. ---
        await clearComposer(app);
        await app.nativeKey("Tab");
        await new Promise((r) => setTimeout(r, 400));
        expect(
          await app.evalJS<boolean>(
            `(() => {
              const el = document.querySelector(${JSON.stringify(EDITOR)});
              return el !== null && el.contains(document.activeElement);
            })()`,
          ),
          "Tab in an empty composer caret stays with the composer",
        ).toBe(true);
        await app.nativeKey("Tab", ["alt"]);
        await app.waitForCondition<boolean>(
          `${FOCUS_KEY_EXPR} === ${JSON.stringify(`${CYCLE_GROUP}:${EDITOR_ORDER}`)}`,
          { timeoutMs: 6000 },
        );
        // Escape at the parked editor stop grants the caret back where the
        // ring stands — no detour through a resting-focus default.
        await app.nativeKey("Escape");
        await app.waitForCondition<boolean>(
          `(() => {
            const el = document.querySelector(${JSON.stringify(EDITOR)});
            return el !== null && el.contains(document.activeElement);
          })()`,
          { timeoutMs: 8000 },
        );

        // A NON-empty composer keeps Tab for itself — the field takes the key
        // back the moment there is something to indent. If Tab had moved the
        // keyboard the entry would have stood down and DOM focus would sit on
        // a stop or the key sink, so "the caret is still here" is the whole
        // assertion.
        await app.nativeClickAtElement(EDITOR);
        await app.nativeType("x");
        await new Promise((r) => setTimeout(r, 200));
        await app.nativeKey("Tab");
        await new Promise((r) => setTimeout(r, 600));
        expect(
          await app.evalJS<boolean>(
            `(() => {
              const el = document.querySelector(${JSON.stringify(EDITOR)});
              return el !== null && el.contains(document.activeElement);
            })()`,
          ),
          "Tab in a non-empty composer indents; it must not move the keyboard",
        ).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "arrows stay in the query field's caret, one default button is lit, and the query is an editor like the composer",
    async () => {
      const app = await launchTugApp({ testName: "at0339-find-bar-language" });
      try {
        await seedSession(app);

        await app.nativeClickAtElement(EDITOR);
        await chord(app, "KeyF", "f", { meta: true });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FIND_BAR)}) !== null`,
          { timeoutMs: 8000 },
        );
        await app.waitForCondition<boolean>(queryFieldHasCaret, {
          timeoutMs: 8000,
        });

        // --- 12. The query field inherits the card's editor settings. It docks
        //         outside the composer's pane, so a font bound to that pane
        //         never reached it and it silently rendered at the substrate's
        //         own default beside a composer the user had set smaller. ---
        const fontSizes = await app.evalJS<{ find: string; composer: string } | null>(
          `(function(){
            var find = document.querySelector(${JSON.stringify(FIND_INPUT)});
            var composer = document.querySelector(${JSON.stringify(EDITOR)});
            if (!find || !composer) return null;
            return {
              find: getComputedStyle(find).fontSize,
              composer: getComputedStyle(composer).fontSize,
            };
          })()`,
        );
        expect(fontSizes).not.toBeNull();
        expect(
          fontSizes!.find,
          "the find field renders at the composer's editor font size",
        ).toBe(fontSizes!.composer);

        // --- 11. Exactly one lit default button. Return follows the caret —
        //         in the query field it is Find Next, in the composer it is
        //         Submit — so the fill has to follow it too. Read by
        //         background colour, which the filled → outlined stand-down
        //         changes and which (unlike the ring outline) does not go quiet
        //         in a background window. ---
        //         The lit/dim decision reads the ENGINE's `[data-key-view]`
        //         mark rather than `:focus-within`, so wait for that mark
        //         rather than for `document.activeElement`: ⌘F's imperative
        //         focus claim reaches the engine through `focusin`, one turn
        //         later than the DOM focus it asserts.
        const keyViewIn = (host: string) =>
          `(() => {
            const kv = document.querySelector('${CARD} [data-key-view]');
            const host = document.querySelector(${JSON.stringify(host)});
            return kv !== null && host !== null && host.contains(kv);
          })()`;
        //         Read by the RING, not by the fill: the fill is transitioned,
        //         so a snapshot taken the moment the mark moves catches both
        //         buttons mid-interpolation and neither value is either
        //         endpoint. The default ring is not animated.
        const ringed = (host: string, label: string) =>
          `(() => {
            const el = document.querySelector('${host} ${label}');
            if (el === null) return false;
            const s = getComputedStyle(el);
            return s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
          })()`;
        const SUBMIT = ".tug-prompt-entry-submit-button";
        const NEXT = '[aria-label="Find next"]';

        await app.waitForCondition<boolean>(keyViewIn(FIND_BAR), {
          timeoutMs: 8000,
        });
        await app.waitForCondition<boolean>(ringed(FIND_BAR, NEXT), {
          timeoutMs: 6000,
        });
        expect(
          await app.evalJS<boolean>(ringed(CARD, SUBMIT)),
          "with the keyboard in the query field, only Find Next carries the default ring",
        ).toBe(false);

        // Back to the composer and the two swap roles.
        await app.nativeClickAtElement(EDITOR);
        await app.waitForCondition<boolean>(
          keyViewIn(`${CARD} [data-slot="tug-prompt-entry"]`),
          { timeoutMs: 8000 },
        );
        await app.waitForCondition<boolean>(ringed(CARD, SUBMIT), {
          timeoutMs: 6000,
        });
        expect(
          await app.evalJS<boolean>(ringed(FIND_BAR, NEXT)),
          "the keyboard left the query field, so Find Next gives up the ring",
        ).toBe(false);

        // --- 10. Arrows STAY in the query field, empty or not ([KBF] mode
        //         division). The old arrow-release policy — an empty field's
        //         first discrete arrow press walked the keyboard out — was one
        //         of the three ambient mechanisms the mode division deleted:
        //         mode OFF, a caret owns all four arrows unconditionally, and
        //         the way out of the field is ⌥⇥ (park) or Tab (the walk),
        //         never a bare arrow.
        for (const direction of ["Down", "Up"] as const) {
          await app.nativeClickAtElement(FIND_INPUT);
          await app.waitForCondition<boolean>(queryFieldHasCaret, {
            timeoutMs: 8000,
          });
          // Empty — the exact state the deleted policy keyed on.
          await app.nativeKey("a", ["cmd"]);
          await app.nativeKey("Backspace");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(FIND_INPUT)} + " .cm-placeholder") !== null`,
            { timeoutMs: 4000 },
          );

          await app.nativeKey(`Arrow${direction}`);
          // Give a would-be walk a beat to move, then assert nothing did.
          await new Promise((r) => setTimeout(r, 400));
          expect(
            await app.evalJS<boolean>(queryFieldHasCaret),
            `${direction} in an empty query field keeps the caret — a caret owns its arrows`,
          ).toBe(true);
          expect(
            await app.evalJS<boolean>(
              `document.documentElement.hasAttribute("data-kbf")`,
            ),
            "a bare arrow in a caret never engages keyboard-focus mode",
          ).toBe(false);
        }
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
