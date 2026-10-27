/**
 * sc-stack-split.test.ts — the site's Stacks and Splits clip: two cards
 * sharing one slot as a stack, the stack revealed and dismissed, the slot
 * split so both cards show at once, and stacked again.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that frames were written. Run by path, once per mode
 * (`_site-clips.ts` has the invocation); skips unless the runner and both
 * site variables are set.
 *
 * The scene: the site's placeholders (`_placeholders.ts`) in a two-up under
 * Fit at Slim width — two Harbor files stacked in the first slot, a Session
 * card alone in the second — the front card of the stack focused. The
 * burst performs Go ▸ Reveal Stack and dismisses the picker,
 * then ⌃⌘/ twice — once to split the slot, once to stack it again.
 * The capture is cropped to the two slots with a margin.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";

import { SPLIT, columnsRecord } from "../column-split-fixture";
import { placeholderCard, placeholderSettings, placeholderStates, standUpPlaceholders, type Placeholder } from "./_placeholders";
import { RUNS, cropFor, expectRecorded, launchForMode, outDirFor, scene } from "./_site-clips";

const TEST_TIMEOUT_MS = 110_000;
const STACKED = [
  { id: "sc-ss-a", file: "README.md" },
  { id: "sc-ss-b", file: "notes.md" },
] as const satisfies readonly Placeholder[];
const ALONE = { id: "sc-ss-c", session: "pickerKeys" } as const satisfies Placeholder;
const ALL: readonly Placeholder[] = [...STACKED, ALONE];
const FRONT = STACKED[1].id;
const CARD_WIDTH = 675;

/** Rest, the picker's hold, the pause after it closes, the hold split, and the settle stacked. */
const REST_MS = 700;
const PICKER_MS = 1_400;
const PAUSE_MS = 700;
const HOLD_MS = 2_000;
const SETTLE_MS = 1_600;

function pane(id: string, slot: number): Record<string, unknown> {
  return {
    id: `${id}-pane`,
    position: { x: 40, y: 40 },
    size: { width: CARD_WIDTH, height: 480 },
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
    // Array order is z-order: the second stacked card is on top.
    panes: [pane(STACKED[0].id, 0), pane(STACKED[1].id, 0), pane(ALONE.id, 1)],
    activePaneId: `${FRONT}-pane`,
    imposition: { kind: "two-up", layout: "fit", contentWidth: "slim", sidebars: {} },
    hasFocus: true,
  };
}

describe.skipIf(!RUNS)("site clip: stack and split", () => {
  test(
    "records a stack revealed, then split, then stacked again",
    async () => {
      const app = await launchForMode("sc-stack-split", deck(), undefined, {
        cardStates: placeholderStates(ALL),
        settings: placeholderSettings(),
      });
      try {
        // The buried card has no visible body until the split; the two on
        // top stand up now.
        await standUpPlaceholders(app, [STACKED[1], ALONE]);
        await app.dispatchControlAction("focus-pane", { paneId: `${FRONT}-pane` });
        await Bun.sleep(1_000);

        const crop = await cropFor(app, [FRONT, ALONE.id], { pad: 24 });
        const pickerClosed = REST_MS + PICKER_MS;
        const split = pickerClosed + PAUSE_MS;
        const s = scene()
          .mark("loop-start", 0)
          .at(REST_MS, () => app.performMenuItem("go.revealStack"))
          .at(pickerClosed, async () => {
            await app.nativeKey("Escape", []);
            // The picker's dismissal leaves no first responder for the split
            // to resolve against, so the front card takes the keyboard back.
            await app.dispatchControlAction("focus-pane", { paneId: `${FRONT}-pane` });
          })
          // ⌃⌘/, the chord `at0455-column-split-chords` proves: it resolves the
          // slot from the first responder, which the menu row's validation
          // does not see at this moment.
          .at(split, () => app.nativeKey("/", SPLIT))
          .at(split + HOLD_MS / 2, async () => {
            expect((await columnsRecord(app))["0"]?.mode, "the slot split").toBe("split");
          })
          .at(split + HOLD_MS, () => app.nativeKey("/", SPLIT))
          .mark("loop-end", split + HOLD_MS + SETTLE_MS);
        expectRecorded(await s.record(app, { outDir: outDirFor("stack-split"), crop }));
        expect((await columnsRecord(app))["0"]?.mode, "the slot is a stack again").toBe("stack");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
