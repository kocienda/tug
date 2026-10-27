/**
 * sc-card-address.test.ts — the site's Card Addresses clip: one slot read
 * close, so the badges in its title bars can be read as they change — the
 * slot number alone, then the count of a stack, then the letters of a split.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that frames were written. Run by path, once per mode
 * (`_site-clips.ts` has the invocation); skips unless the runner and both
 * site variables are set.
 *
 * The scene: a two-up under Fit at Slim width, two file cards stacked in the
 * first slot and one alone in the second, the front card of the stack
 * focused. The burst rests on the stack, whose front card reads slot 1 and
 * a count of 2; presses ⌃⌘/ so the slot splits and every
 * member reads slot 1 and its own letter, A at the top; holds; and presses
 * ⌃⌘/ again to stack them. The capture is cropped to the first slot with a
 * margin, so the chips are legible at the width the page gives the clip.
 *
 * The cards are the site's placeholders (`_placeholders.ts`), files of the
 * Harbor project at their true size. A Text card stands no shorter than
 * 400px, so the window is tall enough that each half of the split clears
 * that floor; two cards share the slot rather than three for the same reason,
 * and the two are the shortest files, so neither scrolls in its half.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";

import { SPLIT, columnsRecord } from "../column-split-fixture";
import { placeholderCard, placeholderSettings, placeholderStates, standUpPlaceholders, type Placeholder } from "./_placeholders";
import { RUNS, cropFor, expectRecorded, launchForMode, outDirFor, scene } from "./_site-clips";

const TEST_TIMEOUT_MS = 110_000;
const STACKED = [
  { id: "sc-ca-a", file: "README.md" },
  { id: "sc-ca-b", file: "notes.md" },
] as const satisfies readonly Placeholder[];
const ALONE = { id: "sc-ca-c", file: "tides.ts" } as const satisfies Placeholder;
const ALL: readonly Placeholder[] = [...STACKED, ALONE];
const FRONT = STACKED[1].id;
/** The Slim width, and a height the deck clamps to the band. */
const CARD_WIDTH = 675;
const CARD_HEIGHT = 900;
/** Two Slim cards wide, and tall enough for two Text cards one above the other. */
const WINDOW = { width: 1460, height: 900 };

/** Rest on the stack, the hold split, and the settle stacked again. */
const REST_MS = 1_400;
const HOLD_MS = 2_800;
const SETTLE_MS = 1_800;

function pane(id: string, slot: number): Record<string, unknown> {
  return {
    id: `${id}-pane`,
    position: { x: 40, y: 40 },
    size: { width: CARD_WIDTH, height: CARD_HEIGHT },
    cardIds: [id],
    activeCardId: id,
    title: "",
    acceptsFamilies: ["standard"],
    slot,
  };
}

function deck(): Record<string, unknown> {
  return {
    cards: ALL.map(placeholderCard),
    // Array order is z-order: the last stacked card is in front.
    panes: [...STACKED.map((p) => pane(p.id, 0)), pane(ALONE.id, 1)],
    activePaneId: `${FRONT}-pane`,
    imposition: { kind: "two-up", layout: "fit", contentWidth: "slim", sidebars: {} },
    hasFocus: true,
  };
}

describe.skipIf(!RUNS)("site clip: card address", () => {
  test(
    "records one slot's badges through stack, split and stack again",
    async () => {
      const app = await launchForMode("sc-card-address", deck(), undefined, {
        contentSize: WINDOW,
        cardStates: placeholderStates(ALL),
        settings: placeholderSettings(),
      });
      try {
        // The buried cards have no visible body until the split; the front
        // card and the lone card stand up now.
        await standUpPlaceholders(app, [STACKED[1], ALONE]);
        await app.dispatchControlAction("focus-pane", { paneId: `${FRONT}-pane` });
        await Bun.sleep(1_200);

        const crop = await cropFor(app, [FRONT], { pad: 24 });
        const s = scene()
          .mark("loop-start", 0)
          // ⌃⌘/ resolves the slot from the first responder, which the front
          // card holds; see `sc-stack-split` for why the menu row is not used.
          .at(REST_MS, () => app.nativeKey("/", SPLIT))
          .at(REST_MS + HOLD_MS / 2, async () => {
            expect((await columnsRecord(app))["0"]?.mode, "the slot split").toBe("split");
          })
          .at(REST_MS + HOLD_MS, () => app.nativeKey("/", SPLIT))
          .mark("loop-end", REST_MS + HOLD_MS + SETTLE_MS);
        expectRecorded(await s.record(app, { outDir: outDirFor("card-address"), crop }));
        expect((await columnsRecord(app))["0"]?.mode, "the slot is a stack again").toBe("stack");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
