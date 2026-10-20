/**
 * at0746-tab-switch-shows-its-own-tab.test.ts — a tab switch between two
 * Session cards that draw their own chrome never shows one card's content
 * under the other card's tab.
 *
 * Each card's page draws the chrome it shows in front: its own tab lit, its
 * own title. The card behind is placed at the pane and hidden by opacity, so
 * it has already painted exactly what the switch reveals, and the switch is
 * the host trading which view is opaque. The reading stands two Session
 * cards in one pane, switches the tab under a burst, and tells on every frame
 * which card's content shows (by its content box against each card's own
 * standing content) and which tab is lit (by the active tab's colour): the
 * two must name the same card.
 *
 * @foreground
 * @covers tugdeck/src/lib/pane-chrome-projection.ts
 * @covers tugdeck/src/body/body-chrome-frame.tsx
 * @covers tugapp/Sources/BodyViewController.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "./streaming-stub-fixture";
import { fillOnRow, near, pollFor, regionDiffShare } from "./body-grounding/_frames";
import {
  BODY_READY_MS,
  COLOUR_TOLERANCE,
  armBurst,
  cardAtRest,
  readBurst,
  rectIn,
  sessionPaneDeck,
  spawnWithTranscript,
  still,
  viewOf,
  type Rect,
} from "./one-view-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const A = "at0746-a";
const B = "at0746-b";

describe.skipIf(!SHOULD_RUN)("at0746: a tab switch shows its own tab", () => {
  test(
    "no frame of a tab switch shows one card's content under the other card's tab",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({ testName: "at0746-tabs", foreground: true, env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir } });
      try {
        await app.seedDeckState({ state: sessionPaneDeck([A, B]), focusCardId: A });
        await spawnWithTranscript(app, stubDir, A);
        const placed = await pollFor(() => viewOf(app, A), (v) => v !== null, BODY_READY_MS);
        expect(placed, "the front card's view is placed visible").not.toBeNull();
        const a = await cardAtRest(app, A);
        // The sibling's page stands behind, painted and placed at the pane.
        const sibling = await pollFor(
          async () => (await app.bodies()).find((s) => s.cardId === B) ?? null,
          (s) => s !== null && s.painted,
          BODY_READY_MS,
        );
        expect(sibling?.painted, "the sibling's page has painted behind the front card").toBe(true);
        await Bun.sleep(200);
        const v = (await viewOf(app, A))!;
        // Each page lays its own chrome out: the front card's masthead stands
        // over its tab row, and the unbound sibling wears none, so each card's
        // tabs are read in its own page.
        const b = app.body(B);
        const tabsIn = async (page: typeof a): Promise<{ a: Rect; b: Rect }> => ({
          a: (await rectIn(page, `[data-testid="tug-tab-${A}"]`))!,
          b: (await rectIn(page, `[data-testid="tug-tab-${B}"]`))!,
        });
        const onA = await tabsIn(a);
        const onB = await tabsIn(b);
        const content = (await rectIn(a, ".tug-pane-content"))!;
        expect(onA.a !== null && onA.b !== null && onB.a !== null && onB.b !== null, "both pages draw both tabs").toBe(true);
        const crop = { x: Math.floor(v.x), y: Math.floor(v.y), width: Math.floor(v.width), height: Math.floor(v.height) };
        const standing = await still(app, crop);
        const scale = standing.scale;
        // Near the tab's top: the unbound sibling's session picker is a sheet
        // whose panel rises over the lower half of its tab row.
        const tabRow = (t: Rect): number => (v.y + t.y + 5 - crop.y) * scale;
        const tabSpan = (t: Rect): [number, number] => [(v.x + t.x + 6 - crop.x) * scale, (v.x + t.x + t.width - 6 - crop.x) * scale];
        const lit = fillOnRow(standing.frame, tabRow(onA.a), ...tabSpan(onA.a));
        const unlit = fillOnRow(standing.frame, tabRow(onA.b), ...tabSpan(onA.b));
        // A tab is lit by the active tab's tint: blue over the bar's grey. A
        // sheet's scrim over a tab row darkens both tabs alike, so a page's
        // lit tab is the one of its pair that is the more tinted.
        const tint = (f: typeof standing.frame, t: Rect): number => {
          const c = fillOnRow(f, tabRow(t), ...tabSpan(t));
          return c.b - (c.r + c.g) / 2;
        };
        const litOf = (f: typeof standing.frame, own: Rect, other: Rect): boolean => tint(f, own) > tint(f, other) + 3;
        note(`active tab ${JSON.stringify(lit)}; inactive tab ${JSON.stringify(unlit)}; front page's tabs ${JSON.stringify(onA)}; sibling's ${JSON.stringify(onB)}`);
        expect(near(lit, unlit, COLOUR_TOLERANCE), "the active tab is told from the other by colour").toBe(false);
        const contentBox = {
          x: (v.x + content.x + 8 - crop.x) * scale,
          y: (v.y + content.y + 8 - crop.y) * scale,
          width: (content.width - 16) * scale,
          height: (content.height - 16) * scale,
        };

        await armBurst(app, crop);
        const switchWall = Date.now();
        await a.nativeClickAtElement(`[data-testid="tug-tab-${B}"]`);
        const reading = await readBurst(app);
        const final = reading.frames[reading.frames.length - 1];
        if (!litOf(final, onB.b, onB.a)) {
          const at = (t: Rect) => fillOnRow(final, tabRow(t), ...tabSpan(t));
          const tabs = await b.evalJS<unknown>(`[...document.querySelectorAll('.tug-tab')].map(function (t) { return [t.getAttribute('data-testid'), t.getAttribute('data-active')]; })`);
          const focus = await b.evalJS<unknown>(`(function () { var f = document.querySelector('.body-chrome-frame'); return f && f.getAttribute('data-focused'); })()`);
          // card-dom: shell
          const responder = { pane: await app.evalJS<unknown>(`window.tugdeck.diag.getDeckState().activePaneId ?? null`), host: (await app.bodies()).map((s) => [s.cardId, s.firstResponder]) };
          note(`the final frame at the sibling's tabs: ${JSON.stringify(at(onB.a))} ${JSON.stringify(at(onB.b))}; at the front page's: ${JSON.stringify(at(onA.a))} ${JSON.stringify(at(onA.b))}; the sibling page's tabs ${JSON.stringify(tabs)}; its frame focused ${JSON.stringify(focus)}; the deck's first responder ${JSON.stringify(responder)}`);
        }
        expect(litOf(final, onB.b, onB.a), "the switch landed: the sibling's page shows with its own tab lit, the other not").toBe(true);
        const apart = regionDiffShare(standing.frame, final, contentBox);
        note(`the two cards' content boxes differ on ${(apart * 100).toFixed(1)}% of their pixels`);
        expect(apart, "the two cards' contents are told apart").toBeGreaterThan(0.05);

        let mismatched = 0;
        let read = 0;
        for (const f of reading.frames) {
          if (f.wall < switchWall) continue;
          const fromA = regionDiffShare(f, standing.frame, contentBox);
          const fromB = regionDiffShare(f, final, contentBox);
          const isA = fromA < 0.02 && fromB > apart / 2;
          const isB = fromB < 0.02 && fromA > apart / 2;
          if (!isA && !isB) continue;
          read += 1;
          // The card showing must show its own tab lit and the other's not.
          const own = isA ? onA.a : onB.b;
          const other = isA ? onA.b : onB.a;
          if (!litOf(f, own, other)) {
            mismatched += 1;
            note(`${Math.round(f.t)}ms shows ${isA ? "the front card" : "the sibling"} without its own tab lit alone`);
          }
        }
        note(`${read} frames read for which card shows; ${mismatched} mismatched`);
        expect(read, "frames were read across the switch").toBeGreaterThan(5);
        expect(mismatched, "no frame shows one card's content under the other card's tab").toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
